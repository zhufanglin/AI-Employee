/**
 * P24 平台发布 RPA：抖音 / 小红书 / 视频号 创作后台的选择器与纯函数。
 *
 * 重要：下列选择器是按三个平台 2024-2025 年前端结构推测的候选值，尚未真机校准。
 * Electron 页面里没有 playwright 的 :has-text 伪类，文本匹配统一写成 'text=发布'
 * 这种自定义写法，由 platform.ts 用 textContent 兜底匹配。
 * 每个候选数组按可信度从高到低排列，全部命中失败时 platform.ts 会抛「选择器未命中」。
 */

export type PlatformId = 'douyin' | 'xiaohongshu' | 'shipinhao'
export type MediaType = 'video' | 'image'

export interface PlatformDriver {
  name: string
  homeUrl: string
  loginUrlHint: string
  fileInput: string[]
  titleInput: string[]
  contentInput: string[]
  submitButton: string[]
  successHint: string[]
  loggedInCookies?: string[]
  /** 已登录才会出现的页面文案（0.1.11：用来做登录态的正向证据，避免空白页被误判成已登录） */
  loggedInCues: string[]
  /** 作品数据页（0.1.11：P25 取数用，打不开就回落到 homeUrl） */
  dataUrl: string
  /** 评论管理页（P32：读评论/回评论用，打不开就回落到 homeUrl） */
  commentsUrl: string
  /** 评论条目容器候选（P32：读评论列表用，按可信度从高到低） */
  commentItems: string[]
  /** 评论条目里的「回复」按钮候选（P32：按条目范围匹配，也支持 text=回复） */
  commentReplyButton: string[]
  /** 回复输入框候选（P32：点开回复后出现） */
  commentReplyInput: string[]
  /** 发送回复按钮候选（P32） */
  commentSendButton: string[]
}

export const DRIVERS: Record<PlatformId, PlatformDriver> = {
  douyin: {
    name: '抖音',
    homeUrl: 'https://creator.douyin.com/creator-micro/content/upload',
    loginUrlHint: 'https://creator.douyin.com/',
    fileInput: ['input[type="file"]', '.upload-btn-input', 'input[accept*="video"]', 'input[accept*="image"]'],
    titleInput: ['.semi-input', 'input[placeholder*="标题"]', 'input[placeholder*="作品标题"]', '.title-input input'],
    contentInput: ['.zone-container', '[contenteditable="true"]', '.editor-kit-container [contenteditable]'],
    submitButton: ['text=发布', '.content-confirm-container button', 'button[type="submit"]'],
    successHint: ['发布成功', '作品发布成功', '发布完成', '已发布'],
    loggedInCookies: ['sessionid', 'sessionid_ss', 'sid_tt', 'passport_csrf_token'],
    loggedInCues: ['发布作品', '上传视频', '作品管理', '创作灵感', '数据概览'],
    dataUrl: 'https://creator.douyin.com/creator-micro/data/content',
    commentsUrl: 'https://creator.douyin.com/creator-micro/interaction/comment',
    commentItems: ['.comment-item', '[class*="comment-item"]', '[class*="CommentItem"]', '[class*="comment-list"] [class*="item"]'],
    commentReplyButton: ['text=回复', '[class*="reply"]', 'button[class*="reply"]', '.comment-reply-btn'],
    commentReplyInput: ['textarea[placeholder*="回复"]', '[contenteditable="true"]', 'textarea', '.comment-input textarea'],
    commentSendButton: ['text=发送', 'text=回复', 'button[class*="send"]', '.comment-send-btn']
  },
  xiaohongshu: {
    name: '小红书',
    homeUrl: 'https://creator.xiaohongshu.com/publish/publish',
    loginUrlHint: 'https://creator.xiaohongshu.com/login',
    fileInput: ['input[type="file"]', '.upload-input', 'input[accept*="video"]', 'input[accept*="image"]'],
    titleInput: ['input[placeholder*="标题"]', '.d-text', 'input[placeholder*="填写标题"]', '.title-input input'],
    contentInput: ['.ql-editor', '[contenteditable="true"]', '.editor-content', '.publish-editor [contenteditable]'],
    submitButton: ['text=发布', '.publishBtn', 'button[class*="publish"]'],
    successHint: ['发布成功', '笔记发布成功', '发布完成', '已发布'],
    loggedInCues: ['发布笔记', '上传图文', '笔记管理', '数据看板'],
    dataUrl: 'https://creator.xiaohongshu.com/new/statistics/data',
    commentsUrl: 'https://creator.xiaohongshu.com/new/interaction',
    commentItems: ['.comment-item', '[class*="comment-item"]', '[class*="CommentItem"]', '[class*="comment"] [class*="item"]'],
    commentReplyButton: ['text=回复', '[class*="reply"]', 'button[class*="reply"]', '.reply-btn'],
    commentReplyInput: ['textarea[placeholder*="回复"]', '[contenteditable="true"]', 'textarea', '[class*="reply"] textarea'],
    commentSendButton: ['text=发送', 'text=回复', 'button[class*="send"]', '[class*="reply"] button[class*="primary"]']
  },
  shipinhao: {
    name: '视频号',
    homeUrl: 'https://channels.weixin.qq.com/platform/post/create',
    loginUrlHint: 'https://channels.weixin.qq.com/platform',
    fileInput: ['input[type="file"]', '.weui-desktop-upload__input', 'input[accept*="video"]', 'input[accept*="image"]'],
    titleInput: ['input[placeholder*="标题"]', 'input[placeholder*="填写标题"]', '.weui-desktop-form__input'],
    contentInput: ['.input-editor', '[contenteditable="true"]', '.weui-desktop-editor', '.post-desc [contenteditable]'],
    submitButton: ['text=发表', '.weui-desktop-btn_primary', 'button[class*="primary"]'],
    successHint: ['发表成功', '发布成功', '发表完成', '已发表'],
    loggedInCues: ['发表动态', '上传视频', '内容管理', '数据中心'],
    dataUrl: 'https://channels.weixin.qq.com/platform/statistics',
    commentsUrl: 'https://channels.weixin.qq.com/platform/interaction/comment',
    commentItems: ['.comment-item', '[class*="comment-item"]', '[class*="CommentItem"]', '[class*="comment_list"] [class*="item"]'],
    commentReplyButton: ['text=回复', '[class*="reply"]', 'button[class*="reply"]', '.weui-desktop-link_primary'],
    commentReplyInput: ['textarea[placeholder*="回复"]', '[contenteditable="true"]', 'textarea', '.weui-desktop-form__textarea'],
    commentSendButton: ['text=发送', 'text=回复', 'text=发表', '.weui-desktop-btn_primary', 'button[class*="send"]']
  }
}

/** 平台清单：渲染层与 status() 默认遍历用 */
export const PLATFORMS: { id: PlatformId; name: string; homeUrl: string; types: MediaType[] }[] = [
  { id: 'douyin', name: '抖音', homeUrl: DRIVERS.douyin.homeUrl, types: ['video', 'image'] },
  { id: 'xiaohongshu', name: '小红书', homeUrl: DRIVERS.xiaohongshu.homeUrl, types: ['video', 'image'] },
  { id: 'shipinhao', name: '视频号', homeUrl: DRIVERS.shipinhao.homeUrl, types: ['video', 'image'] }
]

/** 标题字数上限（按字符数 Array.from 计，中文/emoji 各算 1 个） */
export const TITLE_LIMITS: Record<string, number> = { douyin: 30, xiaohongshu: 20, shipinhao: 16 }

/** 正文 + 空格 + '#tag1 #tag2'；标签去掉首尾 #、去空、去重、最多 10 个 */
export function buildContent(content: string, tags?: string[]): string {
  const body = typeof content === 'string' ? content.trim() : ''
  const clean: string[] = []
  const list = Array.isArray(tags) ? tags : []
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim().replace(/^#+/, '').replace(/#+$/, '').trim()
    if (!tag) continue
    if (clean.indexOf(tag) >= 0) continue
    clean.push(tag)
    if (clean.length >= 10) break
  }
  const tagText = clean.map((t) => '#' + t).join(' ')
  return [body, tagText].filter(Boolean).join(' ').trim()
}

/** 标题按平台上限截断（Array.from 按字符数，不是 UTF-16 码元） */
export function clampTitle(platform: string, title?: string): string {
  const raw = typeof title === 'string' ? title.trim() : ''
  if (!raw) return ''
  const limit = TITLE_LIMITS[platform] || 30
  return Array.from(raw).slice(0, limit).join('')
}

/** 平台是否支持指定发布类型 */
export function platformSupports(platform: string, type: string): boolean {
  const row = PLATFORMS.find((p) => p.id === platform)
  return !!row && row.types.indexOf(type as MediaType) >= 0
}
// ---------- P32 评论回复：页面脚本生成器（纯函数，可单测） ----------

/** 单条回复的字数上限（三个平台都在 300~1000，取保守值） */
export const COMMENT_TEXT_MAX = 500
/** 一次最多读回来的评论条目数 */
export const COMMENT_ITEMS_MAX = 50

const VISIBLE_FN =
  'const __visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect();' +
  ' if (r.width <= 0 || r.height <= 0) return false; const st = window.getComputedStyle(el);' +
  ' return st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0"; };'

function collectItemsScript(driver: PlatformDriver): string {
  return (
    'const sels = ' + JSON.stringify(driver.commentItems) + ';' +
    ' const all = (sel) => { try { return Array.from(document.querySelectorAll(sel)); } catch (e) { return []; } };' +
    ' const norm = (el) => ((el && (el.innerText || el.textContent)) || "").replace(/\\s+/g, " ").trim();' +
    ' let scanNodes = []; let used = "";' +
    ' for (const sel of sels) { const hits = all(sel).filter(__visible); if (hits.length) { scanNodes = hits; used = sel; break; } }' +
    ' const seen = new Set(); const scanItems = [];' +
    ' for (const node of scanNodes) {' +
    '   const text = norm(node);' +
    '   if (text.length < 2 || text.length > 600) continue;' +
    '   if (seen.has(text)) continue;' +
    '   seen.add(text);' +
    '   scanItems.push({ index: scanItems.length, text: text });' +
    '   if (scanItems.length >= ' + COMMENT_ITEMS_MAX + ') break;' +
    ' }' +
    ' const scanResult = { items: scanItems, nodes: scanNodes, selector: used };'
  )
}

/** 读评论列表的页面脚本：返回 { ok, title, href, selector, items:[{index,text}] } */
export function scanCommentsScript(driver: PlatformDriver): string {
  return (
    '(() => {' +
    VISIBLE_FN +
    collectItemsScript(driver) +
    ' return { ok: scanResult.items.length > 0, title: document.title || "", href: location.href, selector: scanResult.selector, items: scanResult.items, total: scanResult.nodes.length };' +
    '})()'
  )
}

/**
 * 定位某条评论并在它的范围内点「回复」的页面脚本。
 * target.match 按文本包含匹配；target.index 按扫描顺序（0 起）。
 * 先把条目滚进视野，再在条目内按候选找按钮（没找到就找文本含「回复」的可点元素）。
 */
export function clickReplyScript(driver: PlatformDriver, target: { index?: number; match?: string }): string {
  const buttons = JSON.stringify(driver.commentReplyButton)
  const match = JSON.stringify(target.match || '')
  const index = Number.isFinite(Number(target.index)) ? Number(target.index) : -1
  return (
    '(() => {' +
    VISIBLE_FN +
    collectItemsScript(driver) +
    ' const items = scanResult.items; const nodes = scanResult.nodes;' +
    ' if (!items.length) return { ok: false, error: "没读到评论列表（页面结构可能变了，或还没登录）" };' +
    ' const want = ' + match + ';' +
    ' const idx = ' + index + ';' +
    ' let hit = -1;' +
    ' if (want) { hit = items.findIndex((it) => it.text.indexOf(want) >= 0); }' +
    ' if (hit < 0 && idx >= 0 && idx < items.length) hit = idx;' +
    ' if (hit < 0) return { ok: false, error: "没找到要回复的评论（共 " + items.length + " 条）", items: items.slice(0, 20) };' +
    ' const el = nodes[hit];' +
    ' el.scrollIntoView({ block: "center" });' +
    ' const cands = ' + buttons + ';' +
    ' const norm2 = (n) => ((n && n.textContent) || "").replace(/\\s+/g, "");' +
    ' let btn = null; let usedSel = "";' +
    ' for (const sel of cands) {' +
    '   const scope = (sel.indexOf("text=") === 0) ? null : (() => { try { return Array.from(el.querySelectorAll(sel)).filter(__visible); } catch (e) { return []; } })();' +
    '   if (scope && scope.length) { btn = scope[0]; usedSel = sel; break; }' +
    '   if (sel.indexOf("text=") === 0) {' +
    '     const word = sel.slice(5).trim();' +
    '     const inner = Array.from(el.querySelectorAll("button, a, span, div, [role=\\"button\\"]")).filter((n) => __visible(n) && norm2(n) === word);' +
    '     if (inner.length) { btn = inner[inner.length - 1]; usedSel = sel; break; }' +
    '   }' +
    ' }' +
    ' if (!btn) {' +
    '   const loose = Array.from(el.querySelectorAll("button, a, span, div, [role=\\"button\\"]")).filter((n) => __visible(n) && norm2(n).indexOf("回复") >= 0 && norm2(n).length <= 8);' +
    '   if (loose.length) { btn = loose[loose.length - 1]; usedSel = "文本兜底:回复"; }' +
    ' }' +
    ' if (!btn) return { ok: false, error: "这条评论里没找到「回复」按钮", text: items[hit].text };' +
    ' try { btn.click(); } catch (e) { return { ok: false, error: "点击回复失败：" + String((e && e.message) || e), text: items[hit].text }; }' +
    ' return { ok: true, text: items[hit].text, selector: usedSel, index: hit };' +
    '})()'
  )
}

/** 回复结果探针：成功提示文案 or 输入框已清空 */
export function replyOutcomeScript(driver: PlatformDriver, replyText: string): string {
  return (
    '(() => {' +
    VISIBLE_FN +
    ' const text = document.body ? document.body.innerText : "";' +
    ' const hints = ["回复成功", "评论成功", "已回复", "发送成功"];' +
    ' let hint = "";' +
    ' for (const h of hints) { if (text.indexOf(h) >= 0) { hint = h; break; } }' +
    ' const boxes = Array.from(document.querySelectorAll(' + JSON.stringify(driver.commentReplyInput) + ')).filter(__visible);' +
    ' let cleared = false;' +
    ' for (const b of boxes) {' +
    '   const v = (b.value !== undefined && b.value !== null) ? String(b.value) : (b.textContent || "");' +
    '   if (!v.trim()) { cleared = true; break; }' +
    ' }' +
    ' const still = ' + JSON.stringify(Array.from(replyText).slice(0, 8).join('')) + ';' +
    ' const echoed = still ? text.indexOf(still) >= 0 : false;' +
    ' return { hint: hint, cleared: cleared, echoed: echoed };' +
    '})()'
  )
}
