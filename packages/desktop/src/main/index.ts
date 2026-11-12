import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { GatewayManager } from './gateway'
import { TaskExecutor } from './executor'
import { initUpdater, updateStatus, checkForUpdates, downloadUpdate, quitAndInstall } from './update'
import { PlatformManager } from './platform'
import { registerFileOps } from './file-ops'
import { registerCronOps } from './cron-ops'
import { registerMarketOps } from './market-ops'
import { registerStrategyOps } from './strategy-ops'
import { registerAsarUpdate } from './asar-update'
import { installConsoleFileLog, registerLogOps } from './log-ops'
import { PublishQueue, defaultQueuePath, registerPublishQueue } from './publish-queue'

// P43 P1-7：主进程日志同时追加一份到 app.getPath('logs')/main.log。
// 这里尽早安装（只包一层 console，不立即写盘），连 app.whenReady 之前的日志也能落到文件；
// 真正的目录解析在第一次写日志时惰性进行，避免 app ready 前访问 getPath 抛错。
installConsoleFileLog()

const DEFAULT_API_BASE = process.env.FCM_API_BASE || 'https://ai.fcmediaagent.com/api'

// P45 合规：服务端 /api/legal 拿不到版本时的兜底（只用于离线时仍能展示条款入口，不替代服务端正文）
const LEGAL_FALLBACK_VERSION = '2026-11-12'
const LEGAL_FALLBACK_DOCS = [
  { key: 'terms', title: '用户协议', updatedAt: LEGAL_FALLBACK_VERSION },
  { key: 'privacy', title: '隐私政策', updatedAt: LEGAL_FALLBACK_VERSION },
  { key: 'aigc', title: 'AI 生成内容标识说明', updatedAt: LEGAL_FALLBACK_VERSION }
]

type Settings = { apiBase: string; token?: string; user?: any; onboarded?: boolean; legalAcceptedVersion?: string }

let settings: Settings = { apiBase: DEFAULT_API_BASE }
let win: BrowserWindow | null = null
let gateway: GatewayManager | null = null
let heartbeatTimer: NodeJS.Timeout | null = null
let executor: TaskExecutor | null = null
let platform: PlatformManager | null = null
let queue: PublishQueue | null = null
let queueTimer: NodeJS.Timeout | null = null

// P0-2 对话中断：send 时把 requestId 对应的 AbortController 存进来，chat:abort 用它取消 fetch/流读取。
const chatAborts = new Map<string, AbortController>()

function settingsPath() {
  return join(app.getPath('userData'), 'settings.json')
}

/** 本机回环地址：只可能是开发/冒烟时留下的，装好的客户端连它必然 fetch failed */
function isLoopbackBase(base: string) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(String(base || '').trim())
}

function loadSettings() {
  try {
    if (existsSync(settingsPath())) settings = { ...settings, ...JSON.parse(readFileSync(settingsPath(), 'utf8')) }
  } catch (e) {
    console.error('[settings] load failed', e)
  }
  if (!settings.apiBase) settings.apiBase = DEFAULT_API_BASE
  // 0.1.10：安装版里如果残留了 127.0.0.1/localhost 的服务端地址（开发、冒烟测试的历史配置），
  // 用户会遇到「auth:sms-send: TypeError: fetch failed」这种看不出原因的报错，这里直接纠正回默认地址。
  if (!process.env.FCM_API_BASE && app.isPackaged && isLoopbackBase(settings.apiBase)) {
    console.warn('[settings] 本地回环地址在安装版不可用，已改回默认服务端：' + settings.apiBase + ' -> ' + DEFAULT_API_BASE)
    settings.apiBase = DEFAULT_API_BASE
    saveSettings()
  }
}

function saveSettings() {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8')
  } catch (e) {
    console.error('[settings] save failed', e)
  }
}

function executionDeviceId() {
  return 'desktop-' + createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 16)
}

async function sendExecutionHeartbeat() {
  if (!settings.token) return
  try {
    await api('/employee-execution/heartbeat', { method: 'POST', body: JSON.stringify({ deviceId: executionDeviceId(), executor: 'desktop', metadata: { platform: process.platform, version: app.getVersion() } }) })
  } catch (e) { console.warn('[employee-execution] heartbeat failed', e) }
}

// 本机专属能力：平台发布走用户电脑上的浏览器，服务端只做登记（见 docs/handoff/P24-平台发布RPA-契约.md）。
const LOCAL_CAPABILITIES = new Set(['platform_publish', 'platform_status', 'platform_stats'])

function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(/[,，\n]/).map((v) => v.trim()).filter(Boolean)
  return []
}

async function runLocalCapability(name: string, params: any) {
  const args = params && typeof params === 'object' ? params : {}
  try {
    if (!platform) throw new Error('平台发布模块尚未就绪，请重启客户端')
    if (name === 'platform_publish') {
      const input = {
        platform: String(args.platform || '').trim(),
        type: args.type === 'image' ? 'image' : 'video',
        title: typeof args.title === 'string' ? args.title : '',
        content: typeof args.content === 'string' ? args.content : '',
        tags: toList(args.tags),
        mediaPaths: toList(args.mediaPaths || args.media),
        scheduledAt: typeof args.scheduledAt === 'string' ? args.scheduledAt : undefined
      }
      if (!input.platform) throw new Error('platform 必填（douyin / xiaohongshu / shipinhao）')
      if (!input.mediaPaths.length) throw new Error('mediaPaths 必填：请给出本机素材文件路径')
      const result = await platform.publish(input as any)
      return { success: true, data: result }
    }
    if (name === 'platform_status') {
      return { success: true, data: { items: await platform.status(args.platform ? String(args.platform) : undefined) } }
    }
    if (name === 'platform_stats') {
      const result = await platform.stats(String(args.platform || ''), { maxChars: Number(args.maxChars) || undefined })
      if (!result.loggedIn) throw new Error(result.message)
      return { success: true, data: result }
    }
    throw new Error('未知的本机能力：' + name)
  } catch (error: any) {
    return { success: false, error: String(error?.message || error) }
  }
}

async function api(path: string, init: RequestInit & { auth?: boolean } = {}) {
  if (path === '/capabilities/run' && typeof init.body === 'string') {
    try {
      const payload = JSON.parse(init.body)
      if (payload && LOCAL_CAPABILITIES.has(String(payload.name))) return await runLocalCapability(String(payload.name), payload.params)
    } catch { /* 非 JSON 体按普通请求转发 */ }
  }
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as any) }
  if (init.auth !== false && settings.token) headers.authorization = 'Bearer ' + settings.token
  let res: Response
  try {
    res = await fetch(settings.apiBase + path, { ...init, headers })
  } catch (e: any) {
    // fetch 的网络层失败（DNS/连接被拒/断网）原始信息只有 "fetch failed"，用户完全无从下手
    const reason = String(e?.cause?.message || e?.message || e)
    throw new Error('连不上服务器（' + settings.apiBase + '）：' + reason + '。请检查网络，或到「设置」里更换服务器地址')
  }
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || ('HTTP ' + res.status)
    throw new Error(msg)
  }
  return body
}

async function smokeLogin() {
  const phone = process.env.FCM_SMOKE_PHONE
  if (!phone) return
  const s = await api('/auth/sms/send', { method: 'POST', auth: false, body: JSON.stringify({ phone }) })
  const r = await api('/auth/sms/login', { method: 'POST', auth: false, body: JSON.stringify({ phone, code: s.devCode }) })
  settings.token = r.accessToken
  settings.user = r.user
  console.log('[smoke] logged in as', r.user?.phone)
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#0f1115',
    title: '中科元晟 AI 员工',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win?.show())
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log('[renderer:' + level + '] ' + message + ' (' + sourceId + ':' + line + ')')
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.log('[did-fail-load] ' + code + ' ' + desc + ' ' + url))
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })

  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  loadSettings()
  registerIpc()
  if (process.env.FCM_SMOKE_PHONE) { try { await smokeLogin() } catch (e) { console.error('[smoke] login failed', e) } }
  createWindow()
  initUpdater({ getWindow: () => win, feedUrl: process.env.FCM_UPDATE_URL, channel: process.env.FCM_UPDATE_CHANNEL })
  heartbeatTimer = setInterval(() => { void sendExecutionHeartbeat() }, 30000)
  void sendExecutionHeartbeat()
  executor?.start()
  if (process.env.FCM_SMOKE_OUT) runSmoke()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('before-quit', async () => { try { await gateway?.stop() } catch {} })
app.on('before-quit', () => { if (heartbeatTimer) clearInterval(heartbeatTimer); if (queueTimer) clearInterval(queueTimer); executor?.stop(); platform?.disposeAll() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

function runSmoke() {
  const out = process.env.FCM_SMOKE_OUT!
  if (process.env.FCM_SMOKE_CHAT === '1') {
    setTimeout(async () => {
      try {
        const script = `(() => {
          const ta = document.querySelector('textarea');
          if (!ta) return 'no-textarea';
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(ta, '用一句话介绍你自己');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('发送'));
          if (!btn) return 'no-button';
          btn.click();
          return 'sent';
        })()`
        console.log('[smoke] chat:', await win!.webContents.executeJavaScript(script))
      } catch (e: any) { console.log('[smoke] chat error', e?.message) }
    }, 5000)
  }
  if (process.env.FCM_SMOKE_EXECUTOR === '1') {
    setTimeout(async () => {
      try {
        const slug = process.env.FCM_SMOKE_EMPLOYEE || 'boss-lead-radar'
        await api('/employees/' + encodeURIComponent(slug) + '/install', { method: 'POST', body: '{}' })
        const task = await api('/employees/' + encodeURIComponent(slug) + '/run', {
          method: 'POST',
          body: JSON.stringify({ executor: 'desktop', title: '冒烟：执行器自检', input: '用三条要点说明你今天能为老板做的事' })
        })
        console.log('[smoke] executor task queued', task.id)
        writeFileSync(out + '.executor.json', JSON.stringify({ taskId: task.id }, null, 2), 'utf8')
      } catch (e: any) {
        console.error('[smoke] executor enqueue failed', e?.message)
        writeFileSync(out + '.executor.json', JSON.stringify({ error: String(e?.message || e) }, null, 2), 'utf8')
      }
    }, 2500)
  }
  if (process.env.FCM_SMOKE_MEDIA === '1') {
    setTimeout(async () => {
      try {
        const mode = process.env.FCM_SMOKE_MEDIA_MODE || '文生图'
        const prompt = process.env.FCM_SMOKE_MEDIA_PROMPT || '一只橘猫坐在窗台上，阳光，写实摄影'
        const script = `(async () => {
          const navBtn = [...document.querySelectorAll('nav button')].find((b) => b.textContent.includes('${mode}'));
          if (!navBtn) return 'no-nav';
          navBtn.click();
          await new Promise((r) => setTimeout(r, 800));
          const ta = document.querySelector('textarea');
          if (!ta) return 'no-textarea';
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(ta, '${prompt}');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 400));
          const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('开始生成'));
          if (!btn) return 'no-submit';
          btn.click();
          return 'submitted';
        })()`
        console.log('[smoke] media:', await win!.webContents.executeJavaScript(script))
      } catch (e: any) { console.log('[smoke] media error', e?.message) }
    }, 6000)
  }
  setTimeout(async () => {
    const result: any = { ts: new Date().toISOString() }
    if (process.env.FCM_SMOKE_EXECUTOR === '1') {
      try {
        const r = await api('/employee-tasks?limit=5')
        result.tasks = (r?.items || []).map((t: any) => ({ id: t.id, status: t.status, title: t.title, outputText: (t.outputText || '').slice(0, 300), error: t.error || null, artifacts: (t.artifacts || []).length }))
        result.executor = executor?.status()
      } catch (e: any) { result.executorError = String(e?.message || e) }
    }
    try {
      if (win) {
        const img = await win.webContents.capturePage()
        writeFileSync(out + '.png', img.toPNG())
        result.screenshot = out + '.png'
      }
      if (process.env.FCM_SMOKE_GATEWAY === '1') {
        result.gateway = await gateway!.start()
        for (let i = 0; i < 50; i++) {
          await new Promise((r) => setTimeout(r, 2000))
          const s = await gateway!.statusNow()
          if (s.healthy) { result.gateway = s; break }
          result.gateway = s
        }
        result.gatewayLogs = gateway!.recentLogs().slice(-40)
      }
    } catch (e: any) {
      result.error = String(e?.message || e)
    }
    if (process.env.FCM_SMOKE_MEDIA === '1') {
      try {
        if (win) {
          result.mediaText = await win.webContents.executeJavaScript("(document.querySelector('main') || document.body).innerText.slice(0, 1200)")
          result.mediaImgs = await win.webContents.executeJavaScript("[...document.querySelectorAll('main img, main video')].map((el) => el.getAttribute('src')).slice(0, 3)")
        }
        const b = await api('/credits/balance')
        result.creditBalance = b?.balance
      } catch (e: any) { result.mediaError = String(e?.message || e) }
    }
    try { writeFileSync(out + '.json', JSON.stringify(result, null, 2), 'utf8') } catch {}
    app.quit()
  }, Number(process.env.FCM_SMOKE_MS || 8000))
}

/**
 * 定时发布的心跳：每 30 秒看一次本地队列，把到点（含客户端关着时错过的）任务串行发出去。
 * 启动时先等 20 秒，让平台模块/登录态就绪，避免刚开机就抢窗口。
 */
function startQueueTimer() {
  if (queueTimer) return
  setTimeout(() => { void tickQueue('startup') }, 20000)
  queueTimer = setInterval(() => { void tickQueue('timer') }, 30000)
}

async function tickQueue(reason: string) {
  if (!queue) return
  try {
    const ran = await queue.tick()
    if (ran.length > 0) console.log('[queue] ' + reason + ' 执行了 ' + ran.length + ' 条定时发布')
  } catch (e: any) {
    console.warn('[queue] tick failed', e?.message || e)
  }
}

function registerIpc() {
  gateway = new GatewayManager({
    getApiBase: () => settings.apiBase,
    getProxyToken: async () => {
      const r = await api('/volcengine/proxy-token', { method: 'POST', body: '{}' })
      return r.token
    },
    getModels: async () => {
      const r = await api('/compute/models')
      const arr = Array.isArray(r) ? r : (r?.data || [])
      return arr.map((m: any) => ({ id: m.id, name: m.name }))
    },
    getInstalledEmployees: async () => {
      const r = await api('/employees/mine')
      return (r?.items || []).filter((item: any) => item?.install?.effectiveEnabled).map((item: any) => item.slug)
    }
  })

  ipcMain.handle('gateway:status', () => gateway!.statusNow())
  ipcMain.handle('gateway:start', () => gateway!.start())
  ipcMain.handle('gateway:stop', () => gateway!.stop())
  ipcMain.handle('gateway:restart', () => gateway!.restart())
  ipcMain.handle('gateway:logs', () => gateway!.recentLogs())
  ipcMain.handle('gateway:control-url', async () => {
    const s = await gateway!.statusNow()
    return 'http://127.0.0.1:' + s.port + '/'
  })

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    apiBase: settings.apiBase
  }))

  ipcMain.handle('settings:get', () => ({
    apiBase: settings.apiBase,
    user: settings.user,
    hasToken: !!settings.token,
    onboarded: !!settings.onboarded,
    // P45 合规：客户端记录用户同意的条款版本；版本号变了（协议更新）会重新弹一次同意
    legalAcceptedVersion: settings.legalAcceptedVersion || ''
  }))
  ipcMain.handle('settings:set-api-base', (_e, apiBase: string) => { settings.apiBase = apiBase; saveSettings(); return true })

  // P45 合规基线：协议/隐私/AIGC 说明的版本元信息、外链打开、同意记录。
  // 版本号由服务端给出（服务端改了条款正文，版本号会变，客户端就会重新弹同意）。
  ipcMain.handle('legal:meta', async () => {
    try {
      const r = await api('/legal', { auth: false })
      return { ok: true, version: String(r?.version || ''), docs: Array.isArray(r?.docs) ? r.docs : [] }
    } catch (e: any) {
      // 网络不通时不能让用户卡在启动页：用内置兜底版本号，页面本身仍可点开（打开的是线上地址）
      return { ok: false, version: LEGAL_FALLBACK_VERSION, docs: LEGAL_FALLBACK_DOCS, error: String(e?.message || e) }
    }
  })
  ipcMain.handle('legal:accept', (_e, version: string) => {
    settings.legalAcceptedVersion = String(version || LEGAL_FALLBACK_VERSION)
    saveSettings()
    return { ok: true, legalAcceptedVersion: settings.legalAcceptedVersion }
  })
  ipcMain.handle('legal:open', async (_e, key: string) => {
    const path = '/legal/' + String(key || 'terms').replace(/[^a-z-]/gi, '')
    const origin = settings.apiBase.replace(/\/api\/?$/, '')
    const url = origin + '/api' + path
    await shell.openExternal(url)
    return { ok: true, url }
  })

  ipcMain.handle('auth:sms-send', (_e, phone: string) => api('/auth/sms/send', { method: 'POST', auth: false, body: JSON.stringify({ phone }) }))
  ipcMain.handle('auth:sms-login', async (_e, p: { phone: string; code: string }) => {
    const r = await api('/auth/sms/login', { method: 'POST', auth: false, body: JSON.stringify(p) })
    settings.token = r.accessToken; settings.user = r.user; saveSettings(); return r
  })
  ipcMain.handle('auth:password-login', async (_e, p: { username: string; password: string }) => {
    const r = await api('/auth/login', { method: 'POST', auth: false, body: JSON.stringify(p) })
    settings.token = r.accessToken; settings.user = r.user; saveSettings(); return r
  })
  ipcMain.handle('auth:logout', async () => {
    try { await gateway?.stop() } catch {}
    settings.token = undefined; settings.user = undefined; saveSettings(); return true
  })
  ipcMain.handle('auth:me', () => api('/auth/me'))

  ipcMain.handle('site:config', () => api('/site/config', { auth: false }))
  ipcMain.handle('compute:models', async () => {
    const r = await api('/compute/models')
    return Array.isArray(r) ? r : (r?.data || [])
  })
  ipcMain.handle('credits:balance', () => api('/credits/balance'))
  ipcMain.handle('credits:usage-records', (_e, q: string) => api('/credits/ai-usage-records' + (q || '')))
  // 兑换码与套餐（P43）：服务端 /packages/redeem 与 /packages/mine 早就实现了，
  // 但客户端一直没有入口 —— 用户从运营那里拿到兑换码之后无处激活。
  // 这里统一返回 { ok, data } / { ok, error }，把服务端的中文校验原因原样交给界面。
  const packageCall = async (path: string, init: any = {}) => {
    try {
      return { ok: true, data: await api(path, init) }
    } catch (e: any) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }
  ipcMain.handle('packages:presets', () => packageCall('/packages/presets', { auth: false }))
  ipcMain.handle('packages:mine', () => packageCall('/packages/mine'))
  ipcMain.handle('packages:redeem', (_e, code: string) =>
    packageCall('/packages/redeem', { method: 'POST', body: JSON.stringify({ code }) })
  )

  ipcMain.handle('employees:catalog', (_e, q: string) => api('/employees/catalog' + (q || '')))
  ipcMain.handle('employees:mine', () => api('/employees/mine'))
  ipcMain.handle('employees:install', (_e, slug: string) => api('/employees/' + encodeURIComponent(slug) + '/install', { method: 'POST', body: '{}' }))
  ipcMain.handle('employees:uninstall', (_e, slug: string) => api('/employees/' + encodeURIComponent(slug) + '/install', { method: 'DELETE' }))
  ipcMain.handle('employees:run', (_e, p: { slug: string; input: any; title?: string }) => api('/employees/' + encodeURIComponent(p.slug) + '/run', { method: 'POST', body: JSON.stringify({ input: p.input, title: p.title }) }))
  ipcMain.handle('employee-tasks:list', (_e, q: string) => api('/employee-tasks' + (q || '')))
  ipcMain.handle('employee-tasks:approve', (_e, p: { id: string; reason?: string }) => api('/employee-tasks/' + encodeURIComponent(p.id) + '/approve', { method: 'POST', body: JSON.stringify({ reason: p.reason }) }))
  ipcMain.handle('employee-tasks:reject', (_e, p: { id: string; reason?: string }) => api('/employee-tasks/' + encodeURIComponent(p.id) + '/reject', { method: 'POST', body: JSON.stringify({ reason: p.reason }) }))
  // 平台发布：每个平台一个持久化 partition，用户扫码登录一次即可长期复用。
  platform = new PlatformManager({
    userDataDir: app.getPath('userData'),
    // 真机校准：隐藏窗口里的日志在打包版控制台看不到，同步落一份文件便于排查卡在哪一步
    log: (message: string) => {
      console.log('[platform] ' + message)
      try {
        const dir = join(app.getPath('userData'), 'platform-logs')
        mkdirSync(dir, { recursive: true })
        appendFileSync(join(dir, 'run.log'), new Date().toISOString() + ' ' + message + '\n')
      } catch {
        // 落盘失败不影响主流程
      }
    }
  })
  // 平台类 IPC 统一兜底。Electron 的窗口 / webContents / session 一旦被销毁（用户点了窗口的 X、
  // 应用正在退出、上一个流程 destroy 了窗口），再被访问就会抛
  // TypeError: Object has been destroyed —— 原样冒到界面就是用户看到的
  // 「Error invoking remote method 'platform:status': TypeError: Object has been destroyed」。
  // 这里记一条带堆栈的日志（下次真发生能直接定位），并把错误换成人话。
  const guardPlatform = (name: string, fn: () => unknown) => async () => {
    try {
      return await fn()
    } catch (e: any) {
      const raw = String((e && e.message) || e)
      try {
        const dir = join(app.getPath('userData'), 'platform-logs')
        mkdirSync(dir, { recursive: true })
        appendFileSync(
          join(dir, 'run.log'),
          new Date().toISOString() + ' [ipc] ' + name + ' 失败：' + String((e && e.stack) || raw) + '\n'
        )
      } catch {
        // 落盘失败不影响主流程
      }
      if (/Object has been destroyed|has been destroyed|已关闭/.test(raw)) {
        throw new Error('平台窗口已关闭或渲染进程已退出（' + raw + '），请点「刷新登录状态」重试')
      }
      throw new Error(raw)
    }
  }
  ipcMain.handle('platform:warm', (_e, p: { platform?: string }) => guardPlatform('warm', () => {
    platform!.warmUp(p?.platform)
    return { ok: true }
  })())
  ipcMain.handle('platform:status', (_e, p: { platform?: string; force?: boolean }) => guardPlatform('status', () =>
    platform!.status(p?.platform, { maxAgeMs: p?.force ? 0 : undefined })
  )())
  ipcMain.handle('platform:login', (_e, p: { platform: string }) => guardPlatform('login', () => platform!.login(p.platform))())
  ipcMain.handle('platform:logout', (_e, p: { platform: string }) => guardPlatform('logout', async () => {
    await platform!.logout(p.platform)
    return { ok: true }
  })())
  ipcMain.handle('platform:publish', (_e, input: any) => guardPlatform('publish', () => platform!.publish(input))())
  ipcMain.handle('platform:stats', (_e, p: { platform: string; maxChars?: number }) => guardPlatform('stats', () =>
    platform!.stats(p?.platform, { maxChars: p?.maxChars })
  )())
  ipcMain.handle('platform:comments', (_e, p: { platform: string; maxItems?: number }) => guardPlatform('comments', () =>
    platform!.comments(p?.platform, { maxItems: p?.maxItems })
  )())
  ipcMain.handle('platform:reply-comment', (_e, p: { platform: string; index?: number; match?: string; text?: string }) => guardPlatform('reply-comment', () =>
    platform!.replyComment(p?.platform, { index: p?.index, match: p?.match, text: p?.text })
  )())
  ipcMain.handle('platform:open-debug', (_e, p: { platform: string }) => guardPlatform('open-debug', async () => {
    await platform!.openDebug(p.platform)
    return { ok: true }
  })())
  // P30 接线：把数据快照的整页文本交给服务端纯函数解析成结构化指标（能力失败也是 HTTP 201，看 body.success）
  ipcMain.handle('platform:parse-metrics', async (_e, p: { platform?: string; text?: string }) => {
    try {
      const body = await api('/capabilities/run', {
        method: 'POST',
        body: JSON.stringify({
          name: 'platform_metrics_parse',
          params: { platform: String(p?.platform || ''), text: String(p?.text || '') }
        })
      })
      if (body && body.success === false) return { ok: false, error: String((body.error && body.error.message) || body.error || '解析失败') }
      return { ok: true, data: body && body.data !== undefined ? body.data : body }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })
  ipcMain.handle('platform:pick-media', async (_e, p: { type?: 'video' | 'image' }) => {
    if (!win) return { paths: [] }
    const image = p?.type === 'image'
    const picked = await dialog.showOpenDialog(win, {
      title: image ? '选择要发布的图片' : '选择要发布的视频',
      properties: ['openFile', image ? 'multiSelections' : undefined].filter(Boolean) as any,
      filters: image ? [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] : [{ name: '视频', extensions: ['mp4', 'mov', 'm4v'] }]
    })
    if (picked.canceled) return { paths: [] }
    return { paths: picked.filePaths }
  })

  // 工作区文件管理（P27）：只允许在 <userData>/workspace 里读写，路径越界一律拒绝。
  const workspaceRoot = () => join(app.getPath('userData'), 'workspace')
  mkdirSync(workspaceRoot(), { recursive: true })
  registerFileOps(ipcMain, { root: workspaceRoot })
  // 员工定时任务（P27）：客户端直接调服务端 cron 接口，列表/新建/删除。
  registerCronOps(ipcMain, { api })
  // 员工商城（P44-B1）：列表 / 购买时长 / 下单 / 我的订单 / 查单轮询 / 发起支付 / 安装。
  registerMarketOps(ipcMain, { api })
  // 战略与人设（P42）：老板填一份战略长文 + 一张人设表，员工接活时按岗位读取。
  registerStrategyOps(ipcMain, { api })
  // asar 热更新（P43 P1-6）：只替换安装目录 resources/app.asar，替代 6–13 分钟的整包 NSIS 安装。
  // 更新源固定为 https://updates.fcmediaagent.com/desktop/asar，可用 FCM_ASAR_URL 覆盖。
  registerAsarUpdate(ipcMain, { getWindow: () => win })
  // 客户端日志（P43 P1-7）：日志目录用 app.getPath('logs')，目录不存在时由模块自动创建。
  registerLogOps(ipcMain, { dir: () => app.getPath('logs') })

  // 定时发布（P26）：发布内容必须存在本机（平台按 IP/设备风控，且服务端定时表不存内容），
  // 队列落在 <userData>/publish-queue.json，到点由主进程触发 platform.publish。
  queue = new PublishQueue({
    file: () => defaultQueuePath(app.getPath('userData')),
    publish: (input: any) => platform!.publish(input),
    // 发布前登录态预检：queue 会传 maxAgeMs: 0 绕过 PlatformManager 的 5 分钟缓存（STATUS_CACHE_MS）。
    status: (id: string, opts?: { maxAgeMs?: number }) => platform!.status(id, opts),
    log: (message: string) => console.log('[queue] ' + message),
    notify: (event: string, payload: any) => {
      if (win && !win.isDestroyed()) win.webContents.send('queue:event', { event, payload })
    }
  })
  registerPublishQueue(ipcMain, queue)
  startQueueTimer()

  executor = new TaskExecutor({ api, getToken: () => settings.token })
  ipcMain.handle('employee-execution:heartbeat', () => sendExecutionHeartbeat().then(() => true))
  ipcMain.handle('employee-execution:status', () => executor!.status())
  ipcMain.handle('employee-execution:tick', () => executor!.tick())
  ipcMain.handle('employee-execution:start', () => executor!.start())
  ipcMain.handle('employee-execution:stop', () => executor!.stop())
  ipcMain.handle('employee-execution:nodes', () => api('/employee-execution/nodes'))

  // 工作区资料：用户上传表格/PDF/Word/文本，员工在任务里用 file_list / doc_read 读取。
  ipcMain.handle('workspace:pick', async () => {
    if (!win) return { items: [] }
    const picked = await dialog.showOpenDialog(win, {
      title: '选择要交给员工的资料',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '文档资料', extensions: ['md', 'txt', 'csv', 'json', 'html', 'xml', 'log', 'xlsx', 'xls', 'docx', 'pdf'] },
        { name: '图片与音视频', extensions: ['png', 'jpg', 'jpeg', 'webp', 'mp3', 'wav', 'm4a', 'mp4', 'mov'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    if (picked.canceled || !picked.filePaths.length) return { items: [] }
    const items: any[] = []
    for (const file of picked.filePaths) {
      const bytes = readFileSync(file)
      if (bytes.byteLength > 20 * 1024 * 1024) throw new Error(basename(file) + ' 超过 20MB，请拆分后再上传')
      items.push(await api('/workspace/upload', { method: 'POST', body: JSON.stringify({ name: basename(file), base64: bytes.toString('base64') }) }))
    }
    return { items }
  })
  ipcMain.handle('workspace:list', (_e, limit?: number) => api('/workspace/files?limit=' + encodeURIComponent(String(limit || 50))))
  ipcMain.handle('workspace:download', async (_e, file: { key: string; name: string }) => {
    if (!settings.token) throw new Error('请先登录')
    const result = await dialog.showSaveDialog({ defaultPath: basename(file.name) })
    if (result.canceled || !result.filePath) return { canceled: true }
    const response = await fetch(settings.apiBase + '/workspace/download?key=' + encodeURIComponent(file.key), { headers: { authorization: 'Bearer ' + settings.token } })
    if (!response.ok) throw new Error('下载失败（HTTP ' + response.status + '）')
    writeFileSync(result.filePath, Buffer.from(await response.arrayBuffer()))
    return { canceled: false }
  })
  ipcMain.handle('workspace:remove', (_e, p: { key?: string; name?: string }) => api('/workspace/delete', { method: 'POST', body: JSON.stringify(p) }))

  // 长期记忆：查询 / 统计 / 删除 / 手动合并 / 查重（服务端见 packages/server/src/memory）。
  ipcMain.handle('memory:list', (_e, q: { query?: string; kind?: string; limit?: number; cursor?: string } = {}) => {
    const params = new URLSearchParams()
    if (q.query) params.set('query', q.query)
    if (q.kind) params.set('kind', q.kind)
    if (q.limit) params.set('limit', String(q.limit))
    if (q.cursor) params.set('cursor', q.cursor)
    const qs = params.toString()
    return api('/memory/list' + (qs ? '?' + qs : ''))
  })
  ipcMain.handle('memory:stats', () => api('/memory/stats'))
  ipcMain.handle('memory:remove', (_e, id: string) => api('/memory/' + encodeURIComponent(id), { method: 'DELETE' }))
  ipcMain.handle('memory:merge', (_e, p: { keepId: string; dropId: string }) => api('/memory/merge', { method: 'POST', body: JSON.stringify({ keepId: p.keepId, dropId: p.dropId }) }))
  ipcMain.handle('memory:dedupe', (_e, p: { mode?: 'report' | 'apply'; limit?: number } = {}) => api('/memory/dedupe', { method: 'POST', body: JSON.stringify({ mode: p.mode, limit: p.limit }) }))

  // 媒体生产（数字人 / 音色克隆 / 音频素材）：编排在服务端，这里只做转发。
  ipcMain.handle('media:upload', (_e, p: { fileName: string; mime: string; base64: string }) => api('/media/files/upload', { method: 'POST', body: JSON.stringify(p) }))
  ipcMain.handle('media:image', (_e, body: unknown) => api('/media/images/generations', { method: 'POST', body: JSON.stringify(body) }))
  ipcMain.handle('media:video', (_e, body: unknown) => api('/media/video/generations', { method: 'POST', body: JSON.stringify(body) }))
  ipcMain.handle('media:task', (_e, id: string) => api('/media/tasks/' + encodeURIComponent(id)))
  ipcMain.handle('media:cancel', (_e, id: string) => api('/media/tasks/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: JSON.stringify({}) }))
  ipcMain.handle('media:compose-create', (_e, body: any) => api('/compose-videos', { method: 'POST', body: JSON.stringify(body) }))
  ipcMain.handle('media:compose-list', (_e, q: string) => api('/compose-videos' + (q || '')))
  ipcMain.handle('media:compose-remove', (_e, id: string) => api('/compose-videos/' + encodeURIComponent(id), { method: 'DELETE' }))
  ipcMain.handle('media:compose-transfer', (_e, id: string) => api('/compose-videos/' + encodeURIComponent(id) + '/transfer-oss', { method: 'POST', body: '{}' }))
  ipcMain.handle('media:clone-create', (_e, body: any) => api('/clone-records', { method: 'POST', body: JSON.stringify(body) }))
  ipcMain.handle('media:clone-list', (_e, q: string) => api('/clone-records' + (q || '')))
  ipcMain.handle('media:clone-remove', (_e, id: string) => api('/clone-records/' + encodeURIComponent(id), { method: 'DELETE' }))
  ipcMain.handle('media:audio-list', () => api('/audio-materials'))
  ipcMain.handle('media:audio-upload', (_e, body: any) => api('/audio-materials/upload', { method: 'POST', body: JSON.stringify(body) }))
  ipcMain.handle('media:audio-remove', (_e, id: string) => api('/audio-materials/' + encodeURIComponent(id), { method: 'DELETE' }))

  // 个人微信 UIAutomation bridge；未配置时由服务端返回 WECHAT_UIA_NOT_CONFIGURED。
  ipcMain.handle('channel:personal-wechat-status', () => api('/channels/personal-wechat/status'))
  ipcMain.handle('channel:personal-wechat-contacts', () => api('/channels/personal-wechat/contacts'))
  ipcMain.handle('channel:personal-wechat-messages', (_e, p: { chatName: string; wxId?: string }) => {
    const q = new URLSearchParams({ chat_name: p.chatName }); if (p.wxId) q.set('wx_id', p.wxId)
    return api('/channels/personal-wechat/messages?' + q.toString())
  })
  ipcMain.handle('channel:personal-wechat-send', (_e, p: { name: string; msg: string; humanize?: boolean }) => api('/channels/personal-wechat/send', { method: 'POST', body: JSON.stringify(p) }))
  ipcMain.handle('channel:personal-wechat-send-file', (_e, p: { name: string; filePath?: string; fileUrl?: string; humanize?: boolean }) => api('/channels/personal-wechat/send-file', { method: 'POST', body: JSON.stringify({ name: p.name, file_path: p.filePath, file_url: p.fileUrl, humanize: p.humanize }) }))
  ipcMain.handle('channel:personal-wechat-listen', (_e, p: { wxid?: string; nickname?: string }) => api('/channels/personal-wechat/listen', { method: 'POST', body: JSON.stringify(p) }))

  // 对话流式调用（chat:send / chat:send-with-media 共用）
  const runChatStream = async (event: any, requestId: string, bodyIn: any) => {
    const body = { ...bodyIn, stream: true, stream_options: { include_usage: true } }
    const controller = new AbortController()
    chatAborts.set(requestId, controller)
    let usage: any = null
    let content = ''
    try {
      const res = await fetch(settings.apiBase + '/compute/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + settings.token },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (!res.ok) {
        const text = await res.text()
        let msg = 'HTTP ' + res.status
        try { const j = JSON.parse(text); msg = j?.error?.message || j?.message || msg } catch {}
        event.sender.send('chat:error', { requestId, message: msg, status: res.status })
        throw new Error(msg)
      }
      const reader = (res.body as any).getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const raw of lines) {
          const line = raw.trim()
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') continue
          try {
            const j = JSON.parse(data)
            if (j.usage) usage = j.usage
            const delta = j.choices?.[0]?.delta?.content || ''
            if (delta) { content += delta; event.sender.send('chat:chunk', { requestId, delta }) }
          } catch {}
        }
      }
      event.sender.send('chat:done', { requestId, usage, content })
      return { usage, content }
    } catch (e: any) {
      // 用户点「停止」时 fetch / reader 抛 AbortError：这不是失败，按正常结束回传已生成的内容。
      if (e?.name === 'AbortError') {
        event.sender.send('chat:done', { requestId, usage, content, aborted: true })
        return { usage, content, aborted: true }
      }
      throw e
    } finally {
      chatAborts.delete(requestId)
    }
  }

  ipcMain.handle('chat:send', (event, p: { requestId: string; body: any }) => runChatStream(event, p.requestId, p.body))

  // chat:send-with-media（P43 P1）——原版可以带图片/文件一起发。
  // 做法：先把附件传到服务端工作区，再把「资料已上传」写进最后一条用户消息，员工/模型可用 doc_read 读。
  ipcMain.handle('chat:send-with-media', async (event, p: { requestId: string; body: any; attachments?: Array<{ name: string; mime?: string; base64: string }> }) => {
    const body = JSON.parse(JSON.stringify(p.body || {}))
    const attachments = Array.isArray(p.attachments) ? p.attachments : []
    const uploaded: string[] = []
    for (const file of attachments) {
      if (!file?.base64) continue
      const bytes = Buffer.from(String(file.base64), 'base64')
      if (bytes.byteLength > 20 * 1024 * 1024) throw new Error(String(file.name || '附件') + ' 超过 20MB，请拆分后再上传')
      await api('/workspace/upload', { method: 'POST', body: JSON.stringify({ name: file.name, base64: String(file.base64) }) })
      uploaded.push(String(file.name))
    }
    if (uploaded.length) {
      const note = '（已上传资料到工作区：' + uploaded.join('、') + '，需要时可用 file_list / doc_read 读取）'
      const messages = Array.isArray(body.messages) ? body.messages : []
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') { messages[i].content = String(messages[i].content || '') + '\n' + note; break }
      }
      body.messages = messages
    }
    return runChatStream(event, p.requestId, body)
  })

  // chat:abort —— 只取消还在生成中的请求；已经结束的返回 false。
  ipcMain.handle('chat:abort', (_e, requestId: string) => {
    const controller = chatAborts.get(requestId)
    if (!controller) return false
    controller.abort()
    return true
  })

  // P0-2 会话持久化：把服务端 /chat/sessions 系列接口包成 IPC（api() 的 base 已含 /api）。
  ipcMain.handle('chat:sessions', (_e, limit?: number) => {
    const n = Math.max(1, Math.min(100, Math.floor(Number(limit) || 30)))
    return api('/chat/sessions?limit=' + n)
  })
  ipcMain.handle('chat:session-create', (_e, p: { model?: string; title?: string } = {}) =>
    api('/chat/sessions', { method: 'POST', body: JSON.stringify({ model: p?.model, title: p?.title }) })
  )
  ipcMain.handle('chat:session-get', (_e, id: string) => api('/chat/sessions/' + encodeURIComponent(id)))
  ipcMain.handle('chat:session-rename', (_e, p: { id: string; patch?: { title?: string; model?: string } }) =>
    api('/chat/sessions/' + encodeURIComponent(p.id), { method: 'PATCH', body: JSON.stringify(p.patch || {}) })
  )
  ipcMain.handle('chat:session-remove', (_e, id: string) =>
    api('/chat/sessions/' + encodeURIComponent(id), { method: 'DELETE' })
  )
  ipcMain.handle('chat:session-append', (_e, p: { id: string; messages: any[] }) =>
    api('/chat/sessions/' + encodeURIComponent(p.id) + '/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: p.messages || [] })
    })
  )

  // 原版叫 session:delete，我们内部叫 chat:session-remove，这里补一个别名方便老调用方
  ipcMain.handle('session:delete', (_e, id: string) =>
    api('/chat/sessions/' + encodeURIComponent(id), { method: 'DELETE' })
  )

  ipcMain.handle('update:status', () => updateStatus())
  ipcMain.handle('update:check', () => checkForUpdates())
  ipcMain.handle('update:download', () => downloadUpdate())
  ipcMain.handle('update:install', () => quitAndInstall())

  // dialog:save（P43 P1）——把一段文本另存到用户选定的位置（原版对话框保存能力）
  ipcMain.handle('dialog:save', async (_e, p: { defaultName?: string; content?: string; extension?: string } = {}) => {
    const ext = (p.extension || 'md').replace(/^\./, '')
    const result = await dialog.showSaveDialog({ defaultPath: p.defaultName || '导出.' + ext })
    if (result.canceled || !result.filePath) return { canceled: true }
    writeFileSync(result.filePath, String(p.content ?? ''), 'utf8')
    return { canceled: false, path: result.filePath }
  })

  // settings:reset（P43 P1）——恢复默认设置，但保留登录态（避免误点被踢下线）
  ipcMain.handle('settings:reset', () => {
    settings.apiBase = DEFAULT_API_BASE
    settings.onboarded = false
    delete (settings as any).apiBaseOverride
    saveSettings()
    return { apiBase: settings.apiBase, hasToken: !!settings.token, onboarded: false }
  })

  ipcMain.handle('settings:mark-onboarded', () => { settings.onboarded = true; saveSettings(); return true })
  ipcMain.handle('settings:get-onboarded', () => !!settings.onboarded)

  ipcMain.handle('window:minimize', () => win?.minimize())
  ipcMain.handle('window:maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()))
  ipcMain.handle('window:close', () => win?.close())
}
