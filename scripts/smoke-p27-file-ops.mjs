/**
 * P27 文件管理冒烟测试（Windows 上 node 直接跑）：
 *   node scripts/smoke-p27-file-ops.mjs
 *
 * 不依赖真实 Electron：用 esbuild 把 main/file-ops.ts 打成 CJS（electron 换成内存桩），
 * 再用假的 ipcMain 收通道，按契约逐条断言 list/read/write/mkdir/rename/delete、
 * 路径越界、二进制判定、maxBytes 截断、目录联接逃逸。
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')
const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const src = join(repo, 'packages', 'desktop', 'src', 'main', 'file-ops.ts')

const OUTSIDE = '路径超出工作区范围'
const BINARY = '这个文件不是文本文件，请用「打开」交给系统程序'

let total = 0
let passed = 0
const failures = []

function check(label, cond, extra) {
  total++
  if (cond) {
    passed++
    console.log('  PASS ' + label)
  } else {
    failures.push(label)
    console.log('  FAIL ' + label + (extra === undefined ? '' : ' -> ' + extra))
  }
}

function isOk(r, label) {
  check(label, !!(r && r.ok), '实际返回：' + JSON.stringify(r))
}

function isErr(r, expected, label) {
  const good = !!(r && r.ok === false && r.error === expected)
  check(label, good, '期望错误「' + expected + '」，实际：' + JSON.stringify(r))
}

function eq(actual, expected, label) {
  check(label, actual === expected, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual))
}

// 注意：esbuild 会 spawn 子进程写产物，而本机 %TEMP% 对子进程写被拒（Access is denied），
// 所以临时目录放在仓库内（.smoke-tmp 已在 .gitignore），可用 FCM_SMOKE_TMP 覆盖。
const workBase = process.env.FCM_SMOKE_TMP || join(repo, '.smoke-tmp')
mkdirSync(workBase, { recursive: true })
const work = mkdtempSync(join(workBase, 'p27-file-ops-'))
const root = join(work, 'workspace')
const outsideDir = join(work, 'outside')
const outFile = join(work, 'file-ops.cjs')
const stubFile = join(work, 'electron-stub.cjs')
mkdirSync(root, { recursive: true })
mkdirSync(outsideDir, { recursive: true })

writeFileSync(
  stubFile,
  'module.exports = { shell: { showItemInFolder() {}, openPath: async () => "" } }\n',
  'utf8'
)

esbuild.buildSync({
  entryPoints: [src],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: outFile,
  alias: { electron: stubFile },
  logLevel: 'silent'
})

const lib = require(outFile)
const handlers = new Map()
const ipc = { handle: (channel, fn) => handlers.set(channel, fn) }
lib.registerFileOps(ipc, { root: () => root })

async function call(channel, arg) {
  const fn = handlers.get(channel)
  if (!fn) throw new Error('通道未注册：' + channel)
  return fn({}, arg)
}

try {
  console.log('[1] 通道注册')
  for (const ch of ['files:list', 'files:read', 'files:write', 'files:mkdir', 'files:rename', 'files:delete', 'files:reveal', 'files:open']) {
    check('已注册 ' + ch, handlers.has(ch))
  }

  console.log('[2] 正常 list / read / write / mkdir')
  let r = await call('files:list', {})
  isOk(r, 'list 空工作区返回 ok')
  eq(r.dir, root, 'list 缺省 dir 等于工作区根目录')
  eq(r.items.length, 0, '空工作区 items 为空')

  r = await call('files:write', { path: join(root, 'hello.txt'), text: '你好 P27' })
  isOk(r, 'write 新建文本文件')
  eq(r.size, Buffer.byteLength('你好 P27', 'utf8'), 'write 返回 UTF-8 字节数')

  r = await call('files:read', { path: join(root, 'hello.txt') })
  isOk(r, 'read 文本文件')
  eq(r.text, '你好 P27', 'read 内容一致')
  eq(r.truncated, false, 'read 未截断')

  r = await call('files:list', {})
  const hello = r.items.find((it) => it.name === 'hello.txt')
  check('list 能列出新文件', !!hello)
  eq(hello.isDir, false, 'list isDir 正确')
  eq(hello.size, Buffer.byteLength('你好 P27', 'utf8'), 'list size 正确')
  check('list mtime 为毫秒时间戳', typeof hello.mtime === 'number' && hello.mtime > 0)

  isOk(await call('files:mkdir', { path: join(root, 'docs') }), 'mkdir 新建文件夹')
  isOk(await call('files:mkdir', { path: join(root, 'docs', 'sub') }), 'mkdir 多级文件夹自动创建')
  isOk(await call('files:write', { path: join(root, 'auto', 'deep', 'note.txt'), text: 'deep' }), 'write 自动创建父目录')
  check('write 确实创建了多级目录', existsSync(join(root, 'auto', 'deep', 'note.txt')))

  r = await call('files:list', { dir: join(root, 'docs') })
  isOk(r, 'list 子目录')
  eq(r.items.map((it) => it.name).join(','), 'sub', 'list 子目录内容正确')

  console.log('[3] 二进制判定 / maxBytes 截断')
  writeFileSync(join(root, 'binary.dat'), Buffer.from([0x41, 0x00, 0x42]))
  isErr(await call('files:read', { path: join(root, 'binary.dat') }), BINARY, '二进制文件返回契约文案')

  isOk(await call('files:write', { path: join(root, 'ten.txt'), text: 'abcdefghij' }), 'write 10 字节文件')
  r = await call('files:read', { path: join(root, 'ten.txt'), maxBytes: 4 })
  eq(r.text, 'abcd', 'maxBytes=4 只读前 4 字节')
  eq(r.truncated, true, 'maxBytes 截断时 truncated=true')

  isOk(await call('files:write', { path: join(root, 'big.txt'), text: 'x'.repeat(200001) }), 'write 200001 字节文件')
  r = await call('files:read', { path: join(root, 'big.txt') })
  eq(r.text.length, 200000, '默认 maxBytes=200000 截断')
  eq(r.truncated, true, '默认截断时 truncated=true')

  isOk(await call('files:write', { path: join(root, 'huge.txt'), text: 'y'.repeat(2.5 * 1024 * 1024) }), 'write 2.5MB 文件')
  r = await call('files:read', { path: join(root, 'huge.txt'), maxBytes: 10 * 1024 * 1024 })
  eq(r.text.length, 2 * 1024 * 1024, 'maxBytes 上限被夹到 2MB')
  eq(r.truncated, true, '超过 2MB 仍标记截断')

  isOk(await call('files:write', { path: join(root, 'empty.txt'), text: '' }), 'write 空文件')
  r = await call('files:read', { path: join(root, 'empty.txt') })
  isOk(r, 'read 空文件')
  eq(r.text, '', 'read 空文件内容为空')

  console.log('[4] rename')
  r = await call('files:rename', { path: join(root, 'hello.txt'), name: 'renamed.txt' })
  isOk(r, 'rename 文件')
  check('rename 返回新路径', String(r.path).endsWith('renamed.txt'), r.path)
  isErr(await call('files:read', { path: join(root, 'hello.txt') }), '文件或文件夹不存在', 'rename 后旧路径不存在')
  r = await call('files:read', { path: join(root, 'renamed.txt') })
  eq(r.text, '你好 P27', 'rename 后内容不变')
  isErr(await call('files:rename', { path: join(root, 'renamed.txt'), name: 'sub/x.txt' }), '名称不能包含路径分隔符', 'rename 拒绝带路径分隔符的名称')
  isErr(await call('files:rename', { path: join(root, 'missing.txt'), name: 'x.txt' }), '文件或文件夹不存在', 'rename 不存在的文件报错')

  console.log('[5] delete')
  isOk(await call('files:delete', { path: join(root, 'renamed.txt') }), 'delete 文件')
  r = await call('files:list', {})
  check('delete 后列表里没有该文件', !r.items.some((it) => it.name === 'renamed.txt'))
  isOk(await call('files:delete', { path: join(root, 'docs') }), 'delete 文件夹（递归）')
  check('delete 目录后目录确实消失', !existsSync(join(root, 'docs')))
  isErr(await call('files:delete', { path: join(root, 'missing.txt') }), '文件或文件夹不存在', 'delete 不存在的文件报错')
  isErr(await call('files:delete', { path: root }), '不能删除工作区根目录本身', 'delete 工作区根目录被拒绝')

  console.log('[6] 路径越界')
  const outsideTarget = resolve(root, '..', '..', 'evil.txt')
  isErr(await call('files:write', { path: '../../evil.txt', text: 'x' }), OUTSIDE, 'write ..\\..\\ 被拒绝且文案正确')
  check('越界写入没有落盘', !existsSync(outsideTarget), outsideTarget)
  isErr(await call('files:read', { path: '..\\..\\evil.txt' }), OUTSIDE, 'read ..\\..\\ 被拒绝')
  isErr(await call('files:list', { dir: '..' }), OUTSIDE, 'list .. 被拒绝')
  isErr(await call('files:write', { path: 'C:\\Windows\\p27-evil.txt', text: 'x' }), OUTSIDE, 'write 绝对路径 C:\\Windows 被拒绝')
  isErr(await call('files:read', { path: 'C:\\Windows\\win.ini' }), OUTSIDE, 'read 绝对路径 C:\\Windows 被拒绝')
  let throwMsg = ''
  try {
    lib.resolveInRoot(root, '..\\..\\x')
  } catch (e) {
    throwMsg = e.message
  }
  eq(throwMsg, OUTSIDE, '纯函数 resolveInRoot 抛契约错误')

  console.log('[7] 其他错误文案')
  isErr(await call('files:read', { path: join(root, 'auto') }), '这是文件夹，不能预览', 'read 文件夹被拒绝')
  isErr(await call('files:list', { dir: join(root, 'nope') }), '文件夹不存在，请刷新后重试', 'list 不存在的目录')
  isErr(await call('files:list', { dir: join(root, 'auto', 'deep', 'note.txt') }), '这不是文件夹', 'list 文件路径被拒绝')
  isErr(await call('files:write', { path: join(root, 'auto'), text: 'x' }), '目标是文件夹，不能写入文本', 'write 覆盖文件夹被拒绝')

  console.log('[8] 排序 / 目录优先')
  isOk(await call('files:mkdir', { path: join(root, 'sortdir') }), 'mkdir sortdir')
  isOk(await call('files:write', { path: join(root, 'sortdir', 'aaa.txt'), text: '' }), 'write sortdir/aaa.txt')
  isOk(await call('files:mkdir', { path: join(root, 'sortdir', 'zzz-dir') }), 'mkdir sortdir/zzz-dir')
  r = await call('files:list', { dir: join(root, 'sortdir') })
  eq(r.items.map((it) => it.name).join(','), 'zzz-dir,aaa.txt', '目录优先、名称升序')
  eq(r.items[0].isDir, true, '排序后第一项是目录')

  console.log('[9] shell 通道')
  isOk(await call('files:reveal', { path: join(root, 'auto', 'deep', 'note.txt') }), 'files:reveal 返回 ok')
  r = await call('files:open', { path: join(root, 'auto', 'deep', 'note.txt') })
  isOk(r, 'files:open 返回 ok')
  eq(r.error, undefined, 'files:open 成功时不带 error')

  console.log('[10] 目录联接逃逸')
  let junctionOk = false
  const linkPath = join(root, 'link-out')
  try {
    symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    junctionOk = true
  } catch (e) {
    console.log('  SKIP 本机无法创建目录联接（' + (e && e.message) + '）')
  }
  if (junctionOk) {
    isErr(await call('files:write', { path: join(linkPath, 'escape.txt'), text: 'x' }), OUTSIDE, '经目录联接写入被拒绝')
    check('目录联接外的文件没有被创建', !existsSync(join(outsideDir, 'escape.txt')))
    isErr(await call('files:list', { dir: linkPath }), OUTSIDE, 'list 目录联接被拒绝')
  }
} finally {
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    // 清理失败不影响测试结论
  }
}

const summary = failures.length
  ? 'SMOKE FAIL：共 ' + total + ' 项断言，' + passed + ' 通过，' + failures.length + ' 失败 -> ' + failures.join(' | ')
  : 'SMOKE PASS：共 ' + total + ' 项断言全部通过'
console.log('')
console.log(summary)
if (failures.length) process.exitCode = 1
