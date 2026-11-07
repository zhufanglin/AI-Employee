import { app, BrowserWindow } from 'electron'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'

export type UpdateState = {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'disabled'
  version?: string
  currentVersion: string
  percent?: number
  message?: string
  updatedAt: string
}

type InitOpts = {
  getWindow: () => BrowserWindow | null
  feedUrl?: string
  channel?: string
}

let state: UpdateState = { status: 'idle', currentVersion: '0.0.0', updatedAt: new Date().toISOString() }
const listeners = new Set<(s: UpdateState) => void>()

function emit(patch: Partial<UpdateState>) {
  state = { ...state, ...patch, currentVersion: app.getVersion(), updatedAt: new Date().toISOString() }
  for (const fn of listeners) { try { fn(state) } catch {} }
  const win = currentWin
  try { win?.webContents.send('update:status', state) } catch {}
}

let currentWin: BrowserWindow | null = null

export function updateStatus(): UpdateState {
  return state
}

export function onUpdateStatus(fn: (s: UpdateState) => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function initUpdater(opts: InitOpts) {
  state = { ...state, currentVersion: app.getVersion() }
  currentWin = opts.getWindow() ?? null
  const feedUrl = (opts.feedUrl || process.env.FCM_UPDATE_URL || 'https://updates.fcmediaagent.com/desktop').replace(/\/+$/, '')

  // 开发态没有打包产物，强制关掉自动更新，避免 electron-updater 报 "Cannot find app-update.yml"
  if (!app.isPackaged) { emit({ status: 'disabled', message: '开发模式不检查更新' }); return }

  autoUpdater.logger = {
    info: (m: any) => console.log('[updater]', m),
    warn: (m: any) => console.warn('[updater]', m),
    error: (m: any) => console.error('[updater]', m),
    debug: () => {}
  } as any
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.channel = opts.channel || 'latest'
  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl + '/latest', channel: 'latest' } as any)

  autoUpdater.on('checking-for-update', () => emit({ status: 'checking', message: '正在检查更新' }))
  autoUpdater.on('update-available', (info: any) => emit({ status: 'available', version: info?.version, message: '发现新版本 ' + info?.version }))
  autoUpdater.on('update-not-available', () => emit({ status: 'not-available', message: '已是最新版本' }))
  autoUpdater.on('download-progress', (p: any) => emit({ status: 'downloading', percent: Math.round(p?.percent || 0), message: '下载中 ' + Math.round(p?.percent || 0) + '%' }))
  autoUpdater.on('update-downloaded', (info: any) => emit({ status: 'downloaded', version: info?.version, percent: 100, message: '新版本已下载，重启后安装' }))
  autoUpdater.on('error', (e: any) => emit({ status: 'error', message: String(e?.message || e) }))

  // 启动后 15s 静默检查一次（不打扰用户，失败只记状态）
  setTimeout(() => { void checkForUpdates() }, 15000)
}

export async function checkForUpdates() {
  if (!app.isPackaged) { emit({ status: 'disabled', message: '开发模式不检查更新' }); return state }
  try {
    emit({ status: 'checking', message: '正在检查更新' })
    await autoUpdater.checkForUpdates()
  } catch (e: any) {
    emit({ status: 'error', message: String(e?.message || e) })
  }
  return state
}

export async function downloadUpdate() {
  try { await autoUpdater.downloadUpdate() } catch (e: any) { emit({ status: 'error', message: String(e?.message || e) }) }
  return state
}

export function quitAndInstall() {
  // isSilent=true：否则 electron-updater 只传 --updated --force-run，NSIS 会弹出交互式安装向导
  // （autoInstallOnAppQuit 也会触发，用户关个软件莫名弹出安装界面）；isForceRunAfter=true 装完自动拉起。
  try { autoUpdater.quitAndInstall(true, true) } catch (e: any) { emit({ status: 'error', message: String(e?.message || e) }) }
  return true
}
