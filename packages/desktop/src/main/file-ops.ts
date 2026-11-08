/**
 * P27 文件管理：工作区内的文件浏览、读写、增删改。
 *
 * 设计要点：
 * - 模块本身不持有工作区根目录，由 registerFileOps 的 deps.root() 每次现取
 *   （Lead 传 <userData>/workspace；登录/切号后目录可能变化）。
 * - 所有入参路径先 resolve，再做「工作区内」校验；越界统一抛中文错误「路径超出工作区范围」。
 * - 校验同时看「字面路径」和「真实路径」：目录联接 / 符号链接指到工作区外同样拒绝，
 *   避免借 root\link\..\.. 或悬空链接把文件写到工作区外。
 * - 纯逻辑函数全部导出，scripts/smoke-p27-file-ops.mjs 用 esbuild 打包后可直接跑，不依赖真实 Electron。
 */

import { shell, type IpcMain } from 'electron'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 读取文本的默认上限：200KB，和契约一致 */
export const DEFAULT_READ_BYTES = 200000
/** 读取文本的硬上限：2MB，超过按 2MB 截断 */
export const MAX_READ_BYTES = 2 * 1024 * 1024

/** 越界错误文案（F1 逐字对齐契约，不要改） */
export const ERR_OUTSIDE = '路径超出工作区范围'
/** 二进制文件错误文案（F1 逐字对齐契约，不要改） */
export const ERR_BINARY = '这个文件不是文本文件，请用「打开」交给系统程序'

export interface FileItem {
  name: string
  /** 绝对路径；渲染层直接回传给 files:read / files:open 等通道 */
  path: string
  isDir: boolean
  /** 文件字节数；目录固定 0 */
  size: number
  /** 修改时间（毫秒时间戳） */
  mtime: number
}

export interface FileOpError {
  ok: false
  error: string
}

export interface FileListData {
  ok: true
  dir: string
  items: FileItem[]
}

export interface FileReadData {
  ok: true
  path: string
  text: string
  truncated: boolean
}

export interface FileWriteData {
  ok: true
  path: string
  size: number
}

export interface FilePathData {
  ok: true
  path: string
}

export interface FileOkData {
  ok: true
  error?: string
}

/** 工作区根目录（deps.root 返回值）与某个路径是否同一个 */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** target 是否落在 root 内部（含 root 本身）；用 path.relative 判断，天然处理大小写盘符/分隔符 */
function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

/** 根目录不存在时自动创建：IPC 第一次调用就能用，不用等 Lead 预建目录 */
function ensureRoot(root: string): void {
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
}

/**
 * 符号链接 / 目录联接逃逸校验：
 * 从 target 往上找到第一个「真实存在」的祖先，取其 realpath 判断是否仍在 root 内；
 * 若 target 本身是悬空链接，existsSync 为 false 会直接跳过它，因此再单独 lstat 一次，
 * 把链接指向的目标 resolve 出来比对，防止 writeFileSync 顺着悬空链接写到工作区外。
 */
function assertNoSymlinkEscape(realRoot: string, root: string, target: string): void {
  let probe = target
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (samePath(parent, probe)) break
    probe = parent
  }
  if (existsSync(probe) && !inside(realRoot, realpathSync(probe))) throw new Error(ERR_OUTSIDE)

  try {
    const lst = lstatSync(target)
    if (lst.isSymbolicLink()) {
      let linkTarget = ''
      try {
        linkTarget = realpathSync(target)
      } catch {
        // 悬空链接：realpath 失败，手动解析链接文本
        linkTarget = resolve(dirname(target), readlinkSync(target))
      }
      if (!inside(realRoot, linkTarget)) throw new Error(ERR_OUTSIDE)
    }
  } catch (e) {
    // lstat 的 ENOENT 说明路径还不存在（新建文件/文件夹的正常情况），不算逃逸
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e
  }
}

/**
 * 把入参路径解析成工作区内的绝对路径。
 * 缺省（undefined / 空串）表示工作区根目录本身。
 * 越界（../、绝对路径 C:\Windows、指向外部的链接）一律抛「路径超出工作区范围」。
 */
export function resolveInRoot(rootRaw: string, input?: string): string {
  const root = resolve(rootRaw)
  ensureRoot(root)
  const target = input === undefined || input === null || input === '' ? root : resolve(root, input)
  if (!inside(root, target)) throw new Error(ERR_OUTSIDE)
  if (samePath(root, target)) return target
  assertNoSymlinkEscape(realpathSync(root), root, target)
  return target
}

/** 把 fs 的英文错误翻成用户能看懂的中文；未知错误原样透出 */
export function humanizeFsError(e: unknown): string {
  const err = e as NodeJS.ErrnoException
  if (!err) return '未知错误'
  if (err.message === ERR_OUTSIDE || err.message === ERR_BINARY) return err.message
  switch (err.code) {
    case 'ENOENT':
      return '文件或文件夹不存在'
    case 'EACCES':
    case 'EPERM':
      return '没有权限操作这个文件'
    case 'ENOTEMPTY':
      return '文件夹里还有内容，无法删除'
    case 'EEXIST':
      return '同名文件或文件夹已存在'
    case 'EISDIR':
      return '这是一个文件夹，不能按文件处理'
    case 'ENOTDIR':
      return '路径中有一段不是文件夹'
    case 'EINVAL':
    case 'ENAMETOOLONG':
      return '文件名不合法'
    case 'EBUSY':
      return '文件正被其他程序占用'
    default:
      return err.message || String(e)
  }
}

/** 目录优先、名称升序（与契约排序一致） */
function sortItems(items: FileItem[]): FileItem[] {
  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
  return items
}

/** files:list —— 列出目录；dir 缺省为工作区根目录；目录不存在会抛中文错误 */
export function listDir(rootRaw: string, dir?: string): FileListData {
  const target = resolveInRoot(rootRaw, dir)
  let st
  try {
    st = statSync(target)
  } catch {
    throw new Error('文件夹不存在，请刷新后重试')
  }
  if (!st.isDirectory()) throw new Error('这不是文件夹')
  const items: FileItem[] = []
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const full = join(target, entry.name)
    let isDir = entry.isDirectory()
    let size = 0
    let mtime = 0
    try {
      const s = lstatSync(full)
      isDir = s.isDirectory()
      size = s.isDirectory() ? 0 : s.size
      mtime = s.mtimeMs
    } catch {
      // 单个条目取 stat 失败（权限/竞态）不影响整个列表，保留默认值
    }
    items.push({ name: entry.name, path: full, isDir, size, mtime })
  }
  return { ok: true, dir: target, items: sortItems(items) }
}

/** maxBytes 归一化：非法/非正数回退默认 200KB，超过 2MB 按 2MB 截断 */
export function clampMaxBytes(raw?: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_READ_BYTES
  return Math.min(Math.floor(n), MAX_READ_BYTES)
}

/** files:read —— 读文本；二进制（含 \u0000）返回 ok:false + 契约文案；超过 maxBytes 截断 */
export function readTextFile(rootRaw: string, filePath: string, maxBytes?: number): FileReadData | FileOpError {
  if (!filePath) throw new Error('缺少文件路径')
  const target = resolveInRoot(rootRaw, filePath)
  const st = statSync(target)
  if (st.isDirectory()) throw new Error('这是文件夹，不能预览')
  const limit = clampMaxBytes(maxBytes)
  const size = st.size
  const want = Math.min(size, limit)
  const fd = openSync(target, 'r')
  let chunk: Buffer
  try {
    const buf = Buffer.alloc(want)
    const read = want > 0 ? readSync(fd, buf, 0, want, 0) : 0
    chunk = read === want ? buf : buf.subarray(0, read)
  } finally {
    closeSync(fd)
  }
  if (chunk.includes(0)) return { ok: false, error: ERR_BINARY }
  let text = chunk.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return { ok: true, path: target, text, truncated: size > want }
}

/** files:write —— 写 UTF-8 文本；父目录不存在自动创建 */
export function writeTextFile(rootRaw: string, filePath: string, text: string): FileWriteData {
  if (!filePath) throw new Error('缺少文件路径')
  if (typeof text !== 'string') throw new Error('写入内容必须是文本')
  const target = resolveInRoot(rootRaw, filePath)
  if (existsSync(target) && lstatSync(target).isDirectory()) throw new Error('目标是文件夹，不能写入文本')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text, 'utf8')
  return { ok: true, path: target, size: Buffer.byteLength(text, 'utf8') }
}

/** files:mkdir —— 新建文件夹，多级目录自动创建 */
export function makeDir(rootRaw: string, dirPath: string): FilePathData {
  if (!dirPath) throw new Error('缺少文件夹路径')
  const target = resolveInRoot(rootRaw, dirPath)
  if (existsSync(target) && !statSync(target).isDirectory()) throw new Error('同名文件已存在')
  mkdirSync(target, { recursive: true })
  return { ok: true, path: target }
}

/** 文件名 / 文件夹名合法性：不允许空、. / ..、路径分隔符、Windows 非法字符 */
function assertValidName(name: string): void {
  const raw = typeof name === 'string' ? name.trim() : ''
  if (!raw) throw new Error('名称不能为空')
  if (raw === '.' || raw === '..') throw new Error('名称不能是 . 或 ..')
  if (/[\\/]/.test(raw)) throw new Error('名称不能包含路径分隔符')
  if (/[<>:"|?*\u0000-\u001f]/.test(raw)) throw new Error('名称包含非法字符（< > : " | ? *）')
}

/** files:rename —— 同目录内改名；name 只允许文件名层，不允许路径分隔符 */
export function renameEntry(rootRaw: string, filePath: string, name: string): FilePathData {
  if (!filePath) throw new Error('缺少原路径')
  assertValidName(name)
  const root = resolve(rootRaw)
  const target = resolveInRoot(root, filePath)
  if (samePath(root, target)) throw new Error('不能重命名工作区根目录')
  if (!existsSync(target)) throw new Error('文件或文件夹不存在')
  const dest = join(dirname(target), name.trim())
  if (!inside(root, dest)) throw new Error(ERR_OUTSIDE)
  if (existsSync(dest)) throw new Error('同名文件或文件夹已存在')
  renameSync(target, dest)
  return { ok: true, path: dest }
}

/** files:delete —— 删除文件/文件夹（文件夹递归）；工作区根目录本身拒绝 */
export function deleteEntry(rootRaw: string, filePath: string): FileOkData {
  if (!filePath) throw new Error('缺少要删除的路径')
  const root = resolve(rootRaw)
  const target = resolveInRoot(root, filePath)
  if (samePath(root, target)) throw new Error('不能删除工作区根目录本身')
  const st = lstatSync(target)
  rmSync(target, { recursive: st.isDirectory() && !st.isSymbolicLink(), force: false })
  return { ok: true }
}

/** IPC 统一包装：抛出的错误转成 { ok:false, error }，渲染层拿到中文文案而不是 Electron 的堆栈 */
function wrap<TArg, TData>(fn: (arg: TArg) => TData | Promise<TData>) {
  return async (_e: unknown, arg: TArg): Promise<TData | FileOpError> => {
    try {
      return await fn(arg)
    } catch (e) {
      return { ok: false, error: humanizeFsError(e) }
    }
  }
}

/**
 * 把 files:* 通道挂到 ipcMain。
 * deps.root() 返回工作区根目录（Lead 传 <userData>/workspace）。
 */
export function registerFileOps(ipc: IpcMain, deps: { root: () => string }): void {
  const root = () => resolve(deps.root())

  ipc.handle('files:list', wrap((p?: { dir?: string }) => listDir(root(), p?.dir)))
  ipc.handle('files:read', wrap((p: { path: string; maxBytes?: number }) => readTextFile(root(), p?.path, p?.maxBytes)))
  ipc.handle('files:write', wrap((p: { path: string; text: string }) => writeTextFile(root(), p?.path, p?.text)))
  ipc.handle('files:mkdir', wrap((p: { path: string }) => makeDir(root(), p?.path)))
  ipc.handle('files:rename', wrap((p: { path: string; name: string }) => renameEntry(root(), p?.path, p?.name)))
  ipc.handle('files:delete', wrap((p: { path: string }) => deleteEntry(root(), p?.path)))

  ipc.handle('files:reveal', wrap((p: { path: string }): FileOkData => {
    const target = resolveInRoot(root(), p?.path)
    shell.showItemInFolder(target)
    return { ok: true }
  }))

  ipc.handle('files:open', wrap(async (p: { path: string }): Promise<FileOkData> => {
    const target = resolveInRoot(root(), p?.path)
    const message = await shell.openPath(target)
    // openPath 用空串表示成功；失败时按契约仍返回 ok:true 并带上 error 文案
    return message ? { ok: true, error: message } : { ok: true }
  }))
}
