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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { DRIVERS, PLATFORMS, buildContent, clampTitle, type PlatformDriver, type PlatformId } from './platform-drivers'

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
/** 单次页面取值（CDP eval）最长等待，避免 webContents 卡死时整条链路挂住 */
const EVAL_TIMEOUT_MS = 20000
/** navigate 轮询里每次页面取值的上限：页面未 commit 时 executeJavaScript 会挂着不返回 */
const NAV_EVAL_WAIT_MS = 2000
/** 「打开后台」最多等多久，超时也不报错（窗口已经开着，用户能自己看） */
const OPEN_DEBUG_TIMEOUT_MS = 20000

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
    ' const all = (sel) => { try { return Array.from(document.querySelectorAll(sel)); } catch (e) { return []; } };' +
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

// 判断登录态的页面探针：URL + cookie + 页面文案 + 二维码元素
const PROBE_SCRIPT =
  '(() => {' +
  ' const text = document.body ? document.body.innerText : "";' +
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
  ' const text = document.body ? document.body.innerText : "";' +
  ' const compact = text.replace(/\\n{2,}/g, "\\n").trim();' +
  ' const numbers = (compact.match(/[0-9][0-9.,]*\\s*(万|亿|w|播放|点赞|评论|分享|收藏|粉丝|作品|条)/g) || []).slice(0, 40);' +
  ' return { title: document.title, href: location.href, text: compact, numbers: numbers };' +
  '})()'

// 上传进度 / 素材预览探针
const UPLOAD_STATE_SCRIPT =
  '(() => {' +
  ' const text = document.body ? document.body.innerText : "";' +
  ' const words = ["上传中", "正在上传", "处理中", "转码中", "视频上传中"];' +
  ' const uploading = words.some((w) => text.indexOf(w) >= 0) || !!document.querySelector("[class*=\\"progress\\"], [class*=\\"uploading\\"], .progress-bar");' +
  ' let media = false;' +
  ' for (const el of document.querySelectorAll("video, img")) {' +
  '   const src = el.currentSrc || el.src || "";' +
  '   const r = el.getBoundingClientRect();' +
  '   if (r.width >= 80 && r.height >= 40 && (src.indexOf("blob:") === 0 || src.indexOf("data:") === 0 || src.indexOf("http") === 0)) {' +
  '     const cls = String(el.className || "") + " " + String(el.getAttribute("alt") || "");' +
  '     if (cls.indexOf("qrcode") < 0 && cls.indexOf("avatar") < 0 && cls.indexOf("logo") < 0) { media = true; break; }' +
  '   }' +
  ' }' +
  ' return { uploading: uploading, media: media };' +
  '})()'

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
function verifyScript(text: string) {
  const head = Array.from(text).slice(0, 8).join('')
  return (
    '(() => {' +
    ' const el = document.activeElement;' +
    ' if (!el) return false;' +
    ' const v = (el.value !== undefined && el.value !== null) ? String(el.value) : (el.textContent || "");' +
    ' return v.indexOf(' + JSON.stringify(head) + ') >= 0;' +
    '})()'
  )
}

/** 三个平台的发布编排器：同一平台串行互斥，所有窗口默认隐藏（login/openDebug 例外） */
export class PlatformManager {
  private readonly deps: PlatformManagerDeps
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly debugWindows = new Map<string, BrowserWindow>()

  constructor(deps: PlatformManagerDeps) {
    this.deps = deps
  }

  // ---------- 对外 API ----------

  /** 逐个平台打开隐藏窗口检查登录态；platform 留空则检查全部 */
  async status(platform?: string): Promise<PlatformStatus[]> {
    const ids = platform ? [platform] : PLATFORMS.map((p) => p.id as string)
    const out: PlatformStatus[] = []
    for (const id of ids) {
      if (!(DRIVERS as Record<string, PlatformDriver>)[id]) {
        out.push({ platform: id, name: id, loggedIn: false, checkedAt: nowIso(), error: '未知平台：' + id })
        continue
      }
      out.push(await this.runExclusive(id, () => this.checkStatus(id)))
    }
    return out
  }

  /** 打开可见窗口让用户扫码，每 3 秒轮询，最长 180 秒 */
  async login(platform: string): Promise<PlatformStatus> {
    return this.runExclusive(platform, () => this.doLogin(platform))
  }

  /** 清空该平台 partition 的登录态 */
  async logout(platform: string): Promise<void> {
    return this.runExclusive(platform, async () => {
      this.driver(platform)
      const opened = this.debugWindows.get(platform)
      if (opened) {
        this.closeWindow(opened)
        this.debugWindows.delete(platform)
      }
      const ses = session.fromPartition(this.partitionOf(platform))
      await ses.clearStorageData()
      this.log('[' + platform + '] 已清空登录态')
      this.emit(platform, 'logout', '已清空登录态')
    })
  }

  /** 打开可见窗口，方便用户手动处理滑块/验证码 */
  async openDebug(platform: string): Promise<void> {
    return this.runExclusive(platform, async () => {
      const driver = this.driver(platform)
      const existing = this.debugWindows.get(platform)
      if (existing && !existing.isDestroyed()) {
        existing.show()
        existing.focus()
        return
      }
      const win = this.createWindow(platform, true)
      this.debugWindows.set(platform, win)
      win.on('closed', () => {
        if (this.debugWindows.get(platform) === win) this.debugWindows.delete(platform)
      })
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
        win = this.createWindow(id, false)
        try {
          await this.navigate(win, driver.dataUrl)
        } catch (e) {
          this.log('[' + id + '] 数据页打不开，回落到首页：' + errText(e))
          await this.navigate(win, driver.homeUrl)
        }
        await sleep(4000)
        const probe = await this.attachAndEval<any>(win, PROBE_SCRIPT).catch(() => null)
        const judged = probe ? this.judgeLogin(driver, probe) : { loggedIn: false }
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
    // 每个平台独立分区，UA 必须挂在分区上（窗口级设置对导航不生效）
    session.fromPartition(partition).setUserAgent(PLATFORM_UA)
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
        sandbox: true
      }
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    return win
  }

  private closeWindow(win: BrowserWindow | null) {
    try {
      if (win && !win.isDestroyed()) win.destroy()
    } catch {
      // 窗口可能已被平台页面关掉
    }
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
    const deadline = Date.now() + timeoutMs
    let last: { ready: boolean; href: string; bodyLen: number } | null = null
    while (Date.now() < deadline) {
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
      if (last && last.ready && last.href && last.href !== 'about:blank') return
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
      if (!win.isDestroyed() && win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
    } catch {
      // detach 失败不影响结果
    }
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
      const image = await win.webContents.capturePage()
      if (!image || image.isEmpty()) return null
      const dir = join(this.deps.userDataDir, 'platform-logs')
      mkdirSync(dir, { recursive: true })
      const ts = nowIso().replace(/[:.]/g, '-')
      const file = join(dir, platform + '-' + ts + '-' + safeName(step) + '.png')
      writeFileSync(file, image.toPNG())
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
  private judgeLogin(driver: PlatformDriver, probe: any): { loggedIn: boolean; nickname?: string } {
    const href = String(probe?.href || '')
    if (/login|passport|signin/i.test(href)) return { loggedIn: false }
    if (probe?.qr || probe?.loginWord) return { loggedIn: false }
    const text = String(probe?.text || '')
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

  private async checkStatus(platform: string): Promise<PlatformStatus> {
    const driver = this.driver(platform)
    const checkedAt = nowIso()
    let win: BrowserWindow | null = null
    try {
      win = this.createWindow(platform, false)
      await this.navigate(win, driver.homeUrl)
      // 页面文案要等渲染出来：空白页既没有登录标志也没有登录线索，早读会误判（0.1.11）
      let probe: any = null
      for (let i = 0; i < 10; i++) {
        await sleep(1000)
        probe = await this.attachAndEval<any>(win, PROBE_SCRIPT).catch(() => null)
        if (!probe) continue
        const text = String(probe.text || '')
        if (probe.loginWord || probe.qr) break
        if (text.length > 200) break
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
      const judged = this.judgeLogin(driver, probe)
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
      win = this.createWindow(platform, true)
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
        if (probe && this.judgeLogin(driver, probe).loggedIn) {
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

  /** CDP 定位 input[type=file] 并塞文件；返回命中的选择器 */
  private async uploadFiles(win: BrowserWindow, platform: string, files: string[]): Promise<string> {
    const driver = this.driver(platform)
    await this.attach(win)
    try {
      const dbg = win.webContents.debugger
      const doc: any = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true })
      const rootId = doc?.root?.nodeId
      if (!rootId) throw new Error('选择器未命中：无法读取页面 DOM（' + platform + '）')
      for (const selector of driver.fileInput) {
        try {
          const q: any = await dbg.sendCommand('DOM.querySelector', { nodeId: rootId, selector })
          if (!q?.nodeId) continue
          const desc: any = await dbg.sendCommand('DOM.describeNode', { nodeId: q.nodeId })
          const nodeName = String(desc?.node?.nodeName || '').toUpperCase()
          if (nodeName !== 'INPUT') continue
          await dbg.sendCommand('DOM.setFileInputFiles', { files, nodeId: q.nodeId })
          return selector
        } catch {
          // 某个候选的 CSS 非法或节点失效，继续试下一个
        }
      }
      throw new Error('选择器未命中：未找到素材上传 input（' + platform + '），候选 ' + driver.fileInput.join(' | '))
    } finally {
      await this.detach(win)
    }
  }

  private async waitUploadDone(win: BrowserWindow, platform: string): Promise<string> {
    const started = Date.now()
    let sawActivity = false
    while (Date.now() - started < UPLOAD_TIMEOUT_MS) {
      const state = await this.attachAndEval<any>(win, UPLOAD_STATE_SCRIPT).catch(() => null)
      if (state) {
        if (state.uploading) sawActivity = true
        if (state.media && !state.uploading) return '检测到素材预览，上传完成'
        if (sawActivity && !state.uploading) return '上传进度已消失，按完成处理'
      }
      await sleep(UPLOAD_POLL_MS)
    }
    throw new Error(
      '等待素材上传完成超时（' + Math.round(UPLOAD_TIMEOUT_MS / 1000) + ' 秒）：' + platform + '，请查看截图确认上传控件是否命中'
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

  private async clickSubmit(win: BrowserWindow, platform: string): Promise<string> {
    const driver = this.driver(platform)
    await this.attach(win)
    try {
      const clickAction = 'el.scrollIntoView({ block: "center" }); el.click();'
      const found = await this.evalPage<any>(win, locateScript(driver.submitButton, clickAction))
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

      win = this.createWindow(platform, false)
      const w = win

      const run = async (name: string, fn: () => Promise<string | undefined>, critical = true) => {
        try {
          const detail = await fn()
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

      await run('打开创作后台', async () => {
        await this.navigate(w, driver.homeUrl)
        await sleep(3000)
        return '已打开 ' + driver.homeUrl
      })

      await run('上传素材', async () => {
        const selector = await this.uploadFiles(w, platform, files)
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

      await run('点击发布', async () => {
        const hit = await this.clickSubmit(w, platform)
        return '已点击发布按钮：' + hit
      })

      await run('等待发布结果', async () => {
        await sleep(POST_PUBLISH_WAIT_MS)
        const outcome = await this.attachAndEval<any>(w, outcomeScript(driver.successHint))
        const url = String((outcome && (outcome.link || outcome.href)) || '')
        if (url && url !== driver.homeUrl) result.url = url
        const details: string[] = []
        if (outcome?.hint) details.push('命中成功提示「' + outcome.hint + '」')
        if (result.url) details.push('页面地址 ' + result.url)
        if (!details.length) {
          throw new Error('发布结果未确认：5 秒内未检测到成功提示或页面跳转，请查看截图人工确认')
        }
        return details.join('；')
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
      this.closeWindow(win)
    }
  }
}
