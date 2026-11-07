import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { GatewayManager } from './gateway'
import { TaskExecutor } from './executor'
import { initUpdater, updateStatus, checkForUpdates, downloadUpdate, quitAndInstall } from './update'

const DEFAULT_API_BASE = process.env.FCM_API_BASE || 'https://ai.fcmediaagent.com/api'

type Settings = { apiBase: string; token?: string; user?: any; onboarded?: boolean }

let settings: Settings = { apiBase: DEFAULT_API_BASE }
let win: BrowserWindow | null = null
let gateway: GatewayManager | null = null
let heartbeatTimer: NodeJS.Timeout | null = null
let executor: TaskExecutor | null = null

function settingsPath() {
  return join(app.getPath('userData'), 'settings.json')
}

function loadSettings() {
  try {
    if (existsSync(settingsPath())) settings = { ...settings, ...JSON.parse(readFileSync(settingsPath(), 'utf8')) }
  } catch (e) {
    console.error('[settings] load failed', e)
  }
  if (!settings.apiBase) settings.apiBase = DEFAULT_API_BASE
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

async function api(path: string, init: RequestInit & { auth?: boolean } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as any) }
  if (init.auth !== false && settings.token) headers.authorization = 'Bearer ' + settings.token
  const res = await fetch(settings.apiBase + path, { ...init, headers })
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
app.on('before-quit', () => { if (heartbeatTimer) clearInterval(heartbeatTimer); executor?.stop() })
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

  ipcMain.handle('settings:get', () => ({ apiBase: settings.apiBase, user: settings.user, hasToken: !!settings.token, onboarded: !!settings.onboarded }))
  ipcMain.handle('settings:set-api-base', (_e, apiBase: string) => { settings.apiBase = apiBase; saveSettings(); return true })

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

  ipcMain.handle('employees:catalog', (_e, q: string) => api('/employees/catalog' + (q || '')))
  ipcMain.handle('employees:mine', () => api('/employees/mine'))
  ipcMain.handle('employees:install', (_e, slug: string) => api('/employees/' + encodeURIComponent(slug) + '/install', { method: 'POST', body: '{}' }))
  ipcMain.handle('employees:uninstall', (_e, slug: string) => api('/employees/' + encodeURIComponent(slug) + '/install', { method: 'DELETE' }))
  ipcMain.handle('employees:run', (_e, p: { slug: string; input: any; title?: string }) => api('/employees/' + encodeURIComponent(p.slug) + '/run', { method: 'POST', body: JSON.stringify({ input: p.input, title: p.title }) }))
  ipcMain.handle('employee-tasks:list', (_e, q: string) => api('/employee-tasks' + (q || '')))
  ipcMain.handle('employee-tasks:approve', (_e, p: { id: string; reason?: string }) => api('/employee-tasks/' + encodeURIComponent(p.id) + '/approve', { method: 'POST', body: JSON.stringify({ reason: p.reason }) }))
  ipcMain.handle('employee-tasks:reject', (_e, p: { id: string; reason?: string }) => api('/employee-tasks/' + encodeURIComponent(p.id) + '/reject', { method: 'POST', body: JSON.stringify({ reason: p.reason }) }))
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
  ipcMain.handle('workspace:remove', (_e, p: { key?: string; name?: string }) => api('/workspace/delete', { method: 'POST', body: JSON.stringify(p) }))

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

  ipcMain.handle('chat:send', async (event, p: { requestId: string; body: any }) => {
    const { requestId } = p
    const body = { ...p.body, stream: true, stream_options: { include_usage: true } }
    const res = await fetch(settings.apiBase + '/compute/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + settings.token },
      body: JSON.stringify(body)
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
    let usage: any = null
    let content = ''
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
  })

  ipcMain.handle('update:status', () => updateStatus())
  ipcMain.handle('update:check', () => checkForUpdates())
  ipcMain.handle('update:download', () => downloadUpdate())
  ipcMain.handle('update:install', () => quitAndInstall())

  ipcMain.handle('settings:mark-onboarded', () => { settings.onboarded = true; saveSettings(); return true })
  ipcMain.handle('settings:get-onboarded', () => !!settings.onboarded)

  ipcMain.handle('window:minimize', () => win?.minimize())
  ipcMain.handle('window:maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()))
  ipcMain.handle('window:close', () => win?.close())
}
