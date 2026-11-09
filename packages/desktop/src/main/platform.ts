/**
 * P24 平台发布 RPA 主进程实现（抖音 / 小红书 / 视频号）。
 *
 * 全部用 Electron 内建能力，不新增任何 npm 依赖：
 * - 登录态：BrowserWindow + webPreferences.partition = 'persist:platform-<id>'
 * - 传素材：webContents.debugger (CDP 1.3) DOM.setFileInputFiles
 * - 填文本：Runtime.evaluate 聚焦 + Input.insertText，失败用 execCommand('insertText') 兜底
 * - 每一步失败都截图到 <userDataDir>/platform-logs/
 *
 * 说明：本机没有登录过的平台账号，页面结构未真机校准；选择器全部走候选数组，
 * 未命中时抛带「选择器未命中」的中文错误，并按步骤落截图方便后续校准。
 */

import { BrowserWindow, session } from 'electron'
import type { Session } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import {
  COMMENT_TEXT_MAX,
  DRIVERS,
  PLATFORMS,
  buildContent,
  clampTitle,
  clickReplyScript,
  feedListScript,
  replyOutcomeScript,
  scanCommentsScript,
  selectFeedScript,
  type PlatformDriver,
  type PlatformId
} from './platform-drivers'

export interface PlatformManagerDeps {
  userDataDir: string
  log?: (msg: string) => void
  onEvent?: (e: { platform: string; type: string; message: string; at: string }) => void
}

export interface PlatformStatus {
  platform: string
  name: string
  loggedIn: boolean
  nickname?: string
  checkedAt: string
  error?: string
}

/** P25：作品数据页快照（原文交给模型读，不做字段映射） */
export interface PlatformStatsSnapshot {
  platform: string
  name: string
  ok: boolean
  loggedIn: boolean
  pageTitle: string
  href: string
  text: string
  screenshots: string[]
  message: string
}

/** P32：一条评论（index 是本次扫描顺序，仅用于定位，跨次抓取会变） */
export interface PlatformCommentItem {
  index: number
  text: string
}

/** P32：评论列表快照 */
export interface PlatformCommentsSnapshot {
  platform: string
  name: string
  ok: boolean
  loggedIn: boolean
  pageTitle: string
  href: string
  selector: string
  items: PlatformCommentItem[]
  screenshots: string[]
  message: string
}

/** P32：回复一条评论的结果 */
export interface PlatformReplyResult {
  platform: string
  ok: boolean
  message: string
  target?: string
  screenshots: string[]
  steps: PublishStep[]
}

export interface PublishInput {
  platform: PlatformId
  type: 'video' | 'image'
  title?: string
  content: string
  tags?: string[]
  mediaPaths: string[]
  scheduledAt?: string
}

export interface PublishStep {
  step: string
  ok: boolean
  detail?: string
}

export interface PublishResult {
  platform: string
  ok: boolean
  message: string
  url?: string
  screenshots: string[]
  steps: PublishStep[]
}

const NAV_TIMEOUT_MS = 30000
const LOGIN_TIMEOUT_MS = 180000
const LOGIN_POLL_MS = 3000
const UPLOAD_TIMEOUT_MS = 120000
const UPLOAD_POLL_MS = 2000
const POST_PUBLISH_WAIT_MS = 5000
// 点完「发布图文 / 发布视频」tab 后等页面换掉上传器
const TAB_SWITCH_WAIT_MS = 3000
const TAB_SWITCH_ATTEMPTS = 20
const TAB_SWITCH_POLL_MS = 1500
// 编辑页表单是异步渲染的：等到「上传完成」再立刻填标题/正文会扑空，所以先等元素出现
const FIELD_WAIT_ATTEMPTS = 14
const FIELD_WAIT_POLL_MS = 1500
// 点完发布后轮询结果：只看「5 秒后页面地址变了」会误判成功（抖音点完还停在编辑页），
// 因此必须等到成功提示或跳转到作品管理页才算发出去
// 抖音点发布后有一段「发文助手检测中」，检测没跑完时点发布会被静默忽略（真机：30 秒后仍停在编辑页、
// 页面无任何报错，几分钟后再点就成功了）⇒ 窗口放长，并且在等待期间补点几次
/** P32 评论：左侧作品列表最多枚举几条（视频号必须先点作品才有评论） */
const COMMENT_FEED_MAX = 8
/** P32 评论：点完作品后等右侧评论渲染的时间 */
const COMMENT_FEED_WAIT_MS = 2200
const PUBLISH_RESULT_TIMEOUT_MS = 120000
const PUBLISH_RESULT_POLL_MS = 2000
const PUBLISH_RETRY_CLICK_MS = 25000
/** 单次页面取值（CDP eval）最长等待，避免 webContents 卡死时整条链路挂住 */
const EVAL_TIMEOUT_MS = 20000
/** navigate 轮询里每次页面取值的上限：页面未 commit 时 executeJavaScript 会挂着不返回 */
const NAV_EVAL_WAIT_MS = 2000
/** 「打开后台」最多等多久，超时也不报错（窗口已经开着，用户能自己看） */
const OPEN_DEBUG_TIMEOUT_MS = 20000

/** 登录态缓存时长：切换页面回来不该重跑一次十几秒的检查（用户实测反馈：等完刷新再切页又得等） */
export const STATUS_CACHE_MS = 5 * 60 * 1000

/**
 * 平台页面允许的协议。别的一律拦掉：
 * 抖音/小红书页面上有「打开客户端」这类自定义协议（snssdk:// xhsdiscover:// …），
 * Chromium 遇到未知协议会走系统外部协议处理，Windows 就弹出「在 Microsoft Store 中查找应用」的系统弹窗
 * （用户实测反馈：一直弹「没有下载」的商店提示）。
 */
const ALLOWED_SCHEME = /^(https?|wss?|data|blob|about|chrome-extension|devtools|file):/i

/**
 * 平台站点会屏蔽 Electron 默认 UA（默认 UA 里带 "Electron/38.8.6"）：
 * 小红书创作者中心直接 ERR_FAILED / ERR_TIMED_OUT 打不开，视频号会跳到 login.html。
 * 这里把平台窗口的 UA 换成同版本 Chrome，其它浏览器特征保持 Electron 默认。
 */
const PLATFORM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' +
  process.versions.chrome.split('.')[0] +
  '.0.0.0 Safari/537.36'

/** 判断页面是否已经可以操作：DOM 解析完成且已离开 about:blank */
const READY_SCRIPT =
  '(() => ({ ready: document.readyState !== "loading", href: location.href, bodyLen: document.body ? document.body.innerText.length : -1 }))()'

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function nowIso() {
  return new Date().toISOString()
}

function errText(e: unknown) {
  return e instanceof Error ? e.message : String(e)
}

function safeName(raw: string) {
  return raw.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'step'
}

// 页面里判断元素「可见」的公共片段
const VISIBLE_FN =
  'const __visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); ' +
  'if (r.width <= 0 || r.height <= 0) return false; const st = window.getComputedStyle(el); ' +
  'return st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0"; };'

/**
 * 生成「按候选选择器找元素并执行 action」的页面脚本。
 * 候选有两种写法：
 * - 普通 CSS 选择器（如 '.semi-input'），只取第一个可见元素
 * - 'text=发布'，按 textContent 包含匹配（等价 :has-text，Electron 没有该伪类），取最后一个命中
 */
function locateScript(selectors: string[], action: string) {
  return (
    '(() => {' +
    VISIBLE_FN +
    ' const sels = ' + JSON.stringify(selectors) + ';' +
    // 真机（2026-11-09 视频号）：表单/按钮可能整体在微前端 shadowRoot 里，直接查询命中 0 个元素；
    // 先查 document，查不到再逐层走进 shadowRoot 兜底（只在没命中时才付这个代价）。
    ' const all = (sel) => {' +
    '   let hits = [];' +
    '   try { hits = Array.from(document.querySelectorAll(sel)); } catch (e) { hits = []; }' +
    '   if (hits.length) return hits;' +
    '   const out = [];' +
    '   const walk = (root) => {' +
    '     let kids = [];' +
    '     try { kids = Array.from(root.querySelectorAll("*")); } catch (e) { kids = []; }' +
    '     for (const el of kids) {' +
    '       if (!el.shadowRoot) continue;' +
    '       try { for (const h of Array.from(el.shadowRoot.querySelectorAll(sel))) out.push(h); } catch (e) {}' +
    '       walk(el.shadowRoot);' +
    '     }' +
    '   };' +
    '   walk(document);' +
    '   return out;' +
    ' };' +
    ' const textOf = (el) => (el && el.textContent ? el.textContent : "").replace(/\\s+/g, "");' +
    ' for (const sel of sels) {' +
    '   let el = null;' +
    '   if (sel.indexOf("text=") === 0) {' +
    '     const want = sel.slice(5).trim();' +
    '     const items = all("button, a, div, span, p").filter(__visible);' +
    '     const exact = items.filter((e) => textOf(e) === want);' +
    '     const loose = items.filter((e) => textOf(e).indexOf(want) >= 0);' +
    '     const hits = exact.length ? exact : loose;' +
    '     el = hits.length ? hits[hits.length - 1] : null;' +
    '   } else {' +
    '     const hits = all(sel).filter(__visible);' +
    '     el = hits.length ? hits[0] : null;' +
    '   }' +
    '   if (!el) continue;' +
    '   try { ' + action + ' } catch (e) { return { ok: false, selector: sel, error: String((e && e.message) || e) }; }' +
    '   return { ok: true, selector: sel };' +
    ' }' +
    ' return { ok: false };' +
    '})()'
  )
}

/**
 * 页面「深文本」：document.body.innerText + 所有 shadowRoot 里的可见文本。
 * 真机（2026-11-09 视频号）：评论管理/数据中心是 wujie 微前端，整个子应用挂在 <wujie-app> 的
 * shadowRoot 里，body.innerText 永远只有「视频号 · 助手」，登录态与取数都会误判。
 */
const DEEP_TEXT_FN =
  ' const __deepText = () => {' +
  '   const parts = [];' +
  '   if (document.body) { const t0 = document.body.innerText || ""; if (t0) parts.push(t0); }' +
  // ShadowRoot 不可 clone（真机报 NotSupportedError: ShadowRoot nodes are not clonable），
  // 所以只能逐个元素取叶子文本：跳过 style/script，元素没有子元素才算叶子。
  '   const collect = (root) => {' +
  '     let kids = [];' +
  '     try { kids = Array.from(root.querySelectorAll("*")); } catch (e) { kids = []; }' +
  '     for (const el of kids) {' +
  '       const tag = el.tagName || "";' +
  '       if (tag === "STYLE" || tag === "SCRIPT" || tag === "NOSCRIPT" || tag === "TEMPLATE") continue;' +
  '       if (!el.querySelector("*")) { const t = (el.textContent || "").trim(); if (t) parts.push(t); }' +
  '       if (el.shadowRoot) { try { collect(el.shadowRoot); } catch (e) {} }' +
  '     }' +
  '   };' +
  '   collect(document);' +
  '   return parts.join("\\n");' +
  ' };'

// 判断登录态的页面探针：URL + cookie + 页面文案 + 二维码元素
const PROBE_SCRIPT =
  '(() => {' +
  DEEP_TEXT_FN +
  ' const text = __deepText();' +
  ' const href = location.href;' +
  ' const cookies = document.cookie || "";' +
  ' const words = ["扫码登录", "登录后查看", "请先登录", "未登录", "立即登录", "登录/注册", "登录创作服务平台"];' +
  ' const loginWord = words.some((w) => text.indexOf(w) >= 0);' +
  ' const qr = !!document.querySelector("img[src*=\\"qrcode\\"], .qrcode, [class*=\\"qrcode\\"], canvas[class*=\\"qr\\"]");' +
  ' const nickNodes = document.querySelectorAll("[class*=\\"nickname\\"], [class*=\\"user-name\\"], [class*=\\"userName\\"], [class*=\\"avatar\\"] + span, .name");' +
  ' let nickname = "";' +
  ' for (const n of nickNodes) { const t = (n.textContent || "").trim(); if (t && t.length <= 30) { nickname = t; break; } }' +
  ' return { href: href, cookies: cookies, loginWord: loginWord, qr: qr, nickname: nickname, text: text.slice(0, 1500) };' +
  '})()'

// 作品数据页快照：正文文案 + 标题 + 页面上出现的数字片段（给模型读，不做字段映射）
const STATS_SCRIPT =
  '(() => {' +
  DEEP_TEXT_FN +
  ' const text = __deepText();' +
  ' const compact = text.replace(/\\n{2,}/g, "\\n").trim();' +
  ' const numbers = (compact.match(/[0-9][0-9.,]*\\s*(万|亿|w|播放|点赞|评论|分享|收藏|粉丝|作品|条)/g) || []).slice(0, 40);' +
  ' return { title: document.title, href: location.href, text: compact, numbers: numbers };' +
  '})()'

// 上传进度 / 素材预览探针
const UPLOAD_STATE_SCRIPT =
  '(() => {' +
  // 真机（2026-11-09 视频号）：发表动态整页在 <wujie-app> 的 shadowRoot 里，素材预览 video/img、
  // 上传进度、编辑器都在 shadow 内，document.querySelector 全落空 ⇒ 上传永远判不完成。
  // 边界（踩过）：逐层递归 walk(shadowRoot) 在这类微前端页面会跑不完（页面脚本 20 秒超时，恒 null），
  // 改成「根集合广度收集 + visited 去重 + 数量上限」的迭代写法。
  ' const __roots = (() => {' +
  '   const out = [document];' +
  '   const seen = new Set(out);' +
  '   for (let i = 0; i < out.length && out.length < 60; i++) {' +
  '     const root = out[i];' +
  '     let kids = [];' +
  '     try { kids = Array.from(root.querySelectorAll("*")); } catch (e) { kids = []; }' +
  '     for (const el of kids) {' +
  '       const sr = el.shadowRoot;' +
  '       if (sr && !seen.has(sr)) { seen.add(sr); out.push(sr); }' +
  '     }' +
  '   }' +
  '   return out;' +
  ' })();' +
  ' const __all = (sel) => {' +
  '   const hits = [];' +
  '   for (const root of __roots) {' +
  '     try { for (const el of Array.from(root.querySelectorAll(sel))) hits.push(el); } catch (e) {}' +
  '   }' +
  '   return hits;' +
  ' };' +
  ' const __text = () => {' +
  '   const parts = [];' +
  '   for (const root of __roots) {' +
  '     try {' +
  '       const host = root.host;' +
  '       const body = root.body;' +
  '       parts.push(host ? (root.textContent || "") : body ? (body.innerText || body.textContent || "") : (root.textContent || ""));' +
  '     } catch (e) {}' +
  '   }' +
  '   return parts.join("\\n");' +
  ' };' +
  ' const text = __text();' +
  ' const words = ["上传中", "正在上传", "处理中", "转码中", "视频上传中"];' +
  ' const uploading = words.some((w) => text.indexOf(w) >= 0) || __all("[class*=\\"progress\\"], [class*=\\"uploading\\"], .progress-bar").some((el) => {' +
  '   const r = el.getBoundingClientRect();' +
  '   return r.width > 0 && r.height > 0;' +
  ' });' +
  ' let media = false;' +
  ' for (const el of __all("video, img")) {' +
  '   const src = el.currentSrc || el.src || "";' +
  '   const r = el.getBoundingClientRect();' +
  '   if (r.width >= 80 && r.height >= 40 && (src.indexOf("blob:") === 0 || src.indexOf("data:") === 0 || src.indexOf("http") === 0)) {' +
  '     const cls = String(el.className || "") + " " + String(el.getAttribute("alt") || "");' +
  '     if (cls.indexOf("qrcode") < 0 && cls.indexOf("avatar") < 0 && cls.indexOf("logo") < 0) { media = true; break; }' +
  '   }' +
  ' }' +
  ' const href = location.href;' +
  ' const editor = __all("[contenteditable], .zone-container, .ql-editor, textarea").some((el) => {' +
  '   const r = el.getBoundingClientRect();' +
  '   return r.width >= 120 && r.height >= 20;' +
  ' });' +
  // 真机教训（2026-11-09 小红书）：不能靠 URL 判断是否进编辑器——小红书的 homeUrl 本身就是
  // /publish/publish，一进页就为真，导致「上传素材」在上传页上假报就绪。改用编辑器专有标记。
  ' const editorMarks = [".zone-container", ".ProseMirror", ".ql-editor", "xhs-publish-btn", "#post-title"];' +
  ' const postEditor = editorMarks.some((sel) => {' +
  '   try { return __all(sel).some((el) => {' +
  '     const r = el.getBoundingClientRect();' +
  '     return r.width >= 60 && r.height >= 16;' +
  '   }); } catch (e) { return false; }' +
  ' });' +
  ' return { uploading: uploading, media: media, href: href, editor: editor, postEditor: postEditor, roots: __roots.length };' +
  '})()'

// 发布按钮优先按 <button> 精确文本点。
// 真机教训（2026-11-09 抖音）：表单里 div/span 的 textContent 也会正好是「发布」，
// locateScript 的 text= 取「最后一个命中」，点到外层 div 上 —— 日志显示已点击，页面根本没发出去。
const SUBMIT_BUTTON_SCRIPT =
  '(() => {' +
  VISIBLE_FN +
  ' const words = ["发布", "发表"];' +
  ' const norm = (el) => (el.textContent || "").replace(/\\s+/g, "");' +
  ' const btns = Array.from(document.querySelectorAll("button, [role=\\"button\\"]")).filter(__visible);' +
  ' const hits = btns.filter((el) => words.indexOf(norm(el)) >= 0);' +
  ' if (!hits.length) return { ok: false };' +
  ' const primary = hits.filter((el) => /primary/i.test(String(el.className || "")));' +
  ' const pool = primary.length ? primary : hits;' +
  ' const el = pool[pool.length - 1];' +
  ' el.scrollIntoView({ block: "center" }); el.click();' +
  ' return { ok: true, text: norm(el).slice(0, 10) };' +
  '})()'

// 取发布按钮的视口坐标，交给 CDP Input.dispatchMouseEvent 做真实鼠标点击。
// 真机教训（2026-11-09 抖音）：el.click() 对 React 表单按钮不生效——日志显示已点击，页面一动不动。
const SUBMIT_TARGET_SCRIPT =
  '(() => {' +
  VISIBLE_FN +
  ' const words = ["发布", "发表"];' +
  ' const norm = (el) => (el.textContent || "").replace(/\\s+/g, "");' +
  ' const btns = Array.from(document.querySelectorAll("button, [role=\\"button\\"]")).filter(__visible);' +
  ' const hits = btns.filter((el) => words.indexOf(norm(el)) >= 0);' +
  ' if (!hits.length) return { ok: false };' +
  ' const primary = hits.filter((el) => /primary/i.test(String(el.className || "")));' +
  ' const pool = primary.length ? primary : hits;' +
  ' const el = pool[pool.length - 1];' +
  ' el.scrollIntoView({ block: "center" });' +
  ' const r = el.getBoundingClientRect();' +
  ' if (!(r.width > 0 && r.height > 0)) return { ok: false, reason: "尺寸为 0" };' +
  ' return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: norm(el).slice(0, 10), vw: window.innerWidth, vh: window.innerHeight };' +
  '})()'

// 真机（2026-11-10 视频号）：发表页整页在 <wujie-app> 的 shadowRoot 里，document.querySelectorAll 找
// 不到「发表」按钮 ⇒ 走 shadow-aware 版本（根集合含 document 与各层 shadowRoot，对普通页面等价）。
// 用模板字符串写页面脚本，避免单引号拼接里的转义陷阱（真机踩过：转义丢失导致页面语法错误、恒 null）。
const SUBMIT_TARGET_SHADOW_SCRIPT = `
(() => {
  const roots = (() => {
    const out = [document]; const seen = new Set(out);
    for (let i = 0; i < out.length && out.length < 60; i++) {
      let kids = [];
      try { kids = Array.from(out[i].querySelectorAll("*")); } catch (e) { kids = []; }
      for (const el of kids) { const sr = el.shadowRoot; if (sr && !seen.has(sr)) { seen.add(sr); out.push(sr); } }
    }
    return out;
  })();
  const all = (sel) => {
    const hits = [];
    for (const root of roots) {
      try { for (const el of Array.from(root.querySelectorAll(sel))) hits.push(el); } catch (e) {}
    }
    return hits;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const st = window.getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  };
  const norm = (el) => String(el.textContent || "").replace(/\\s+/g, "");
  const words = ["发表", "发布"];
  const candidateSel = "button, [role=\\"button\\"], .weui-desktop-btn, a[class*=\\"btn\\"], div[class*=\\"btn\\"]";
  const btns = all(candidateSel).filter(visible);
  const hits = btns.filter((el) => words.indexOf(norm(el)) >= 0);
  if (!hits.length) return { ok: false, reason: "no-text-hit", scanned: btns.length, roots: roots.length };
  const primary = hits.filter((el) => /primary/i.test(String(el.className || "")));
  const pool = primary.length ? primary : hits;
  const el = pool[pool.length - 1];
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return { ok: false, reason: "尺寸为 0" };
  return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: norm(el).slice(0, 10), vw: window.innerWidth, vh: window.innerHeight };
})()
`

// 自定义元素（封闭 shadowRoot，textContent 搜不到按钮文字）取元素矩形，交给按比例的真实鼠标点击。
// 真机（2026-11-09 小红书）：发布按钮是 <xhs-publish-btn submit-text="发布" save-text="暂存离开">，
// 文字在 closed shadow DOM 里，el.textContent 是空串 —— 文本兜底会误点「定时发布」。
function submitRectScript(selectors: string[]): string {
  return (
    '(() => {' +
    VISIBLE_FN +
    ' const sels = ' + JSON.stringify(selectors) + ';' +
    ' for (const sel of sels) {' +
    '   let nodes = [];' +
    '   try { nodes = Array.from(document.querySelectorAll(sel)); } catch (e) { nodes = []; }' +
    '   for (const el of nodes) {' +
    '     if (!__visible(el)) continue;' +
    '     el.scrollIntoView({ block: "center" });' +
    '     const r = el.getBoundingClientRect();' +
    '     if (!(r.width > 40 && r.height > 20)) continue;' +
    '     return { ok: true, selector: sel, left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };' +
    '   }' +
    ' }' +
    ' return { ok: false };' +
    '})()'
  )
}

// 点击诊断：点之前装监听、点之后读回来，用来区分「没点中」「点中了但页面拒绝」
const CLICK_PROBE_INSTALL_SCRIPT =
  '(() => {' +
  ' window.__fcmClickLog = [];' +
  ' ["pointerdown", "mousedown", "mouseup", "click"].forEach((t) => {' +
  '   window.addEventListener(t, (e) => { const el = e.target || {};' +
  '     const txt = String((el.textContent || "")).replace(/\\s+/g, "").slice(0, 12);' +
  '     window.__fcmClickLog.push(t + ":" + String(el.tagName || "?") + ":" + txt);' +
  '   }, true);' +
  ' });' +
  ' return { ok: true, dpr: window.devicePixelRatio, vw: window.innerWidth, vh: window.innerHeight };' +
  '})()'

const CLICK_PROBE_READ_SCRIPT = '(() => ({ log: (window.__fcmClickLog || []).slice(-8) }))()'

// 发布按钮兜底：遍历 button/div/span 文本包含「发布/发表」的可见可点元素，点最后一个
const FALLBACK_SUBMIT_SCRIPT =
  '(() => {' +
  VISIBLE_FN +
  ' const words = ["发布", "发表"];' +
  ' const nodes = Array.from(document.querySelectorAll("button, [role=\\"button\\"], div, span, a"));' +
  ' const hits = nodes.filter((el) => {' +
  '   const t = (el.textContent || "").replace(/\\s+/g, "");' +
  '   if (!t || t.length > 12) return false;' +
  '   if (!words.some((w) => t.indexOf(w) >= 0)) return false;' +
  '   if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;' +
  '   return __visible(el);' +
  ' });' +
  ' if (!hits.length) return { ok: false };' +
  ' const norm = (el) => (el.textContent || "").replace(/\\s+/g, "");' +
  ' const exact = hits.filter((el) => words.some((w) => norm(el) === w));' +
  ' const el = exact.length ? exact[exact.length - 1] : hits[hits.length - 1];' +
  ' el.scrollIntoView({ block: "center" }); el.click();' +
  ' return { ok: true, text: (el.textContent || "").trim().slice(0, 20) };' +
  '})()'

// 定时发布：优先点「立即发布」；没有入口就跳过
const IMMEDIATE_SCRIPT =
  '(() => {' +
  VISIBLE_FN +
  ' const nodes = Array.from(document.querySelectorAll("button, div, span, label, li, [role=\\"tab\\"], [role=\\"radio\\"]"));' +
  ' const norm = (el) => (el.textContent || "").replace(/\\s+/g, "");' +
  ' const find = (word) => nodes.find((el) => norm(el) === word && __visible(el));' +
  ' const now = find("立即发布");' +
  ' if (now) { now.click(); return { ok: true, detail: "已选择立即发布" }; }' +
  ' const timed = find("定时发布");' +
  ' if (timed) {' +
  '   timed.click();' +
  '   const again = nodes.find((el) => norm(el) === "立即发布" && __visible(el));' +
  '   if (again) { again.click(); return { ok: true, detail: "定时发布入口已切回立即发布" }; }' +
  '   return { ok: true, detail: "找到定时发布入口但未找到立即发布选项，按平台默认处理" };' +
  ' }' +
  ' return { ok: true, detail: "未找到定时发布入口，按平台默认立即发布" };' +
  '})()'

// 发布结果探针：成功提示 + 作品链接
function outcomeScript(hints: string[]) {
  return (
    '(() => {' +
    ' const text = document.body ? document.body.innerText : "";' +
    ' const hints = ' + JSON.stringify(hints) + ';' +
    ' let hint = "";' +
    ' for (const h of hints) {' +
    '   if (h.indexOf(".") === 0 || h.indexOf("#") === 0 || h.indexOf("[") === 0) {' +
    '     try { if (document.querySelector(h)) { hint = h; break; } } catch (e) {}' +
    '   } else if (text.indexOf(h) >= 0) { hint = h; break; }' +
    ' }' +
    ' const href = location.href;' +
    ' const links = Array.from(document.querySelectorAll("a[href]")).map((a) => a.href).filter((u) => u && (u.indexOf("/video/") >= 0 || u.indexOf("/note/") >= 0 || u.indexOf("/explore/") >= 0 || u.indexOf("/s/") >= 0 || u.indexOf("/post/") >= 0));' +
    ' return { hint: hint, href: href, link: links.length ? links[links.length - 1] : "" };' +
    '})()'
  )
}

// 填文本后的校验片段（看当前聚焦元素的值/文本里有没有刚插入的前几个字符）
/** 同一路径（忽略 query/hash）：判断导航是否真的落到目标页 */
function samePath(a: string, b: string): boolean {
  const pick = (u: string): string => {
    try {
      const p = new URL(u)
      return p.origin + p.pathname.replace(/\/+$/, '')
    } catch (e) {
      return ''
    }
  }
  const x = pick(a)
  const y = pick(b)
  return !!x && x === y
}

function verifyScript(text: string) {
  const head = Array.from(text).slice(0, 8).join('')
  return (
    '(() => {' +
    ' const head = ' + JSON.stringify(head) + ';' +
    ' const read = (e) => (!e ? "" : ((e.value !== undefined && e.value !== null) ? String(e.value) : (e.textContent || "")));' +
    ' const a = document.activeElement;' +
    ' if (a && read(a).indexOf(head) >= 0) return true;' +
    // 真机（2026-11-09 视频号回复框）：输入框在 wujie shadowRoot 里，focus 后 document.activeElement
    // 是宿主元素；而且 textarea 的内容只在 value 里（textContent 为空），深文本也读不到，必须逐个 root 查 value。
    ' const roots = [document];' +
    ' const walk = (root) => {' +
    '   let kids = [];' +
    '   try { kids = Array.from(root.querySelectorAll("*")); } catch (e) { kids = []; }' +
    '   for (const el of kids) { if (el.shadowRoot) { roots.push(el.shadowRoot); try { walk(el.shadowRoot); } catch (e) {} } }' +
    ' };' +
    ' try { walk(document); } catch (e) {}' +
    ' for (const root of roots) {' +
    '   let els = [];' +
    '   try { els = Array.from(root.querySelectorAll("input, textarea, [contenteditable]")); } catch (e) { els = []; }' +
    '   for (const el of els) { if (read(el).indexOf(head) >= 0) return true; }' +
    ' }' +
    DEEP_TEXT_FN +
    ' return __deepText().indexOf(head) >= 0;' +
    '})()'
  )
}

/** 三个平台的发布编排器：同一平台串行互斥，所有窗口默认隐藏（login/openDebug 例外） */
export class PlatformManager {
  private readonly deps: PlatformManagerDeps
  private readonly locks = new Map<string, Promise<unknown>>()
  /** 正在整段 hold debugger 的 webContents id（发布流程用），见 holdDebugger 注释 */
  private readonly debugHeld = new Set<number>()
  /** 最近一次登录态检查结果，避免每次进页面都开窗口重查 */
  private readonly statusCache = new Map<string, { at: number; status: PlatformStatus }>()
  /** 常驻的隐藏窗口（每个平台一个）：窗口和渲染进程都留着，命中就不用再付一次冷启动 */
  private readonly windows = new Map<string, BrowserWindow>()
  /** 已挂过协议守卫的分区，webRequest 监听每个 session 只能挂一次 */
  private readonly guarded = new Set<string>()

  constructor(deps: PlatformManagerDeps) {
    this.deps = deps
  }

  // ---------- 对外 API ----------

  /**
   * 逐个平台检查登录态；platform 留空则检查全部。
   * maxAgeMs > 0 时优先复用缓存（默认 STATUS_CACHE_MS），传 0 强制重查。
   */
  async status(platform?: string, opts: { maxAgeMs?: number } = {}): Promise<PlatformStatus[]> {
    const ids = platform ? [platform] : PLATFORMS.map((p) => p.id as string)
    const maxAge = opts.maxAgeMs === undefined ? STATUS_CACHE_MS : opts.maxAgeMs
    // 三个平台并行查（锁是按平台分的，互不影响）：用户反馈「打开三个应用有点慢」，串行是主因之一
    const jobs = ids.map(async (id) => {
      if (!(DRIVERS as Record<string, PlatformDriver>)[id]) {
        return { platform: id, name: id, loggedIn: false, checkedAt: nowIso(), error: '未知平台：' + id } as PlatformStatus
      }
      const cached = this.statusCache.get(id)
      if (cached && maxAge > 0 && Date.now() - cached.at <= maxAge) return cached.status
      return this.runExclusive(id, () => this.checkStatus(id))
    })
    return Promise.all(jobs)
  }

  /**
   * 预热：提前把隐藏窗口和登录页拉起来（不阻塞界面）。
   * 用户点「扫码登录」时窗口已经热好了，弹出几乎是瞬时的（用户反馈打开弹窗慢）。
   */
  warmUp(platform?: string): void {
    const ids = platform ? [platform] : PLATFORMS.map((p) => p.id as string)
    for (const id of ids) {
      const driver = (DRIVERS as Record<string, PlatformDriver>)[id]
      if (!driver) continue
      if (this.windows.has(id)) continue
      try {
        const win = this.ensureWindow(id, false)
        void this.navigate(win, driver.loginUrlHint || driver.homeUrl, NAV_EVAL_WAIT_MS).catch(() => null)
      } catch (e) {
        this.log('[' + id + '] 预热窗口失败：' + errText(e))
      }
    }
  }

  /** 打开可见窗口让用户扫码，每 3 秒轮询，最长 180 秒 */
  async login(platform: string): Promise<PlatformStatus> {
    return this.runExclusive(platform, () => this.doLogin(platform))
  }

  /** 清空该平台 partition 的登录态 */
  async logout(platform: string): Promise<void> {
    return this.runExclusive(platform, async () => {
      this.driver(platform)
      // 退登要真的销毁窗口：留着旧页面会让「已退出」的会话继续渲染
      this.destroyWindow(this.windows.get(platform) || null)
      this.windows.delete(platform)
      const ses = session.fromPartition(this.partitionOf(platform))
      await ses.clearStorageData()
      this.statusCache.delete(platform)
      this.log('[' + platform + '] 已清空登录态')
      this.emit(platform, 'logout', '已清空登录态')
    })
  }

  /** 打开可见窗口，方便用户手动处理滑块/验证码 */
  async openDebug(platform: string): Promise<void> {
    return this.runExclusive(platform, async () => {
      const driver = this.driver(platform)
      const pooled = this.windows.get(platform)
      if (pooled && !pooled.isDestroyed() && pooled.isVisible()) {
        pooled.focus()
        return
      }
      const win = this.ensureWindow(platform, true)
      try {
        await this.navigate(win, driver.homeUrl, OPEN_DEBUG_TIMEOUT_MS)
        this.emit(platform, 'debug', '已打开调试窗口：' + driver.homeUrl)
      } catch (e) {
        // 窗口已经开出来了（用户看得见），页面慢就让它慢慢加载，不要用报错打断用户
        this.log('[' + platform + '] 调试窗口页面加载较慢：' + errText(e))
        this.emit(platform, 'debug', '已打开窗口，页面还在加载：' + driver.homeUrl)
      }
    })
  }

  /** 执行一次完整发布：上传素材 -> 标题 -> 正文 -> 立即发布 -> 等结果 */
  async publish(input: PublishInput): Promise<PublishResult> {
    const platform = String(input && input.platform ? input.platform : '')
    const result: PublishResult = { platform, ok: false, message: '', screenshots: [], steps: [] }
    let driver: PlatformDriver
    try {
      driver = this.driver(platform)
    } catch (e) {
      result.message = errText(e)
      return result
    }
    return this.runExclusive(platform, () => this.doPublish(platform, input, driver, result))
  }

  /**
   * P25 作品数据快照：打开平台的「作品数据」页，把可见文案整段读回来。
   * 刻意不做选择器解析——三个平台的数据面板都是动态组件、字段名常改，
   * 把页面文案交给模型读，比硬编码一大堆 `.xxx-number` 选择器更耐用。
   */
  async stats(platform: string, opts?: { maxChars?: number }): Promise<PlatformStatsSnapshot> {
    const id = String(platform || '')
    const maxChars = Math.min(Math.max(Number(opts?.maxChars) || 4000, 500), 12000)
    const snapshot: PlatformStatsSnapshot = {
      platform: id,
      name: id,
      ok: false,
      loggedIn: false,
      pageTitle: '',
      href: '',
      text: '',
      screenshots: [],
      message: ''
    }
    let driver: PlatformDriver
    try {
      driver = this.driver(id)
    } catch (e) {
      snapshot.message = errText(e)
      return snapshot
    }
    return this.runExclusive(id, async () => {
      snapshot.name = driver.name
      let win: BrowserWindow | null = null
      try {
        win = this.ensureWindow(id, false)
        if (win.isVisible()) win.hide()
        try {
          await this.navigate(win, driver.dataUrl)
        } catch (e) {
          this.log('[' + id + '] 数据页打不开，回落到首页：' + errText(e))
          await this.navigate(win, driver.homeUrl)
        }
        if (driver.needsVisibleWindow) win.showInactive()
        await sleep(4000)
        const probe = await this.probeUntilReady(win)
        const judged = probe ? await this.judgeLoginAsync(id, driver, probe) : { loggedIn: false }
        snapshot.loggedIn = judged.loggedIn
        if (!judged.loggedIn) {
          snapshot.message = '还没有登录 ' + driver.name + '，请先点「扫码登录」'
          snapshot.screenshots.push(...(await this.shotList(win, id, 'stats-login')))
          return snapshot
        }
        const info = await this.attachAndEval<any>(win, STATS_SCRIPT).catch(() => null)
        if (info) {
          snapshot.pageTitle = String(info.title || '')
          snapshot.href = String(info.href || '')
          snapshot.text = String(info.text || '').slice(0, maxChars)
        }
        snapshot.screenshots.push(...(await this.shotList(win, id, 'stats')))
        snapshot.ok = !!snapshot.text
        snapshot.message = snapshot.ok
          ? '已读取 ' + driver.name + ' 数据页（' + snapshot.text.length + ' 字）'
          : '数据页没有读到内容，可能还在加载，请稍后重试或手动打开后台查看'
        this.emit(id, 'stats', snapshot.message)
        return snapshot
      } catch (e) {
        snapshot.message = '读取 ' + driver.name + ' 数据失败：' + errText(e)
        return snapshot
      } finally {
        if (driver.needsVisibleWindow && win) win.hide()
        this.closeWindow(win)
      }
    })
  }

  /**
   * 读评论（跨「作品」聚合）。真机（2026-11-09 视频号）：评论管理页是「左作品列表 + 右评论」两栏，
   * 必须先点某条作品，右侧才加载该作品的评论。这里先枚举左侧作品、逐条点开读评论，把条目按 feed 归组，
   * index 是跨作品连续编号（comments() 返回给用户的编号，replyComment 也按它定位）。
   */
  private async scanCommentsAcrossFeeds(
    win: BrowserWindow,
    driver: PlatformDriver,
    opts?: { maxItems?: number }
  ): Promise<{ items: { index: number; text: string; feed: number }[]; selector: string; feeds: number }> {
    const maxItems = Math.min(Math.max(Number(opts?.maxItems) || 20, 1), 50)
    const out: { index: number; text: string; feed: number }[] = []
    let selector = ''
    const single = async (feed: number): Promise<void> => {
      const info = await this.attachAndEval<any>(win, scanCommentsScript(driver)).catch(() => null)
      if (!info) return
      if (!selector) selector = String(info.selector || '')
      const list = Array.isArray(info.items) ? info.items : []
      for (const it of list) {
        const text = String(it?.text || '')
        if (!text) continue
        out.push({ index: out.length, text, feed })
        if (out.length >= maxItems) return
      }
    }
    if (!driver.commentFeedItem || !driver.commentFeedItem.length) {
      await single(0)
      return { items: out, selector, feeds: 0 }
    }
    const fl = await this.attachAndEval<any>(win, feedListScript(driver)).catch(() => null)
    const count = Math.min(Number(fl?.count) || 0, COMMENT_FEED_MAX)
    if (!count) {
      // 没有作品列表（结构可能变了）就退回直接扫，别整个流程报错
      await single(0)
      return { items: out, selector, feeds: 0 }
    }
    for (let feed = 0; feed < count; feed++) {
      if (out.length >= maxItems) break
      const picked = await this.attachAndEval<any>(win, selectFeedScript(driver, feed)).catch(() => null)
      if (!picked || !picked.ok) continue
      await sleep(COMMENT_FEED_WAIT_MS)
      await single(feed)
    }
    return { items: out, selector, feeds: count }
  }

  /**
   * P32 评论列表：打开平台的「评论管理」页，把可见评论条目读回来。
   * 只做「读」不做字段猜测——条目文本整段返回，交给用户/模型判断该回哪条。
   */
  async comments(platform: string, opts?: { maxItems?: number }): Promise<PlatformCommentsSnapshot> {
    const id = String(platform || '')
    const maxItems = Math.min(Math.max(Number(opts?.maxItems) || 20, 1), 50)
    const snapshot: PlatformCommentsSnapshot = {
      platform: id,
      name: id,
      ok: false,
      loggedIn: false,
      pageTitle: '',
      href: '',
      selector: '',
      items: [],
      screenshots: [],
      message: ''
    }
    let driver: PlatformDriver
    try {
      driver = this.driver(id)
    } catch (e) {
      snapshot.message = errText(e)
      return snapshot
    }
    if (driver.commentsSupported === false) {
      // 真机核实（2026-11-09）：抖音/小红书创作后台网页版没有「评论管理」页，
      // 硬开失效 URL 只会在空白页上扫到 0 条，容易让用户误以为是没登录或没评论。
      snapshot.name = driver.name
      snapshot.message =
        driver.name + ' 创作后台网页版没有「评论管理」入口（2026-11-09 真机核实），暂不支持在本机读取评论；手机 App 里的评论无法通过浏览器自动化读取'
      return snapshot
    }
    return this.runExclusive(id, async () => {
      snapshot.name = driver.name
      let win: BrowserWindow | null = null
      try {
        win = this.ensureWindow(id, false)
        // 顺序很重要（真机 2026-11-09 视频号）：发表动态页有未提交表单，窗口可见时导航会被
        // beforeunload 拦住（net::ERR_ABORTED、URL 不变），所以先隐藏窗口完成导航，再显示出来让 SPA 渲染。
        if (win.isVisible()) win.hide()
        try {
          await this.navigate(win, driver.commentsUrl)
        } catch (e) {
          this.log('[' + id + '] 评论页打不开，回落到首页：' + errText(e))
          await this.navigate(win, driver.homeUrl)
        }
        if (driver.needsVisibleWindow) win.showInactive()
        await sleep(4000)
        const probe = await this.probeUntilReady(win)
        const judged = probe ? await this.judgeLoginAsync(id, driver, probe) : { loggedIn: false }
        snapshot.loggedIn = judged.loggedIn
        if (!judged.loggedIn) {
          snapshot.message = '还没有登录 ' + driver.name + '，请先点「扫码登录」'
          snapshot.screenshots.push(...(await this.shotList(win, id, 'comments-login')))
          return snapshot
        }
        const meta = await this.attachAndEval<any>(win, '({ title: document.title || "", href: location.href })').catch(
          () => null
        )
        if (meta) {
          snapshot.pageTitle = String(meta.title || '')
          snapshot.href = String(meta.href || '')
        }
        const scan = await this.scanCommentsAcrossFeeds(win, driver, { maxItems })
        snapshot.selector = scan.selector
        snapshot.items = scan.items.map((it) => ({ index: it.index, text: it.text }))
        snapshot.screenshots.push(...(await this.shotList(win, id, 'comments')))
        snapshot.ok = snapshot.items.length > 0
        snapshot.message = snapshot.ok
          ? '已读取 ' + driver.name + ' 评论 ' + snapshot.items.length + ' 条' + (snapshot.selector ? '（选择器 ' + snapshot.selector + '）' : '')
          : '没读到评论：可能这个账号还没有评论，或页面结构变了（可点「打开后台」手动看一眼）'
        this.emit(id, 'comments', snapshot.message)
        return snapshot
      } catch (e) {
        snapshot.message = '读取 ' + driver.name + ' 评论失败：' + errText(e)
        return snapshot
      } finally {
        if (driver.needsVisibleWindow && win) win.hide()
        this.closeWindow(win)
      }
    })
  }

  /**
   * P32 回复评论：定位某条评论（index 或文本包含 match）→ 点它的「回复」→ 填内容 → 发送。
   * 选择器未真机校准时会在某一步抛中文错误并落截图，和发布链路保持一致。
   */
  async replyComment(
    platform: string,
    input: { index?: number; match?: string; text?: string }
  ): Promise<PlatformReplyResult> {
    const id = String(platform || '')
    const text = typeof input?.text === 'string' ? input.text.trim() : ''
    const result: PlatformReplyResult = { platform: id, ok: false, message: '', screenshots: [], steps: [] }
    let driver: PlatformDriver
    try {
      driver = this.driver(id)
    } catch (e) {
      result.message = errText(e)
      return result
    }
    if (!text) {
      result.message = '回复内容不能为空'
      return result
    }
    if (Array.from(text).length > COMMENT_TEXT_MAX) {
      result.message = '回复内容太长（' + Array.from(text).length + ' 字），最多 ' + COMMENT_TEXT_MAX + ' 字'
      return result
    }
    if (driver.commentsSupported === false) {
      result.message =
        driver.name + ' 创作后台网页版没有「评论管理」入口（2026-11-09 真机核实），暂不支持在这里回复评论'
      return result
    }
    const hasIndex = Number.isFinite(Number(input?.index))
    const match = String(input?.match || '').trim()
    if (!hasIndex && !match) {
      result.message = '请指定要回复哪条评论：给 index（第几条，0 开始）或 match（评论里的几个字）'
      return result
    }
    return this.runExclusive(id, async () => {
      let win: BrowserWindow | null = null
      try {
        win = this.ensureWindow(id, false)
        if (win.isVisible()) win.hide()
        const w = win
        const run = async (name: string, fn: () => Promise<string | undefined>, critical = true) => {
          try {
            const detail = await fn()
            result.steps.push({ step: name, ok: true, detail })
            result.screenshots.push((await this.shot(w, id, 'reply-' + name)) || '')
            this.emit(id, 'comment-reply', name + '：成功' + (detail ? '（' + detail + '）' : ''))
            return true
          } catch (e) {
            const msg = errText(e)
            result.steps.push({ step: name, ok: false, detail: msg })
            result.screenshots.push((await this.shot(w, id, 'reply-' + name + '-failed')) || '')
            this.emit(id, 'comment-reply', name + '：失败（' + msg + '）')
            if (critical) throw e
            return false
          }
        }

        await run('打开评论管理', async () => {
          let note = ''
          try {
            await this.navigate(w, driver.commentsUrl)
          } catch (e) {
            await this.navigate(w, driver.homeUrl)
            note = '（评论页打不开，已回落到 ' + driver.homeUrl + '：' + errText(e) + '）'
          }
          if (driver.needsVisibleWindow && !w.isVisible()) w.showInactive()
          await sleep(3000)
          // 真机（2026-11-09 视频号）：窗口隐藏时导航过去，wujie 子应用常常不挂载，页面只有
          // 「视频号 · 助手」几个字，登录检查就会误判未登录。窗口显示后若内容还是空的，再导航一次。
          if (driver.needsVisibleWindow) {
            const state = await this.attachAndEval<any>(w, PROBE_SCRIPT).catch(() => null)
            if (!state || String(state.text || '').length < 60) {
              await this.navigate(w, driver.commentsUrl).catch(() => null)
              await sleep(2500)
            }
          }
          return '已打开 ' + driver.commentsUrl + note
        })

        await run('检查登录状态', async () => {
          const probe = await this.probeUntilReady(w)
          const judged = probe ? await this.judgeLoginAsync(id, driver, probe) : { loggedIn: false }
          if (!judged.loggedIn) {
            throw new Error('还没有登录 ' + driver.name + '：请先在「发布」页点「扫码登录」完成登录')
          }
          return '已登录' + (judged.nickname ? '（' + judged.nickname + '）' : '')
        })

        await run('定位评论并点回复', async () => {
          // 视频号是「左作品 + 右评论」，要先找到这条评论属于哪个作品并点开，再在那条作品里点回复。
          const scan = await this.scanCommentsAcrossFeeds(w, driver, { maxItems: 50 })
          if (!scan.items.length) throw new Error('没读到评论列表（页面结构可能变了，或还没登录）')
          let idx = -1
          if (match) idx = scan.items.findIndex((it) => it.text.indexOf(match) >= 0)
          if (idx < 0 && hasIndex) {
            const want = Number(input?.index)
            if (want >= 0 && want < scan.items.length) idx = want
          }
          if (idx < 0) {
            throw new Error('没找到要回复的评论（共 ' + scan.items.length + ' 条，可用 index 或 match 再指定）')
          }
          const target = scan.items[idx]
          if (driver.commentFeedItem && driver.commentFeedItem.length) {
            const picked = await this.attachAndEval<any>(w, selectFeedScript(driver, target.feed))
            if (!picked || !picked.ok) throw new Error(String(picked?.error || '没找到这条评论所属的作品'))
            await sleep(COMMENT_FEED_WAIT_MS)
          }
          const local = await this.attachAndEval<any>(w, scanCommentsScript(driver)).catch(() => null)
          const localItems: any[] = Array.isArray(local?.items) ? local!.items : []
          const localIdx = localItems.findIndex((it) => String(it?.text || '') === target.text)
          const spec =
            localIdx >= 0
              ? { index: localIdx }
              : { match: Array.from(target.text).slice(0, 16).join('') }
          const hit = await this.attachAndEval<any>(w, clickReplyScript(driver, spec))
          if (!hit) throw new Error('页面没有返回结果（可能还在加载），请重试')
          if (!hit.ok) throw new Error(String(hit.error || '没找到要回复的评论'))
          result.target = String(hit.text || target.text || '').slice(0, 120)
          return (
            '命中「' + String(result.target).slice(0, 40) + '…」（按钮 ' + String(hit.selector || '') + '）'
          )
        })

        await sleep(1500)

        await run('填写回复', async () => {
          return this.fillField(w, id, '回复', driver.commentReplyInput, text)
        })

        await run('点击发送', async () => {
          const clickAction = 'el.scrollIntoView({ block: "center" }); el.click();'
          // 必须走 attachAndEval：evalPage 只是 sendCommand，没 attach 会抛「No target available」
          const found = await this.attachAndEval<any>(w, locateScript(driver.commentSendButton, clickAction))
          if (!found || !found.ok) {
            throw new Error(
              '选择器未命中：没找到发送按钮（' + id + '），候选 ' + driver.commentSendButton.join(' | ')
            )
          }
          return '已点击发送：' + found.selector
        })

        await run('确认回复结果', async () => {
          await sleep(2500)
          const outcome = await this.attachAndEval<any>(w, replyOutcomeScript(driver, text)).catch(() => null)
          const details: string[] = []
          if (outcome?.hint) details.push('命中成功提示「' + outcome.hint + '」')
          if (outcome?.cleared) details.push('回复输入框已清空')
          if (!details.length) {
            throw new Error('没确认到回复成功（既没有成功提示，输入框也没清空），请查看截图人工确认')
          }
          return details.join('；')
        })

        result.ok = true
        const last = result.steps[result.steps.length - 1]
        result.message = '已回复 ' + driver.name + ' 评论：' + ((last && last.detail) || '') + (result.target ? '｜针对「' + result.target.slice(0, 40) + '…」' : '')
        this.emit(id, 'comment-reply', result.message)
        return result
      } catch (e) {
        result.ok = false
        result.message = '回复失败：' + errText(e)
        this.log('[' + id + '] ' + result.message)
        this.emit(id, 'comment-reply', result.message)
        return result
      } finally {
        if (driver.needsVisibleWindow && win) win.hide()
        this.closeWindow(win)
      }
    })
  }

  private async shotList(win: BrowserWindow, platform: string, step: string): Promise<string[]> {
    const one = await this.shot(win, platform, step)
    return one ? [one] : []
  }

  // ---------- 串行锁 ----------

  private runExclusive<T>(platform: string, task: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(platform) || Promise.resolve()
    const next = prev.then(task, task)
    this.locks.set(platform, next.then(() => undefined, () => undefined))
    return next
  }

  // ---------- 基础工具 ----------

  private driver(platform: string): PlatformDriver {
    const found = (DRIVERS as Record<string, PlatformDriver>)[platform]
    if (!found) throw new Error('未知平台：' + platform + '（只支持 douyin / xiaohongshu / shipinhao）')
    return found
  }

  private partitionOf(platform: string) {
    return 'persist:platform-' + platform
  }

  private log(message: string) {
    try {
      console.log('[platform] ' + message)
      this.deps.log?.(message)
    } catch {
      // 日志本身不允许影响主流程
    }
  }

  private emit(platform: string, type: string, message: string) {
    try {
      this.deps.onEvent?.({ platform, type, message, at: nowIso() })
    } catch {
      // 事件回调异常忽略
    }
  }

  private createWindow(platform: string, show: boolean): BrowserWindow {
    const driver = this.driver(platform)
    const partition = this.partitionOf(platform)
    const ses = session.fromPartition(partition)
    // 每个平台独立分区，UA 必须挂在分区上（窗口级设置对导航不生效）
    ses.setUserAgent(PLATFORM_UA)
    this.ensureSchemeGuard(partition, ses)
    const win = new BrowserWindow({
      width: 1280,
      height: 900,
      show,
      title: driver.name + ' - 平台发布',
      autoHideMenuBar: true,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 隐藏窗口也要正常跑定时器/渲染，否则取数和登录态检查会被节流拖慢
        backgroundThrottling: false
      }
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    return win
  }

  /** 非 HTTP(S) 协议一律拦掉：平台页的「打开客户端」链接会调起系统外部协议处理，Windows 就弹商店搜索框 */
  private ensureSchemeGuard(partition: string, ses: Session) {
    if (this.guarded.has(partition)) return
    this.guarded.add(partition)
    try {
      ses.webRequest.onBeforeRequest((details, callback) => {
        const url = String(details && details.url ? details.url : '')
        if (!url || ALLOWED_SCHEME.test(url)) {
          callback({})
          return
        }
        this.log('[guard] 拦截外部协议请求：' + url.slice(0, 120))
        callback({ cancel: true })
      })
    } catch (e) {
      this.log('[guard] 协议守卫挂载失败：' + errText(e))
    }
  }

  /**
   * 取窗口：优先复用一个平台已经存在的那个窗口（隐藏着也留着）。
   * 冷启动一次要建渲染进程 + 拉页面，三平台串行要十几秒；复用后基本只剩导航时间。
   */
  private ensureWindow(platform: string, show: boolean): BrowserWindow {
    const existing = this.windows.get(platform)
    if (existing && !existing.isDestroyed()) {
      if (show) {
        try {
          existing.show()
          existing.focus()
        } catch {
          // 忽略了：窗口可能刚好在被销毁
        }
      }
      return existing
    }
    const win = this.createWindow(platform, show)
    this.windows.set(platform, win)
    win.on('closed', () => {
      if (this.windows.get(platform) === win) this.windows.delete(platform)
    })
    return win
  }

  /** 用完不销毁：隐藏起来留着，下次直接复用（用户手动点 X 关掉时窗口会自己从池里移除） */
  private closeWindow(win: BrowserWindow | null) {
    try {
      if (win && !win.isDestroyed()) win.hide()
    } catch {
      // 窗口可能已被平台页面关掉
    }
  }

  /** 真正销毁窗口（退出登录 / 应用退出时清场） */
  private destroyWindow(win: BrowserWindow | null) {
    try {
      if (win && !win.isDestroyed()) win.destroy()
    } catch {
      // 忽略
    }
  }

  /** 应用退出前销毁所有常驻窗口，避免 Electron 卡在退出流程 */
  disposeAll() {
    for (const win of Array.from(this.windows.values())) this.destroyWindow(win)
    this.windows.clear()
  }

  /**
   * 把一次页面交互和「窗口被用户关掉」赛跑。
   *
   * 用户手动点 X 关掉登录窗口时，Electron 对已销毁 webContents 的 executeJavaScript / debugger 调用
   * 可能永远不 settle，导致 login() 的 Promise 悬着、串行锁不释放 —— 表现就是「关掉弹窗后再点登录没反应」。
   * 这里一旦窗口关闭立刻返回 null，让上层的轮询跳出并把锁释放掉。
   */
  private async untilClosed<T>(win: BrowserWindow, task: Promise<T>): Promise<T | null> {
    if (win.isDestroyed()) return null
    // 只由窗口的 closed 事件把结果解成 null；任务本身成功时必须把真实返回值交出去。
    // （早先的实现里额外挂了 task.then(done)，它在 race 之前注册，任务一成功就会先把
    //  closed 解成 null，导致 navigate 永远拿不到页面快照、30 秒后误报「页面没有响应」。）
    let settle: ((value: T | null) => void) | null = null
    const closed = new Promise<T | null>((resolve) => {
      settle = resolve
    })
    const onClosed = () => {
      if (settle) settle(null)
    }
    win.once('closed', onClosed)
    try {
      return await Promise.race([task.catch(() => null as T | null), closed])
    } finally {
      try {
        win.removeListener('closed', onClosed)
      } catch {
        // 窗口已销毁，忽略
      }
    }
  }

  /**
   * 打开页面并等到「DOM 就绪」。
   *
   * 不能只等 loadURL 的 load 事件：抖音创作者中心有长连接子资源，实测 40 秒 load 事件都不触发，
   * 但 document.readyState 早已是 complete、页面元素都在；小红书/视频号的部分跳转会以
   * ERR_ABORTED / ERR_TIMED_OUT 结算 loadURL，也属于「页面其实开了」。
   * 所以改成轮询页面就绪状态，只有最终没就绪时才把错误抛出去。
   */
  private async navigate(win: BrowserWindow, url: string, timeoutMs = NAV_TIMEOUT_MS) {
    if (win.isDestroyed()) throw new Error('窗口已关闭，无法打开页面：' + url)
    const failures: string[] = []
    win.loadURL(url).catch((e: unknown) => {
      failures.push(errText(e))
    })
    const startedAt = Date.now()
    const deadline = startedAt + timeoutMs
    let last: { ready: boolean; href: string; bodyLen: number } | null = null
    // 真机教训（2026-11-09 小红书）：webContents.loadURL 有时一直卡在「请求已发出、文档没提交」
    // （location.href 已经是目标地址，但 document 还是 about:blank），30 秒后超时。
    // 同一个窗口改用 CDP Page.navigate 重发一次就能正常加载，所以超时就兜底重发。
    let fallbackUsed = false
    while (Date.now() < deadline) {
      if (!fallbackUsed && Date.now() - startedAt > Math.min(6000, Math.floor(timeoutMs / 3))) {
        fallbackUsed = true
        try {
          await this.attach(win)
          await win.webContents.debugger.sendCommand('Page.enable')
          await win.webContents.debugger.sendCommand('Page.navigate', { url })
          this.log('[navigate] loadURL 迟迟没有提交，改用 CDP Page.navigate 重新发起：' + url)
        } catch (e) {
          this.log('[navigate] CDP 兜底导航失败：' + errText(e))
        } finally {
          await this.detach(win)
        }
      }
      if (win.isDestroyed()) throw new Error('窗口被关闭了，请重新点击「打开后台」：' + url)
      try {
        // 页面还没 commit 时 executeJavaScript 会一直挂着（不是抛错），所以每次取值再套 2 秒上限，
        // 否则一次调用就能把整个轮询卡死（实测首帧冷启动时卡过 70 多秒）。
        last = (await Promise.race([
          this.untilClosed(win, win.webContents.executeJavaScript(READY_SCRIPT)),
          sleep(NAV_EVAL_WAIT_MS).then(() => null)
        ])) as { ready: boolean; href: string; bodyLen: number } | null
      } catch (e) {
        // 页面还没建好时 executeJavaScript 会抛（frame 未就绪），记下原因继续轮询
        failures.push(errText(e))
        last = null
      }
      if (last && last.ready && last.href && last.href !== 'about:blank') {
        // 真机（2026-11-09 视频号）：发表动态页有未提交表单时，导航会被 beforeunload 拦下并结算成
        // ERR_ABORTED，但旧页面仍然 ready，不校验就会把「没跳过去」当成「打开了」。
        const aborted = failures.some((m) => /ERR_ABORTED|aborted/i.test(m))
        if (!aborted || samePath(last.href, url)) return
      }
      await sleep(400)
    }
    const detail = failures.length
      ? failures[failures.length - 1]
      : last && last.href
        ? '页面一直停在加载中（' + last.href + '）'
        : '页面没有响应'
    throw new Error('打开页面失败：' + detail + '（' + url + '）')
  }

  private async attach(win: BrowserWindow) {
    const dbg = win.webContents.debugger
    if (!dbg.isAttached()) dbg.attach('1.3')
    return dbg
  }

  private async detach(win: BrowserWindow) {
    try {
      if (win.isDestroyed()) return
      // 发布流程整段会 holdDebugger（见 holdDebugger 注释），期间的 detach 一律跳过。
      if (this.debugHeld.has(win.webContents.id)) return
      if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
    } catch {
      // detach 失败不影响结果
    }
  }

  /**
   * 整段流程独占 debugger，期间 attach/detach 变成 no-op。
   *
   * 真机教训（2026-11-10 视频号）：用 DOM.setFileInputFiles 塞完文件后，只要中间 detach 过，
   * 之后所有页面取值（Runtime.evaluate 以及内部同样走 DevTools 的 executeJavaScript）都会
   * 整段挂住 —— 每次 20 秒超时、恒 null，而同一时刻从外部 CDP 连上去求值只要 3~5ms，
   * 说明页面本身没事，是本次调试会话被弄坏了。改成发布全程只 attach 一次、收尾再 detach。
   */
  private holdDebugger(win: BrowserWindow) {
    try {
      this.debugHeld.add(win.webContents.id)
    } catch {
      // 窗口已销毁，忽略
    }
  }

  private async releaseDebugger(win: BrowserWindow | null) {
    if (!win || win.isDestroyed()) return
    this.debugHeld.delete(win.webContents.id)
    await this.detach(win)
  }

  private async evalPage<T = unknown>(win: BrowserWindow, expression: string): Promise<T> {
    const res: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    })
    if (res && res.exceptionDetails) {
      const d = res.exceptionDetails
      throw new Error('页面脚本执行失败：' + (d.exception?.description || d.text || '未知错误'))
    }
    return res?.result?.value as T
  }

  private async attachAndEval<T = unknown>(win: BrowserWindow, expression: string): Promise<T> {
    if (win.isDestroyed()) throw new Error('窗口已关闭')
    await this.attach(win)
    try {
      let timer: ReturnType<typeof setTimeout> | null = null
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), EVAL_TIMEOUT_MS)
      })
      const value = await Promise.race([
        this.untilClosed(win, this.evalPage<T>(win, expression)),
        timeout
      ])
      if (timer) clearTimeout(timer)
      if (value === null) {
        if (win.isDestroyed()) throw new Error('窗口已关闭')
        this.log('页面脚本取值超时（' + Math.round(EVAL_TIMEOUT_MS / 1000) + ' 秒），按无结果处理')
        return null as unknown as T
      }
      return value as T
    } finally {
      await this.detach(win)
    }
  }

  private async shot(win: BrowserWindow, platform: string, step: string): Promise<string | null> {
    try {
      if (!win || win.isDestroyed()) return null
      let buf: Buffer | null = null
      try {
        const image = await win.webContents.capturePage()
        if (image && !image.isEmpty()) buf = image.toPNG()
      } catch {
        // capturePage 在隐藏窗口上偶发失败，走下面的 CDP 兜底
      }
      if (!buf) {
        // 真机教训：窗口 hide() 之后 capturePage() 常常返回空图（拿不到帧），
        // 截图全空等于没有诊断信息。改用 CDP Page.captureScreenshot 强制截一帧。
        try {
          await this.attach(win)
          const r: any = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' })
          if (r && r.data) buf = Buffer.from(String(r.data), 'base64')
        } catch {
          // 兜底也失败就返回 null
        }
      }
      if (!buf) return null
      const dir = join(this.deps.userDataDir, 'platform-logs')
      mkdirSync(dir, { recursive: true })
      const ts = nowIso().replace(/[:.]/g, '-')
      const file = join(dir, platform + '-' + ts + '-' + safeName(step) + '.png')
      writeFileSync(file, buf)
      return file
    } catch (e) {
      this.log('截图失败：' + errText(e))
      return null
    }
  }

  // ---------- 登录态 ----------

  /**
   * 登录态判定顺序（0.1.11 修正）：先找「否定证据」，再找「肯定证据」，都没有就**判未登录**。
   * 0.1.10 及以前最后一句是「默认已登录」，页面还没渲染完（body 为空）时会把未登录误报成已登录，
   * 用户界面显示「已登录」、真去发布才发现是登录页。
   */
  private judgeLogin(
    driver: PlatformDriver,
    probe: any,
    sessionCookieNames?: string[]
  ): { loggedIn: boolean; nickname?: string } {
    const href = String(probe?.href || '')
    if (/login|passport|signin/i.test(href)) return { loggedIn: false }
    if (probe?.qr || probe?.loginWord) return { loggedIn: false }
    const text = String(probe?.text || '')
    const nickname0 = String(probe?.nickname || '')
    // 有 httpOnly 会话 cookie 的平台（抖音）以分区 cookie 为准：页面文案里「上传视频/作品发布」这类
    // 营销词在登录墙上也会出现（2026-11-09 真机误判），cookie 里没有 sessionid 就一定没登录。
    if (driver.loggedInCookies && driver.loggedInCookies.length && sessionCookieNames) {
      const hit = driver.loggedInCookies.some((name) => sessionCookieNames.indexOf(name) >= 0)
      if (!hit) return { loggedIn: false }
      return { loggedIn: true, nickname: nickname0 }
    }
    const nickname = String(probe?.nickname || '')
    const cues = driver.loggedInCues || []
    if (cues.some((cue) => text.indexOf(cue) >= 0)) return { loggedIn: true, nickname }
    const cookies = String(probe?.cookies || '')
    const cookieHit = (driver.loggedInCookies || []).some((name) =>
      cookies.split(';').some((kv) => kv.trim().indexOf(name + '=') === 0)
    )
    if (cookieHit) return { loggedIn: true, nickname }
    if (nickname) return { loggedIn: true, nickname }
    // 页面几乎是空的 = 还没渲染出来，这不算已登录
    return { loggedIn: false }
  }

  /** 读某个平台分区里的 cookie 名（含 httpOnly）——页面里的 document.cookie 看不到 httpOnly 的 sessionid */
  private async sessionCookieNames(platform: string): Promise<string[]> {
    try {
      const ses = session.fromPartition(this.partition(platform))
      const list = await ses.cookies.get({})
      return list.map((c) => c.name)
    } catch (e) {
      this.log('[' + platform + '] 读取分区 cookie 失败：' + errText(e))
      return []
    }
  }

  /** judgeLogin 的异步版：需要区分登录墙/真登录的平台先取分区 cookie 再判定 */
  private async judgeLoginAsync(
    platform: string,
    driver: PlatformDriver,
    probe: any
  ): Promise<{ loggedIn: boolean; nickname?: string }> {
    const names =
      driver.loggedInCookies && driver.loggedInCookies.length
        ? await this.sessionCookieNames(platform)
        : undefined
    return this.judgeLogin(driver, probe, names)
  }

  /** 查一次并写缓存；页面无响应/检查失败这类不确定结果不缓存，下次还重查 */
  private async checkStatus(platform: string): Promise<PlatformStatus> {
    const st = await this.checkStatusFresh(platform)
    const uncertain = !st.loggedIn && !!st.error && /没有响应|检查失败/.test(st.error)
    if (uncertain) this.statusCache.delete(platform)
    else this.statusCache.set(platform, { at: Date.now(), status: st })
    return st
  }

  private async checkStatusFresh(platform: string): Promise<PlatformStatus> {
    const driver = this.driver(platform)
    const checkedAt = nowIso()
    let win: BrowserWindow | null = null
    try {
      win = this.ensureWindow(platform, false)
      // 视频号隐藏窗口不渲染（body 只有「视频号 · 助手」），查登录态时必须先显示窗口，否则永远判未登录
      if (driver.needsVisibleWindow) win.showInactive()
      await this.navigate(win, driver.homeUrl)
      // 页面文案要等渲染出来：空白页既没有登录标志也没有登录线索，早读会误判（0.1.11）
      let probe: any = null
      // 首页已经预热过，通常 1 秒内就有内容；查满 8 轮（≈7s）还没结果就按「无响应」处理
      for (let i = 0; i < 8; i++) {
        await sleep(i === 0 ? 600 : 900)
        probe = await this.attachAndEval<any>(win, PROBE_SCRIPT).catch(() => null)
        if (!probe) continue
        const text = String(probe.text || '')
        if (probe.loginWord || probe.qr) break
        if (text.length > 120) break
      }
      if (!probe) {
        this.emit(platform, 'status', '页面无响应')
        return {
          platform,
          name: driver.name,
          loggedIn: false,
          checkedAt,
          error: '页面没有响应，未能检查登录态，请稍后点「刷新登录状态」重试'
        }
      }
      const judged = await this.judgeLoginAsync(platform, driver, probe)
      if (judged.loggedIn) {
        this.emit(platform, 'status', '已登录' + (judged.nickname ? '（' + judged.nickname + '）' : ''))
        return { platform, name: driver.name, loggedIn: true, nickname: judged.nickname || undefined, checkedAt }
      }
      this.emit(platform, 'status', '未登录')
      return {
        platform,
        name: driver.name,
        loggedIn: false,
        checkedAt,
        error: '未检测到登录态，请扫码登录（如需处理验证码可打开调试窗口）'
      }
    } catch (e) {
      const msg = errText(e)
      this.log('[' + platform + '] 登录态检查失败：' + msg)
      return { platform, name: driver.name, loggedIn: false, checkedAt, error: '登录态检查失败：' + msg }
    } finally {
      if (driver.needsVisibleWindow && win) win.hide()
      this.closeWindow(win)
    }
  }

  private async doLogin(platform: string): Promise<PlatformStatus> {
    const driver = this.driver(platform)
    const checkedAt = nowIso()
    let win: BrowserWindow | null = null
    // 用户手动关掉登录窗口时必须立刻收工，否则轮询会一直挂到超时、串行锁不释放，
    // 表现就是「关掉弹窗后再点扫码登录没反应」。
    let userClosed = false
    try {
      win = this.ensureWindow(platform, true)
      win.once('closed', () => {
        userClosed = true
      })
      await this.navigate(win, driver.loginUrlHint || driver.homeUrl)
      const deadline = Date.now() + LOGIN_TIMEOUT_MS
      while (Date.now() < deadline) {
        if (win.isDestroyed()) break
        const probe = await this.untilClosed(
          win,
          this.attachAndEval<any>(win, PROBE_SCRIPT).catch(() => null)
        )
        if (win.isDestroyed()) break
        if (probe && (await this.judgeLoginAsync(platform, driver, probe)).loggedIn) {
          this.log('[' + platform + '] 登录成功')
          this.emit(platform, 'login', '登录成功')
          this.closeWindow(win)
          win = null
          return await this.checkStatus(platform)
        }
        await this.untilClosed(win, sleep(LOGIN_POLL_MS))
      }
      if (userClosed || win.isDestroyed()) {
        this.log('[' + platform + '] 登录窗口被关闭，取消登录')
        this.emit(platform, 'login', '窗口已关闭')
        return {
          platform,
          name: driver.name,
          loggedIn: false,
          checkedAt,
          error: '登录窗口已关闭（未完成登录），可再次点击「扫码登录」重试'
        }
      }
      this.emit(platform, 'login', '登录超时')
      return {
        platform,
        name: driver.name,
        loggedIn: false,
        checkedAt,
        error: '登录超时：' + Math.round(LOGIN_TIMEOUT_MS / 1000) + ' 秒内未检测到登录成功，请重试或打开调试窗口处理验证码'
      }
    } catch (e) {
      const msg = errText(e)
      if (userClosed || (win && win.isDestroyed())) {
        this.log('[' + platform + '] 登录窗口被关闭，取消登录')
        return {
          platform,
          name: driver.name,
          loggedIn: false,
          checkedAt,
          error: '登录窗口已关闭（未完成登录），可再次点击「扫码登录」重试'
        }
      }
      this.log('[' + platform + '] 登录失败：' + msg)
      return { platform, name: driver.name, loggedIn: false, checkedAt, error: '登录失败：' + msg }
    } finally {
      this.closeWindow(win)
    }
  }

  // ---------- 发布步骤 ----------

  private validateMedia(input: PublishInput): string[] {
    const platform = String(input.platform)
    const files = Array.isArray(input.mediaPaths)
      ? input.mediaPaths.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim())
      : []
    if (!files.length) throw new Error('素材为空：' + platform + ' 发布至少需要 1 个素材文件')
    for (const f of files) {
      if (!existsSync(f)) throw new Error('素材文件不存在：' + f)
    }
    const type = input.type === 'image' ? 'image' : 'video'
    if (type === 'video') {
      if (files.length !== 1) throw new Error('视频发布只支持 1 个素材文件，当前 ' + files.length + ' 个')
      const ext = extname(files[0]).toLowerCase()
      if (['.mp4', '.mov', '.m4v'].indexOf(ext) < 0) {
        throw new Error('视频发布只支持 mp4/mov 文件，当前：' + (ext || files[0]))
      }
    } else {
      if (files.length > 9) throw new Error('图文发布最多支持 9 张图片，当前 ' + files.length + ' 张')
      for (const f of files) {
        const ext = extname(f).toLowerCase()
        if (['.jpg', '.jpeg', '.png', '.webp'].indexOf(ext) < 0) {
          throw new Error('图文发布只支持 jpg/png/webp 图片，当前：' + f)
        }
      }
    }
    return files
  }

  /**
   * CDP 定位 input[type=file] 并塞文件；返回命中的选择器。
   *
   * 真机教训（2026-11-09 抖音图文）：上传页同时挂着两个 file input，
   * 第一个 accept 是 video/* 第二个才是 image/*。按 fileInput 候选顺序取第一个可见的，
   * 会把 jpg 塞进视频上传器 —— 抖音弹「不支持的文件格式」，页面停在发布视频 tab。
   * 所以这里先按 accept 过滤出与素材类型匹配的 input，匹配不到再退回原候选顺序。
   */
  private async uploadFiles(win: BrowserWindow, platform: string, files: string[], type: 'video' | 'image'): Promise<string> {
    const driver = this.driver(platform)
    await this.attach(win)
    try {
      const dbg = win.webContents.debugger
      const doc: any = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true })
      const rootId = doc?.root?.nodeId
      if (!rootId) throw new Error('选择器未命中：无法读取页面 DOM（' + platform + '）')
      const want = type === 'image' ? 'image' : 'video'
      const other = type === 'image' ? 'video' : 'image'
      const matches: { selector: string; idx: number; nodeId: number; accept: string }[] = []
      for (const selector of driver.fileInput) {
        try {
          const q: any = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: rootId, selector })
          const ids: number[] = (q?.nodeIds || []).filter((n: number) => n > 0)
          for (let i = 0; i < ids.length; i++) {
            const desc: any = await dbg.sendCommand('DOM.describeNode', { nodeId: ids[i] })
            if (String(desc?.node?.nodeName || '').toUpperCase() !== 'INPUT') continue
            const attrs: string[] = desc?.node?.attributes || []
            let accept = ''
            for (let a = 0; a + 1 < attrs.length; a += 2) if (attrs[a] === 'accept') accept = String(attrs[a + 1] || '')
            matches.push({ selector, idx: i, nodeId: ids[i], accept })
          }
          if (matches.length) break
        } catch {
          // 某个候选的 CSS 非法或节点失效，继续试下一个
        }
      }
      if (!matches.length) {
        // 真机（2026-11-09 视频号）：整个发表表单挂在 <wujie-app> 的 shadowRoot 里，
        // CDP 的 DOM.querySelectorAll 不进 shadow 树 ⇒ 改成在页面里找元素拿 objectId 再塞文件。
        const deep = await this.deepFileInput(win, driver.fileInput, want)
        if (!deep) {
          throw new Error('选择器未命中：未找到素材上传 input（' + platform + '），候选 ' + driver.fileInput.join(' | '))
        }
        await dbg.sendCommand('DOM.setFileInputFiles', { files, nodeId: deep.nodeId })
        return deep.selector + (deep.accept ? '（accept=' + deep.accept.slice(0, 40) + '，shadow DOM）' : '（shadow DOM）')
      }
      const prefer = matches.filter((m) => m.accept.toLowerCase().indexOf(want) >= 0)
      const usable = matches.filter((m) => m.accept.toLowerCase().indexOf(other) < 0)
      const pick = (prefer.length ? prefer : usable.length ? usable : matches)[0]
      await dbg.sendCommand('DOM.setFileInputFiles', { files, nodeId: pick.nodeId })
      return pick.selector + (pick.accept ? '（accept=' + pick.accept.slice(0, 40) + '）' : '')
    } finally {
      await this.detach(win)
    }
  }

  /**
   * 在 document + 所有 shadowRoot 里找上传 input，返回 CDP objectId（给 DOM.setFileInputFiles 用）。
   *
   * 真机（2026-11-09 视频号）：发表动态整页在 <wujie-app> 的 shadowRoot 里，
   * DOM.getDocument({pierce:true}) 拿到的 rootId 上 querySelectorAll 不会进 shadow 树，
   * 所以候选全部落空。CDP 的 setFileInputFiles 支持直接传 objectId，绕开节点树。
   */
  private async deepFileInput(
    win: BrowserWindow,
    selectors: string[],
    want: 'video' | 'image'
  ): Promise<{ nodeId: number; selector: string; accept: string } | null> {
    const expr =
      '(() => {' +
      ' const sels = ' + JSON.stringify(selectors) + ';' +
      ' const all = (sel) => {' +
      '   let hits = [];' +
      '   try { hits = Array.from(document.querySelectorAll(sel)); } catch (e) { hits = []; }' +
      '   const walk = (root) => {' +
      '     let kids = [];' +
      '     try { kids = Array.from(root.querySelectorAll("*")); } catch (e) { kids = []; }' +
      '     for (const el of kids) {' +
      '       if (!el.shadowRoot) continue;' +
      '       try { for (const h of Array.from(el.shadowRoot.querySelectorAll(sel))) hits.push(h); } catch (e) {}' +
      '       walk(el.shadowRoot);' +
      '     }' +
      '   };' +
      '   walk(document);' +
      '   return hits;' +
      ' };' +
      ' for (const sel of sels) {' +
      '   const hits = all(sel).filter((el) => el && el.tagName === "INPUT");' +
      '   if (!hits.length) continue;' +
      '   const want = ' + JSON.stringify(want) + ';' +
      '   const other = want === "image" ? "video" : "image";' +
      '   const prefer = hits.filter((el) => String(el.accept || "").toLowerCase().indexOf(want) >= 0);' +
      '   const usable = hits.filter((el) => String(el.accept || "").toLowerCase().indexOf(other) < 0);' +
      '   const pick = (prefer.length ? prefer : usable.length ? usable : hits)[0];' +
      '   return pick;' +
      ' }' +
      ' return null;' +
      '})()'
    // 注意：这里不 attach/detach —— 调用方 uploadFiles 已经 attach 了，
    // 在这里 detach 会让调用方后续的 setFileInputFiles 报 "No target available"。
    try {
      const res: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: expr,
        returnByValue: false
      })
      const objectId = res?.result?.objectId
      if (!objectId) return null
      // setFileInputFiles 的 objectId 必须能解析成 DOM Node：先开 DOM 域再 requestNode。
      await win.webContents.debugger.sendCommand('DOM.enable')
      const desc: any = await win.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function () { return String(this.accept || "") }',
        returnByValue: true
      })
      const accept = String(desc?.result?.value || '')
      const node: any = await win.webContents.debugger.sendCommand('DOM.requestNode', { objectId })
      const nodeId = Number(node?.nodeId || 0)
      if (!nodeId) return null
      return { nodeId, selector: 'input[type="file"]（shadow DOM）', accept }
    } catch (e) {
      this.log('[upload] shadow 查找上传 input 失败：' + errText(e))
      return null
    }
  }

  /**
   * 切到「发布图文 / 发布视频」tab。
   *
   * 真机教训（2026-11-09 抖音）：创作后台上传页默认停在「发布视频」，
   * 直接把 jpg 塞进去会被视频上传器拒绝（toast「不支持的文件格式」），
   * 页面永远不出现图文编辑器，标题/正文选择器全部落空。
   */
  private async switchTab(
    win: BrowserWindow,
    platform: string,
    type: 'video' | 'image',
    driver: PlatformDriver
  ): Promise<string> {
    const selectors = type === 'image' ? driver.imageTab : driver.videoTab
    if (!selectors.length) return '无需切换'
    const action = 'el.scrollIntoView({ block: "center" }); el.click();'
    await this.attach(win)
    try {
      // 真机教训：创作后台首屏先渲染「加载中，请稍候...」，tab 是异步冒出来的。
      // 只试一次会稳定失败（3 秒时页面还在 loading），所以这里轮询等 tab 出现。
      let found: any = null
      for (let i = 0; i < TAB_SWITCH_ATTEMPTS; i++) {
        found = await this.evalPage<any>(win, locateScript(selectors, action)).catch(() => null)
        if (found && found.ok) break
        await sleep(TAB_SWITCH_POLL_MS)
      }
      if (!found || !found.ok) {
        throw new Error(
          '选择器未命中：未找到' +
            (type === 'image' ? '图文' : '视频') +
            '发布 tab（' +
            platform +
            '），候选 ' +
            selectors.join(' | ') +
            '，已等待 ' +
            Math.round((TAB_SWITCH_ATTEMPTS * TAB_SWITCH_POLL_MS) / 1000) +
            ' 秒'
        )
      }
      await sleep(TAB_SWITCH_WAIT_MS)
      return '已点击 ' + found.selector
    } finally {
      await this.detach(win)
    }
  }

  private async waitUploadDone(win: BrowserWindow, platform: string): Promise<string> {
    // 排障辅助：上传完成后仍判不出来时，把页面状态落 run.log（保留最近一次状态）
    let lastState: any = null
    const started = Date.now()
    let sawActivity = false
    let poll = 0
    while (Date.now() - started < UPLOAD_TIMEOUT_MS) {
      // 真机（2026-11-10 视频号）：CDP Debugger 的 Runtime.evaluate 在文件塞进去之后会整段挂住
      // （实测每次 20 秒超时、恒 null，而同一页面用 executeJavaScript 正常），改用 executeJavaScript。
      let state: any = null
      try {
        state = await Promise.race([
          win.webContents.executeJavaScript(UPLOAD_STATE_SCRIPT, true).catch(() => null),
          sleep(EVAL_TIMEOUT_MS).then(() => null)
        ])
      } catch {
        state = null
      }
      poll++
      // 真机排障：打包版控制台看不到，必须落 run.log；只在开头几轮打，避免刷屏
      if (poll <= 3 || poll % 10 === 0) this.log('[upload] #' + poll + ' ' + JSON.stringify(state))
      if (state) lastState = state
      if (state) {
        if (state.uploading) sawActivity = true
        // 抖音图文：图片被接受后会跳到 /content/post 并渲染出编辑器，这是比「素材预览」更准的就绪信号
        if ((state.postEditor || state.editor) && !state.uploading) return '编辑器已就绪（' + (state.postEditor ? '已跳转到发布编辑页' : '检测到编辑区') + '）'
        if (state.media && !state.uploading) return '检测到素材预览，上传完成'
        if (sawActivity && !state.uploading) return '上传进度已消失，按完成处理'
      }
      await sleep(UPLOAD_POLL_MS)
    }
    throw new Error(
      '等待素材上传完成超时（' + Math.round(UPLOAD_TIMEOUT_MS / 1000) + ' 秒）：' + platform + '，请查看截图确认上传控件是否命中' + (lastState ? '。最后一次页面状态：' + JSON.stringify(lastState) : '')
    )
  }

  /** 聚焦目标元素 -> Input.insertText -> 校验；失败用 execCommand('insertText') 兜底 */
  private async fillField(
    win: BrowserWindow,
    platform: string,
    role: string,
    selectors: string[],
    text: string
  ): Promise<string> {
    const focusAction =
      'el.focus();' +
      ' if (typeof el.select === "function") { try { el.select(); } catch (e) {} }' +
      ' if (el.isContentEditable) { const range = document.createRange(); range.selectNodeContents(el);' +
      ' const sel = window.getSelection(); if (sel) { sel.removeAllRanges(); sel.addRange(range); } }'
    await this.attach(win)
    try {
      try {
        win.webContents.focus()
      } catch {
        // 隐藏窗口 focus 失败不致命
      }
      // 真机教训（2026-11-09 抖音图文）：上传完成会立刻跳到 /content/post，但表单（标题/正文）
      // 是 React 异步渲染的，1~3 秒后才出现。这里先轮询等元素出现，避免刚跳页就报「选择器未命中」。
      let appeared = false
      for (let i = 0; i < FIELD_WAIT_ATTEMPTS; i++) {
        const probe = await this.evalPage<any>(win, locateScript(selectors, 'el.setAttribute("data-fcm-ready", "1");')).catch(
          () => null
        )
        if (probe && probe.ok) {
          appeared = true
          break
        }
        if (i < FIELD_WAIT_ATTEMPTS - 1) await sleep(FIELD_WAIT_POLL_MS)
      }
      if (!appeared) {
        throw new Error(
          '选择器未命中：' +
            role +
            '输入框（' +
            platform +
            '），候选 ' +
            selectors.join(' | ') +
            '，已等待 ' +
            Math.round((FIELD_WAIT_ATTEMPTS * FIELD_WAIT_POLL_MS) / 1000) +
            ' 秒'
        )
      }
      const found = await this.evalPage<any>(win, locateScript(selectors, focusAction))
      if (!found || !found.ok) {
        throw new Error('选择器未命中：' + role + '输入框（' + platform + '），候选 ' + selectors.join(' | '))
      }
      await win.webContents.debugger.sendCommand('Input.insertText', { text })
      const ok = await this.evalPage<any>(win, verifyScript(text)).catch(() => false)
      if (ok) return '已填写，选择器 ' + found.selector + '（Input.insertText）'
      const fallbackAction = focusAction + ' document.execCommand("insertText", false, ' + JSON.stringify(text) + ');'
      const fb = await this.evalPage<any>(win, locateScript(selectors, fallbackAction))
      const again = await this.evalPage<any>(win, verifyScript(text)).catch(() => false)
      if (!again) {
        throw new Error(
          '文本填写失败：' + role + '（' + platform + '）选择器 ' + (fb?.selector || found.selector) + ' 未接收输入'
        )
      }
      return '已填写，选择器 ' + (fb?.selector || found.selector) + '（execCommand 兜底）'
    } finally {
      await this.detach(win)
    }
  }

  /** 轮询发布结果：成功提示或跳转到作品管理页才算发出去；等待期间每隔一段时间补点一次发布 */
  private async waitPublishOutcome(
    win: BrowserWindow,
    driver: PlatformDriver,
    retryClick?: () => Promise<void>
  ): Promise<string> {
    const started = Date.now()
    let last: any = null
    let lastRetry = Date.now()
    while (Date.now() - started < PUBLISH_RESULT_TIMEOUT_MS) {
      if (retryClick && Date.now() - lastRetry >= PUBLISH_RETRY_CLICK_MS) {
        lastRetry = Date.now()
        await retryClick().catch(() => undefined)
        await sleep(PUBLISH_RESULT_POLL_MS)
      }
      last = await this.attachAndEval<any>(win, outcomeScript(driver.successHint)).catch(() => null)
      if (last && last.hint) return '命中成功提示「' + last.hint + '」，页面地址 ' + last.href
      const href = String((last && last.href) || '')
      // 平台各自的「作品管理/列表」地址：抖音 /content/manage、视频号 /platform/post/list
      const urlHints = driver.successUrlHints && driver.successUrlHints.length ? driver.successUrlHints : ['/content/manage', 'publish-success']
      if (urlHints.some((h) => href.indexOf(h) >= 0)) return '已跳转到作品管理页：' + href
      await sleep(PUBLISH_RESULT_POLL_MS)
    }
    throw new Error(
      '发布结果未确认：' +
        Math.round(PUBLISH_RESULT_TIMEOUT_MS / 1000) +
        ' 秒内未检测到成功提示或跳转到作品管理页（页面地址 ' +
        String((last && last.href) || '未知') +
        '），请查看截图人工确认'
    )
  }

  /** 真实鼠标点击：CDP Input.dispatchMouseEvent（React 按钮只认真实指针事件） */
  private async mouseClickAt(win: BrowserWindow, x: number, y: number): Promise<void> {
    // 走 Electron 自己的输入通道（sendInputEvent）：窗口是隐藏的，CDP Input 域在这种情况下
    // 不一定把事件派进渲染进程（真机复现：同一坐标外部 CDP 客户端能点成功，进程内就是没反应）
    // 隐藏窗口里合成的输入事件能派到元素上（诊断日志能看到 click），但抖音的 React 提交不生效；
    // 真机对比：同一坐标由外部 CDP 点击成功 ⇒ 差异在窗口可见性，点击前先 showInactive
    const wasVisible = win.isVisible()
    if (!wasVisible) {
      win.showInactive()
      await sleep(400)
    }
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
    await sleep(120)
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    await sleep(120)
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await sleep(800)
    if (!wasVisible && !win.isDestroyed()) win.hide()
  }

  private async clickSubmit(win: BrowserWindow, platform: string): Promise<string> {
    const driver = this.driver(platform)
    await this.attach(win)
    try {
      const clickAction = 'el.scrollIntoView({ block: "center" }); el.click();'
      // 首选：真实鼠标点 <button>（el.click() 对抖音 React 按钮无效，只会让日志显示「已点击」）
      let target = await this.evalPage<any>(win, SUBMIT_TARGET_SHADOW_SCRIPT).catch(() => null)
      // 真机（2026-11-10 视频号）：普通页面与 shadow 页面统一走 shadow-aware 版本；
      // 万一它没命中（例如 candidateSel 覆盖不全），退回只扫 document 的老脚本。
      if (!target || !target.ok) {
        this.log('[click] shadow 版未命中 ' + JSON.stringify(target || null))
        target = await this.evalPage<any>(win, SUBMIT_TARGET_SCRIPT).catch(() => null)
      }
      if (target && target.ok) {
        const probe = await this.evalPage<any>(win, CLICK_PROBE_INSTALL_SCRIPT).catch(() => null)
        await this.mouseClickAt(win, target.x, target.y)
        await sleep(1500)
        const trace = await this.evalPage<any>(win, CLICK_PROBE_READ_SCRIPT).catch(() => null)
        const reached = !!(trace && trace.log && trace.log.length)
        const tip = reached ? '；已确认点击事件送达页面' : '；页面没收到鼠标事件'
        this.log('[click] ' + (reached ? '点击送达 ' : '点击未送达 ') + JSON.stringify((trace && trace.log) || []))
        void probe
        return '真实鼠标点击「' + target.text + '」（' + target.x + ',' + target.y + '）' + tip
      }
      const cssOnly = driver.submitButton.filter((s) => s.indexOf('text=') !== 0)
      // 次选：自定义元素（小红书 xhs-publish-btn 的 shadowRoot 封闭，textContent 为空串）。
      // 按元素矩形内的比例坐标做真实鼠标点击，比例由 driver.submitPoint 给出（真机：x≈0.6, y≈0.5）。
      if (cssOnly.length) {
        const box = await this.evalPage<any>(win, submitRectScript(cssOnly)).catch(() => null)
        if (box && box.ok) {
          const ratio = driver.submitPoint || { x: 0.5, y: 0.5 }
          const px = Math.round(box.left + box.width * ratio.x)
          const py = Math.round(box.top + box.height * ratio.y)
          await this.mouseClickAt(win, px, py)
          await sleep(1500)
          const trace2 = await this.evalPage<any>(win, CLICK_PROBE_READ_SCRIPT).catch(() => null)
          const reached2 = !!(trace2 && trace2.log && trace2.log.length)
          this.log('[click] 自定义元素 ' + JSON.stringify((trace2 && trace2.log) || []))
          return (
            '元素点击「' + box.selector + '」比例(' + ratio.x + ',' + ratio.y + ') → (' + px + ',' + py + ')' +
            (reached2 ? '；已确认点击事件送达页面' : '；页面没收到鼠标事件')
          )
        }
      }
      const found = cssOnly.length ? await this.evalPage<any>(win, locateScript(cssOnly, clickAction)) : null
      if (found && found.ok) return found.selector
      const fallback = await this.evalPage<any>(win, FALLBACK_SUBMIT_SCRIPT)
      if (fallback && fallback.ok) return '文本兜底：' + (fallback.text || '发布')
      throw new Error(
        '选择器未命中：未找到发布/发表按钮（' + platform + '），候选 ' + driver.submitButton.join(' | ') + '，文本兜底也未找到'
      )
    } finally {
      await this.detach(win)
    }
  }

  /** 等页面渲染出内容再判登录态：空白页既没登录线索也没二维码，直接判会误报未登录 */
  private async probeUntilReady(win: BrowserWindow): Promise<any> {
    let probe: any = null
    for (let i = 0; i < 8; i++) {
      await sleep(i === 0 ? 1200 : 1000)
      probe = await this.attachAndEval<any>(win, PROBE_SCRIPT).catch(() => null)
      if (!probe) continue
      if (probe.loginWord || probe.qr) return probe
      if (String(probe.text || '').length > 120) return probe
    }
    return probe
  }

  private async doPublish(
    platform: string,
    input: PublishInput,
    driver: PlatformDriver,
    result: PublishResult
  ): Promise<PublishResult> {
    let win: BrowserWindow | null = null
    try {
      const files = this.validateMedia(input)
      const title = clampTitle(platform, input.title)
      const body = buildContent(input.content, input.tags)
      if (!body) throw new Error('正文为空：请提供 content 或 tags')

      win = this.ensureWindow(platform, false)
      const w = win

      this.log('[publish] 开始 ' + platform + ' type=' + input.type + ' 标题=' + title)
      const run = async (name: string, fn: () => Promise<string | undefined>, critical = true) => {
        this.log('[publish] → ' + name)
        try {
          const detail = await fn()
          this.log('[publish] ✓ ' + name + (detail ? '：' + detail : ''))
          result.steps.push({ step: name, ok: true, detail })
          result.screenshots.push((await this.shot(w, platform, name)) || '')
          this.emit(platform, 'publish', name + '：成功' + (detail ? '（' + detail + '）' : ''))
          return true
        } catch (e) {
          const msg = errText(e)
          result.steps.push({ step: name, ok: false, detail: msg })
          result.screenshots.push((await this.shot(w, platform, name + '-failed')) || '')
          this.emit(platform, 'publish', name + '：失败（' + msg + '）')
          if (critical) throw e
          return false
        }
      }

      // 视频号这类页面只在窗口可见时才挂载 SPA（隐藏时 body 只有「视频号 · 助手」），
      // 否则上传控件/描述框全取不到。
      if (driver.needsVisibleWindow) {
        w.showInactive()
        await sleep(600)
      }

      // 整段独占 debugger：setFileInputFiles 之后一旦 detach 过，本会话的页面取值会全部挂住。
      this.holdDebugger(w)

      await run('打开创作后台', async () => {
        await this.navigate(w, driver.homeUrl)
        await sleep(3000)
        return '已打开 ' + driver.homeUrl
      })

      // 未登录时后台会停在扫码登录页，后面每一步都会以「选择器未命中」失败，
      // 用户看到的是一堆看不懂的选择器错误。这里先判一次登录态，给出能直接照做的中文提示。
      await run('检查登录状态', async () => {
        // SPA 后台渲染慢：真机小红书刚 navigate 完还是空白页，早判会误报「未登录」
        const probe = await this.probeUntilReady(w)
        const judged = probe ? await this.judgeLoginAsync(platform, driver, probe) : { loggedIn: false }
        if (!judged.loggedIn) {
          throw new Error('还没有登录 ' + driver.name + '：请在「发布」页点「扫码登录」完成登录后再发布')
        }
        return '已登录' + (judged.nickname ? '（' + judged.nickname + '）' : '')
      })

      const mediaType: 'video' | 'image' = input.type === 'image' ? 'image' : 'video'

      await run('切换到发布方式', async () => this.switchTab(w, platform, mediaType, driver))

      await run('上传素材', async () => {
        const selector = await this.uploadFiles(w, platform, files, mediaType)
        const detail = await this.waitUploadDone(w, platform)
        return '上传 input 命中 ' + selector + '；' + detail
      })

      if (title && driver.titleInput.length) {
        await run(
          '填写标题',
          async () => {
            return this.fillField(w, platform, '标题', driver.titleInput, title)
          },
          false
        )
      }

      await run('填写正文', async () => {
        return this.fillField(w, platform, '正文', driver.contentInput, body)
      })

      await run(
        '定时发布',
        async () => {
          const r = await this.attachAndEval<any>(w, IMMEDIATE_SCRIPT)
          return (r && r.detail) || '已按立即发布处理'
        },
        false
      )

      await run(
        '收起联想下拉',
        async () => {
          // 真机（小红书）：正文里带 #话题 时联想下拉会浮在页面上，先按 Esc 收掉再点发布
          w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
          await sleep(80)
          w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
          await sleep(400)
          return '已按 Esc'
        },
        false
      )

      await run('点击发布', async () => {
        const hit = await this.clickSubmit(w, platform)
        return '已点击发布按钮：' + hit
      })

      await run('等待发布结果', async () => {
        const detail = await this.waitPublishOutcome(w, driver, async () => {
          result.steps.push({ step: '补点发布（检测中时首次点击可能被忽略）', ok: true })
          await this.clickSubmit(w, platform)
        })
        const outcome = await this.attachAndEval<any>(w, outcomeScript(driver.successHint)).catch(() => null)
        const url = String((outcome && (outcome.link || outcome.href)) || '')
        if (url && url !== driver.homeUrl) result.url = url
        return detail
      })

      result.ok = true
      const last = result.steps[result.steps.length - 1]
      result.message = '发布成功：' + ((last && last.detail) || '')
      if (input.scheduledAt) result.message += '（定时发布未实现，已按立即发布执行）'
      const bad = result.steps.filter((s) => !s.ok)
      if (bad.length) result.message += '（有 ' + bad.length + ' 个步骤未成功：' + bad.map((s) => s.step).join('、') + '）'
      this.emit(platform, 'publish', result.message)
      return result
    } catch (e) {
      result.ok = false
      result.message = '发布失败：' + errText(e)
      this.log('[' + platform + '] ' + result.message)
      this.emit(platform, 'publish', result.message)
      return result
    } finally {
      await this.releaseDebugger(win)
      if (win && driver.needsVisibleWindow) win.hide()
      this.closeWindow(win)
    }
  }
}
