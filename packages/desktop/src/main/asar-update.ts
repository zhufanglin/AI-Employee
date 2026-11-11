/**
 * asar 热更新主进程实现（P43 P1-6）。
 *
 * 背景：整包 NSIS 静默安装一次要 6–13 分钟，而每次发版真正变化的通常只有 app.asar。
 * 这里只下载更新源上的 app.asar（改名成 .bin 规避 nginx/杀软对 .asar 的处理），
 * 校验 sha512 后替换安装目录 resources\app.asar，重启客户端即可完成升级。
 *
 * 更新源目录约定（nginx 静态目录 /opt/fcmediaagent/updates/desktop/asar/）：
 *   GET <base>/asar.json  -> { version, file, sha512, size, publishedAt, minVersion? }
 *   GET <base>/<file>     -> asar 二进制
 *
 * 安全约束：
 * - file 只允许是纯文件名（不能带路径），下载 URL 必须落在 base 的同一个 origin + 路径前缀下，
 *   防止 asar.json 被篡改后把客户端指向任意地址。
 * - 只支持 https（本地联调若显式配 http base，则跟随 base 的协议）。
 *
 * 返回统一收敛成 { ok: true, data } | { ok: false, error }（同 cron-ops.ts / strategy-ops.ts），
 * 所有异常都在主进程兜住，渲染进程永远拿得到中文错误，而不是一个 rejected Promise。
 */

import { app, type BrowserWindow, type IpcMain } from 'electron'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync
} from 'node:fs'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'

/** 默认更新源；可用 FCM_ASAR_URL 覆盖（联调时指向本地 nginx 目录） */
export const DEFAULT_ASAR_BASE = process.env.FCM_ASAR_URL || 'https://updates.fcmediaagent.com/desktop/asar'
export const MANIFEST_NAME = 'asar.json'
/** 单个 asar 的硬上限：200MB（正常 100MB 左右，超过基本是下错文件） */
export const MAX_ASAR_BYTES = 200 * 1024 * 1024
const MANIFEST_TIMEOUT_MS = 15000
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000
const RESTART_DELAY_MS = 400

export interface AsarUpdateDeps {
  /** 更新源根地址（含 /desktop/asar），默认 DEFAULT_ASAR_BASE */
  base?: string
  /** 安装前隐藏窗口用；返回当前主窗口 */
  getWindow?: () => BrowserWindow | null
}

export interface AsarManifest {
  version: string
  file: string
  /** sha512 的 base64（兼容 hex 写法） */
  sha512: string
  size: number
  publishedAt?: string
  /** 低于这个版本不能直接热更，必须先用完整安装包升级 */
  minVersion?: string
}

export interface PendingAsarUpdate {
  version: string
  file: string
  sha512: string
  size: number
  publishedAt: string | null
  minVersion: string | null
  /** 更新包已下载并通过 sha512 校验 */
  downloaded: boolean
  /** 当前版本低于 minVersion，无法热更 */
  incompatible: boolean
}

export interface AsarUpdateStatus {
  currentVersion: string
  base: string
  lastCheckAt: string | null
  pending?: PendingAsarUpdate
  canInstall: boolean
}

export type AsarOpResult<T = any> = { ok: true; data: T } | { ok: false; error: string }

function fail(message: string): AsarOpResult<never> {
  return { ok: false, error: message }
}

/** 错误信息尽量带上 cause（fetch 断网时真正的错误藏在 cause 里，只有 "fetch failed" 没法排查） */
function describeError(e: unknown): string {
  if (e instanceof Error) {
    const cause: any = (e as any).cause
    const detail = cause ? String(cause.message || cause.code || '').trim() : ''
    const message = String(e.message || e).trim() || '未知错误'
    return detail && !message.includes(detail) ? message + '（' + detail + '）' : message
  }
  if (typeof e === 'string' && e.trim()) return e.trim()
  return '未知错误'
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Error) return value.message.trim()
  return ''
}

/** 版本只比较前 3 段数字：1.2.3-beta.1 视作 1.2.3（足够判断热更包新旧） */
function parseVersion(value: unknown): [number, number, number] | null {
  const raw = String(value ?? '').trim()
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(raw)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** 比较 3 段版本号：a>b 返回 1，a<b 返回 -1，相同返回 0；无法解析时抛中文错误 */
export function compareVersion(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa) throw new Error('版本号格式不正确：' + String(a || '空'))
  if (!pb) throw new Error('版本号格式不正确：' + String(b || '空'))
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return 1
    if (pa[i] < pb[i]) return -1
  }
  return 0
}

function normalizeBase(base: string): string {
  const value = String(base || '').trim().replace(/\/+$/, '')
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('更新源必须是 http(s) 地址')
  return value
}

/** 只允许纯文件名：basename 校验 + 拒绝路径分隔符，避免 asar.json 里的 file 变成目录穿越 */
function safeFileName(file: unknown): string {
  const name = text(file)
  if (!name || name === '.' || name === '..') throw new Error('更新文件名不能为空')
  if (name !== basename(name) || /[\\/]/.test(name)) throw new Error('更新文件名不合法：' + name)
  return name
}

/** 把 file 拼到 base 下，并校验最终 URL 没有跑出 base 的 origin / 路径前缀 */
function resolveAssetUrl(base: string, file: string): string {
  const baseUrl = new URL(base)
  const url = new URL(base + '/' + encodeURIComponent(file))
  const prefix = baseUrl.pathname.replace(/\/+$/, '') + '/'
  if (url.origin !== baseUrl.origin) throw new Error('更新地址不在允许的域名范围内')
  if (!url.pathname.startsWith(prefix)) throw new Error('更新地址不在允许的目录范围内')
  return url.toString()
}

function normalizeManifest(raw: any): AsarManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('asar.json 不是对象')
  const version = text(raw.version)
  if (!parseVersion(version)) throw new Error('version 字段缺失或格式不对（应形如 0.1.25）')
  const file = safeFileName(raw.file)
  const sha512 = text(raw.sha512)
  if (!/^[A-Za-z0-9+/=_-]{40,}$/.test(sha512)) throw new Error('sha512 字段缺失或格式不对')
  const size = Number(raw.size)
  if (!Number.isFinite(size) || size <= 0) throw new Error('size 字段缺失或格式不对')
  if (size > MAX_ASAR_BYTES) throw new Error('更新包大小超过 200MB 上限，请联系管理员检查更新源')
  const publishedAt = text(raw.publishedAt)
  const minVersion = text(raw.minVersion)
  if (minVersion && !parseVersion(minVersion)) throw new Error('minVersion 字段格式不对（应形如 0.1.20）')
  return {
    version,
    file,
    sha512,
    size,
    publishedAt: publishedAt || undefined,
    minVersion: minVersion || undefined
  }
}

/** 流式计算 sha512，避免把 100MB+ 的 asar 一次读进内存 */
async function fileSha512(path: string): Promise<Buffer> {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest()
}

/** 兼容 base64 与 hex 两种写法（发布脚本默认写 base64） */
function shaMatches(expected: string, digest: Buffer): boolean {
  const value = String(expected || '').trim()
  if (!value) return false
  if (/^[a-f0-9]{128}$/i.test(value)) return value.toLowerCase() === digest.toString('hex')
  return value === digest.toString('base64')
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB'
  return bytes + ' B'
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal, headers: { 'cache-control': 'no-cache' } })
  } catch (e) {
    if ((e as any)?.name === 'AbortError') throw new Error('连接更新服务器超时，请检查网络后重试')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

export function registerAsarUpdate(ipc: IpcMain, deps: AsarUpdateDeps = {}): void {
  let base = DEFAULT_ASAR_BASE
  try {
    base = normalizeBase(deps.base || DEFAULT_ASAR_BASE)
  } catch {
    base = DEFAULT_ASAR_BASE
  }

  let lastCheckAt: string | null = null
  let pending: PendingAsarUpdate | null = null

  /** 下载落盘目录：<userData>/asar-update/<file> */
  function downloadDir(): string {
    return join(app.getPath('userData'), 'asar-update')
  }

  function pendingPath(item: PendingAsarUpdate): string {
    return join(downloadDir(), item.file)
  }

  function statusData(message?: string): AsarUpdateStatus & { message?: string } {
    const currentVersion = app.getVersion()
    let snapshot: PendingAsarUpdate | null = pending
    if (snapshot) {
      // 文件可能被用户/清理软件删掉，status 必须以磁盘为准，避免界面显示「可安装」但一点就失败
      snapshot = { ...snapshot, downloaded: snapshot.downloaded && existsSync(pendingPath(snapshot)) }
    }
    const canInstall = !!(snapshot && snapshot.downloaded && !snapshot.incompatible)
    return {
      currentVersion,
      base,
      lastCheckAt,
      ...(snapshot ? { pending: snapshot } : {}),
      canInstall,
      ...(message ? { message } : {})
    }
  }

  async function check(): Promise<AsarOpResult<AsarUpdateStatus & { latestVersion: string; updateAvailable: boolean; message: string }>> {
    lastCheckAt = new Date().toISOString()
    const url = base + '/' + MANIFEST_NAME
    let raw: any
    try {
      const res = await fetchWithTimeout(url, MANIFEST_TIMEOUT_MS)
      if (!res.ok) return fail('检查更新失败：更新服务器返回 HTTP ' + res.status)
      const rawText = await res.text()
      try {
        raw = JSON.parse(rawText)
      } catch {
        return fail('检查更新失败：更新服务器返回的 asar.json 不是合法 JSON')
      }
    } catch (e) {
      return fail('检查更新失败：' + describeError(e))
    }

    let manifest: AsarManifest
    try {
      manifest = normalizeManifest(raw)
    } catch (e) {
      return fail('更新信息格式不正确：' + describeError(e))
    }

    const currentVersion = app.getVersion()
    let cmp = 0
    try {
      cmp = compareVersion(manifest.version, currentVersion)
    } catch (e) {
      return fail('检查更新失败：' + describeError(e))
    }

    if (cmp <= 0) {
      // 服务端版本不比本地新：清掉旧 pending，避免用户装回旧包
      pending = null
      return {
        ok: true,
        data: { ...statusData('已是最新版本'), latestVersion: manifest.version, updateAvailable: false, message: '已是最新版本' }
      }
    }

    const incompatible = !!manifest.minVersion && compareVersion(currentVersion, manifest.minVersion) < 0
    const old = pending
    const existing = old && old.version === manifest.version && old.file === manifest.file && old.sha512 === manifest.sha512
    const downloaded = !!existing && existsSync(join(downloadDir(), manifest.file))
    pending = {
      version: manifest.version,
      file: manifest.file,
      sha512: manifest.sha512,
      size: manifest.size,
      publishedAt: manifest.publishedAt || null,
      minVersion: manifest.minVersion || null,
      downloaded,
      incompatible
    }
    const message = incompatible
      ? '发现新版本 ' +
        manifest.version +
        '，但当前版本 ' +
        currentVersion +
        ' 低于最低要求 ' +
        manifest.minVersion +
        '，请先用完整安装包升级'
      : '发现新版本 ' + manifest.version + '（' + formatSize(manifest.size) + '）'
    return {
      ok: true,
      data: { ...statusData(message), latestVersion: manifest.version, updateAvailable: true, message }
    }
  }

  async function download(): Promise<AsarOpResult<AsarUpdateStatus & { filePath: string; message: string }>> {
    if (!pending) return fail('还没有可下载的更新，请先点「检查更新」')
    if (pending.incompatible) {
      return fail('当前版本过低，不能直接安装这个更新包，请先下载完整安装包升级到 ' + (pending.minVersion || '要求版本'))
    }

    const item = pending
    let url: string
    try {
      url = resolveAssetUrl(base, item.file)
    } catch (e) {
      return fail('下载地址不合法：' + describeError(e))
    }

    const dir = downloadDir()
    const finalPath = join(dir, item.file)
    const tempPath = finalPath + '.part'
    try {
      mkdirSync(dir, { recursive: true })
      rmSync(tempPath, { force: true })
    } catch (e) {
      return fail('创建更新目录失败：' + describeError(e))
    }

    let res: Response
    try {
      res = await fetchWithTimeout(url, DOWNLOAD_TIMEOUT_MS)
    } catch (e) {
      return fail('下载更新失败：' + describeError(e))
    }
    if (!res.ok || !res.body) return fail('下载更新失败：更新服务器返回 HTTP ' + res.status)

    const declared = Number(res.headers.get('content-length') || 0)
    if (declared > MAX_ASAR_BYTES) {
      return fail('更新包超过 200MB 上限，已停止下载，请联系管理员检查更新源')
    }

    const hash = createHash('sha512')
    let total = 0
    const out = createWriteStream(tempPath)
    try {
      const stream = Readable.fromWeb(res.body as any)
      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any)
        total += buf.length
        if (total > MAX_ASAR_BYTES) throw new Error('更新包超过 200MB 上限，已停止下载')
        hash.update(buf)
        if (!out.write(buf)) await once(out, 'drain')
      }
      await new Promise<void>((resolve, reject) => {
        out.end((err?: Error | null) => (err ? reject(err) : resolve()))
      })
    } catch (e) {
      try {
        out.destroy()
      } catch {
        /* 忽略 */
      }
      try {
        rmSync(tempPath, { force: true })
      } catch {
        /* 忽略 */
      }
      return fail('下载更新失败：' + describeError(e))
    }

    const digest = hash.digest()
    if (!shaMatches(item.sha512, digest)) {
      try {
        rmSync(tempPath, { force: true })
        rmSync(finalPath, { force: true })
      } catch {
        /* 忽略 */
      }
      return fail('更新包校验失败（sha512 不匹配），文件已删除，请重新检查更新')
    }

    try {
      rmSync(finalPath, { force: true })
      renameSync(tempPath, finalPath)
    } catch (e) {
      try {
        rmSync(tempPath, { force: true })
      } catch {
        /* 忽略 */
      }
      return fail('保存更新包失败：' + describeError(e))
    }

    pending = { ...item, downloaded: true }
    return {
      ok: true,
      data: {
        ...statusData('更新包已下载，点「立即安装」重启客户端完成升级'),
        filePath: finalPath,
        message: '更新包已下载（' + formatSize(total) + '），点「立即安装」重启客户端完成升级'
      }
    }
  }

  async function install(): Promise<AsarOpResult<{ restarting: true; version: string; backup: string }>> {
    if (!app.isPackaged) return fail('开发模式不能安装 asar 更新，请在安装版客户端里使用')
    if (!pending) return fail('还没有可安装的更新，请先检查并下载更新')
    if (pending.incompatible) return fail('当前版本过低，不能直接安装这个更新包，请先下载完整安装包升级')

    const item = pending
    const filePath = pendingPath(item)
    if (!existsSync(filePath)) {
      pending = { ...item, downloaded: false }
      return fail('更新包不存在，请重新下载更新')
    }

    const target = join(process.resourcesPath, 'app.asar')
    if (!existsSync(target)) return fail('找不到当前客户端的 app.asar，无法安装更新，请重新安装客户端')

    // 安装前再校验一次：避免下载后文件被篡改/损坏
    let digest: Buffer
    try {
      digest = await fileSha512(filePath)
    } catch (e) {
      return fail('读取更新包失败：' + describeError(e))
    }
    if (!shaMatches(item.sha512, digest)) {
      try {
        rmSync(filePath, { force: true })
      } catch {
        /* 忽略 */
      }
      pending = { ...item, downloaded: false }
      return fail('更新包校验失败（sha512 不匹配），已删除下载文件，请重新下载')
    }

    const win = deps.getWindow?.() || null
    try {
      if (win && !win.isDestroyed()) win.hide()
    } catch {
      /* 隐藏失败不影响安装 */
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = target + '.bak-' + stamp
    let backedUp = false
    try {
      // 先 rename 再 copy：Windows 下直接覆盖正在使用的 app.asar 可能 EBUSY，rename 更稳
      try {
        renameSync(target, backup)
        backedUp = true
      } catch {
        copyFileSync(target, backup)
        rmSync(target, { force: true })
        backedUp = true
      }
      copyFileSync(filePath, target)
    } catch (e) {
      // 失败回滚：目标可能只写了一部分，先删掉再从备份恢复
      try {
        if (backedUp) {
          rmSync(target, { force: true })
          if (existsSync(backup)) copyFileSync(backup, target)
        }
      } catch {
        /* 回滚也失败时保留备份文件，至少用户手动可恢复 */
      }
      try {
        if (win && !win.isDestroyed()) win.show()
      } catch {
        /* 忽略 */
      }
      return fail('安装更新失败，已回滚到原版本：' + describeError(e))
    }

    // 安装成功：清掉已下载的更新包（备份 app.asar.bak-* 保留，用于手动回滚）
    try {
      rmSync(filePath, { force: true })
    } catch {
      /* 忽略 */
    }
    pending = { ...item, downloaded: false }

    // 稍微延迟再重启，让 IPC 结果先回到渲染进程，界面能显示「正在重启」
    setTimeout(() => {
      try {
        app.relaunch()
        app.exit(0)
      } catch {
        /* 重启失败时窗口会重新显示（用户可手动关闭） */
      }
    }, RESTART_DELAY_MS)

    return { ok: true, data: { restarting: true, version: item.version, backup } }
  }

  const guard = async <T>(label: string, task: () => Promise<AsarOpResult<T>>): Promise<AsarOpResult<T>> => {
    try {
      return await task()
    } catch (e) {
      return fail(label + '：' + describeError(e))
    }
  }

  ipc.handle('asar-update:status', () => {
    try {
      return { ok: true, data: statusData() }
    } catch (e) {
      return fail('读取 asar 更新状态失败：' + describeError(e))
    }
  })
  ipc.handle('asar-update:check', () => guard('检查更新失败', () => check()))
  ipc.handle('asar-update:download', () => guard('下载更新失败', () => download()))
  ipc.handle('asar-update:install', () => guard('安装更新失败', () => install()))
}
