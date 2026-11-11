/**
 * 客户端日志查看（P43 P1-7）。
 *
 * 原版有 log:getRecent / log:readFile / log:getFilePath / log:getDir / log:listFiles 5 个 IPC，
 * 复刻版此前日志只散落在 userData/platform-logs 与各模块的 console 里，用户遇到问题无法自助排查。
 *
 * 这里做两件事：
 * 1. 把主进程现有 console 输出（log/info/warn/error/debug）再追加一份到 <logs>/main.log，
 *    已有日志直接续写，不覆盖。落盘失败时静默丢弃，绝不能再打日志造成递归。
 * 2. 注册 5 个 IPC，统一返回 { ok, data?, error? }。文件名一律先做 basename 校验，
 *    只允许读取日志目录下的文件，防止 ../ 目录穿越。
 */

import { app, type IpcMain } from 'electron'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { inspect } from 'node:util'

export interface LogOpsDeps {
  /** 日志目录；传函数便于 app ready 后再取 app.getPath('logs') */
  dir: string | (() => string)
}

export interface LogFileItem {
  name: string
  size: number
  /** 修改时间（毫秒时间戳） */
  mtime: number
}

export type LogOpResult<T = any> = { ok: true; data: T } | { ok: false; error: string }

export const MAIN_LOG = 'main.log'
export const DEFAULT_RECENT_LINES = 200
export const MAX_RECENT_LINES = 2000
export const DEFAULT_READ_BYTES = 256 * 1024
export const MAX_READ_BYTES = 2 * 1024 * 1024

function fail(message: string): LogOpResult<never> {
  return { ok: false, error: message }
}

function describeError(e: unknown): string {
  if (e instanceof Error) return String(e.message || e).trim() || '未知错误'
  if (typeof e === 'string' && e.trim()) return e.trim()
  return '未知错误'
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 日志目录不存在时自动创建：用户第一次打开日志区块就能用 */
function ensureDir(depsDir: LogOpsDeps['dir']): string {
  const value = typeof depsDir === 'function' ? depsDir() : depsDir
  const dir = String(value || '').trim()
  if (!dir) throw new Error('日志目录未配置')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 只接受纯文件名：拒绝 a/b、a\b、.. 等写法。
 * 渲染层传绝对路径时会先取 basename，既兼容「从列表点进来」，又不会越出日志目录。
 */
function safeFileName(name: unknown, dir: string): string {
  const raw = String(name ?? '').trim()
  const value = raw ? basename(raw) : MAIN_LOG
  if (!value || value === '.' || value === '..') throw new Error('日志文件名不合法')
  if (/[\\/]/.test(value) || value !== basename(value)) throw new Error('日志文件名不合法，不能包含路径')
  const full = join(dir, value)
  // 双保险：join 之后父目录必须还是日志目录
  if (basename(full) !== value) throw new Error('日志文件名不合法，不能包含路径')
  return value
}

function readFirstBytes(path: string, maxBytes: number): { text: string; bytes: number; size: number } {
  const size = statSync(path).size
  const bytes = Math.min(size, maxBytes)
  if (bytes <= 0) return { text: '', bytes: 0, size }
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const read = readSync(fd, buf, 0, bytes, 0)
    return { text: buf.subarray(0, read).toString('utf8'), bytes: read, size }
  } finally {
    closeSync(fd)
  }
}

/**
 * 从文件尾部往前读，直到凑够 lines 行或读满 16MB。
 * 不能简单 readFileSync：main.log 跑久了可能几十 MB。
 */
function readTailLines(path: string, maxLines: number): { lines: string[]; truncated: boolean; size: number } {
  const size = statSync(path).size
  if (size <= 0) return { lines: [], truncated: false, size }

  let readSize = Math.min(size, 64 * 1024)
  const hardLimit = 16 * 1024 * 1024
  while (true) {
    const fd = openSync(path, 'r')
    let text = ''
    try {
      const buf = Buffer.alloc(readSize)
      const read = readSync(fd, buf, 0, readSize, size - readSize)
      text = buf.subarray(0, read).toString('utf8')
    } finally {
      closeSync(fd)
    }

    const lines = text.split(/\r?\n/)
    // 不是从文件开头读的，第一行大概率是被截断的半行，丢掉
    if (readSize < size) lines.shift()
    if (lines.length && lines[lines.length - 1] === '') lines.pop()

    if (lines.length >= maxLines || readSize >= size || readSize >= hardLimit) {
      const truncated = readSize < size || lines.length > maxLines
      return {
        lines: lines.length > maxLines ? lines.slice(-maxLines) : lines,
        truncated,
        size
      }
    }
    readSize = Math.min(size, readSize * 2)
  }
}

export function registerLogOps(ipc: IpcMain, deps: LogOpsDeps): void {
  const guard = async <T>(task: () => T | Promise<T>): Promise<LogOpResult<T>> => {
    try {
      return { ok: true, data: await task() }
    } catch (e) {
      return fail('读取日志失败：' + describeError(e))
    }
  }

  ipc.handle('log:getDir', () =>
    guard(() => {
      const dir = ensureDir(deps.dir)
      return { dir }
    })
  )

  ipc.handle('log:getFilePath', () =>
    guard(() => {
      const dir = ensureDir(deps.dir)
      const path = join(dir, MAIN_LOG)
      return { path, name: MAIN_LOG, exists: existsSync(path) }
    })
  )

  ipc.handle('log:listFiles', () =>
    guard(() => {
      const dir = ensureDir(deps.dir)
      const items: LogFileItem[] = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const full = join(dir, entry.name)
          const st = statSync(full)
          return { name: entry.name, size: st.size, mtime: st.mtimeMs }
        })
        .sort((a, b) => b.mtime - a.mtime)
      return { dir, items }
    })
  )

  ipc.handle('log:getRecent', (_event, input?: { lines?: number; file?: string }) =>
    guard(() => {
      const dir = ensureDir(deps.dir)
      const theme = String(input?.file ?? '')
      const name = safeFileName(theme, dir)
      const path = join(dir, name)
      if (!existsSync(path)) throw new Error('日志文件不存在：' + name)
      const maxLines = clampInt(input?.lines, DEFAULT_RECENT_LINES, 1, MAX_RECENT_LINES)
      const result = readTailLines(path, maxLines)
      return { file: name, path, lines: result.lines, truncated: result.truncated, size: result.size }
    })
  )

  ipc.handle('log:readFile', (_event, input?: { name?: string; path?: string; maxBytes?: number }) =>
    guard(() => {
      const dir = ensureDir(deps.dir)
      const theme = String(input?.name ?? input?.path ?? '')
      const name = safeFileName(theme, dir)
      const path = join(dir, name)
      if (!existsSync(path)) throw new Error('日志文件不存在：' + name)
      const maxBytes = clampInt(input?.maxBytes, DEFAULT_READ_BYTES, 1, MAX_READ_BYTES)
      const result = readFirstBytes(path, maxBytes)
      return {
        file: name,
        path,
        text: result.text.replace(/^\uFEFF/, ''),
        size: result.size,
        bytes: result.bytes,
        truncated: result.bytes < result.size
      }
    })
  )
}

// ---------------------------------------------------------------------------
// 主进程 console -> main.log 落盘
// ---------------------------------------------------------------------------

let fileLoggingInstalled = false
let logDirResolver: (() => string) | null = null
let cachedLogDir: string | null = null
const writeFailedOnce = new Set<string>()

function resolveLogDir(): string {
  if (cachedLogDir) return cachedLogDir
  const dir = logDirResolver ? logDirResolver() : app.getPath('logs')
  const value = String(dir || '').trim()
  if (!value) throw new Error('日志目录未配置')
  if (!existsSync(value)) mkdirSync(value, { recursive: true })
  cachedLogDir = value
  return value
}

function formatArg(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return String(value.stack || value.message || value)
  try {
    return inspect(value, { depth: 3, breakLength: 200, maxStringLength: 4000 })
  } catch {
    return String(value)
  }
}

function appendConsoleLine(level: string, args: unknown[]): void {
  try {
    const file = join(resolveLogDir(), MAIN_LOG)
    const line = new Date().toISOString() + ' [' + level.toUpperCase() + '] ' + args.map(formatArg).join(' ') + '\n'
    appendFileSync(file, line, 'utf8')
  } catch (e) {
    // 关键：这里绝对不能 console.error，否则写入失败 -> 打日志 -> 再写入失败，无限递归。
    // 同一类错误只记录一次哨兵，避免每行日志都做无谓的字符串拼接。
    const key = describeError(e)
    if (writeFailedOnce.has(key)) return
    writeFailedOnce.add(key)
  }
}

/**
 * 把 console.log/info/warn/error/debug 再写一份到 <logs>/main.log（追加模式）。
 *
 * 已有日志直接续写（appendFileSync），不会截断历史；重复调用只安装一次。
 * 必须在 app ready 之后调用（app.getPath('logs') 依赖 app 初始化）。
 */
export function installConsoleFileLog(dir?: string | (() => string)): void {
  if (fileLoggingInstalled) return
  fileLoggingInstalled = true
  logDirResolver = typeof dir === 'function' ? dir : dir ? () => dir : () => app.getPath('logs')

  const levels = ['log', 'info', 'warn', 'error', 'debug'] as const
  for (const level of levels) {
    const original = console[level].bind(console)
    console[level] = (...args: any[]) => {
      original(...args)
      appendConsoleLine(level, args)
    }
  }
  console.log('[log-ops] 主进程日志将追加写入 ' + MAIN_LOG)
}
