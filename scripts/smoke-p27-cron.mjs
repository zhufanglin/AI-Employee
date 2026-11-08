/**
 * P27 定时任务冒烟测试。
 *
 * 不启动 Electron：用 esbuild 把 packages/desktop/src/main/cron-ops.ts 打成 CJS，
 * 注入假的 ipcMain（收集 handle 回调）和假 api，直接调用注册后的 IPC handler。
 *
 * 重点覆盖服务端的坑：能力失败也是 HTTP 201，错误在 body { success:false, error:"中文" }。
 *
 * 运行：node scripts/smoke-p27-cron.mjs
 */
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'
import * as esbuild from 'esbuild'

const requireFromHere = createRequire(import.meta.url)
const sourcePath = fileURLToPath(new URL('../packages/desktop/src/main/cron-ops.ts', import.meta.url))

let bundle
try {
  bundle = esbuild.buildSync({
    entryPoints: [sourcePath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    // 主进程模块只 import type { IpcMain }，esbuild 会擦除；external 只是防止未来引入运行时 electron 依赖。
    external: ['electron'],
    write: false,
    logLevel: 'silent'
  })
} catch (error) {
  console.error('esbuild 打包 cron-ops.ts 失败：', error?.message || error)
  process.exit(1)
}

const compiled = bundle.outputFiles[0].text
const moduleShim = { exports: {} }
const loadModule = new Function('exports', 'require', 'module', '__filename', '__dirname', compiled)
loadModule(moduleShim.exports, requireFromHere, moduleShim, sourcePath, path.dirname(sourcePath))

const { registerCronOps } = moduleShim.exports
if (typeof registerCronOps !== 'function') {
  console.error('cron-ops.ts 没有导出 registerCronOps')
  process.exit(1)
}

// ---- 假 ipcMain：只实现 handle，并收集注册的回调 ----
const handlers = new Map()
const ipcMain = {
  handle(channel, handler) {
    if (typeof handler !== 'function') throw new Error('handle 回调不是函数：' + channel)
    if (handlers.has(channel)) throw new Error('重复注册 IPC 通道：' + channel)
    handlers.set(channel, handler)
  }
}

// ---- 假 api：记录请求，返回可控的 { status, body } ----
const calls = []
let lastStatus = 0
let responder = async () => ({ status: 200, body: { success: true, data: null } })
const api = async (requestPath, init) => {
  calls.push({
    path: requestPath,
    method: init?.method,
    body: init?.body ? JSON.parse(init.body) : null
  })
  const reply = await responder(requestPath, init)
  lastStatus = reply.status
  // main/index.ts 的 api 只把解析后的 body 交给上层；201 也会正常 resolve。
  return reply.body
}

registerCronOps(ipcMain, { api })

// ---- 断言 ----
let passed = 0
const failures = []
function check(name, ok, extra) {
  if (ok) {
    passed += 1
  } else {
    failures.push(name + (extra === undefined ? '' : ' => ' + JSON.stringify(extra)))
  }
}

async function invoke(channel, arg) {
  const handler = handlers.get(channel)
  if (!handler) throw new Error('没有注册 IPC 通道：' + channel)
  return handler({}, arg)
}

// 1. 注册通道
check(
  '注册 cron:list / cron:create / cron:delete 三个通道',
  ['cron:list', 'cron:create', 'cron:delete'].every((channel) => handlers.has(channel)),
  [...handlers.keys()]
)

// 2. list 成功：服务端真实字段是 employee: { slug, name }，同时兼容契约的扁平 employeeSlug
calls.length = 0
responder = async () => ({
  status: 200,
  body: {
    success: true,
    data: {
      total: 2,
      items: [
        {
          cronId: 'cron_a',
          employee: { slug: 'boss-lead-radar', name: '老板雷达' },
          cronExpr: '0 9 * * *',
          timezone: 'Asia/Shanghai',
          enabled: true,
          nextRunAt: '2026-11-10T01:00:00.000Z',
          lastRunAt: null
        },
        {
          cronId: 'cron_b',
          employeeSlug: 'copy-writer',
          employeeName: '文案助手',
          cronExpr: '0 * * * *',
          timezone: 'UTC',
          enabled: false,
          nextRunAt: null,
          lastRunAt: '2026-11-09T00:00:00.000Z'
        }
      ]
    }
  }
})
const listed = await invoke('cron:list')
check('list 成功返回 ok:true', listed.ok === true, listed)
check(
  'list 调用 POST /capabilities/run',
  calls.length === 1 && calls[0].path === '/capabilities/run' && calls[0].method === 'POST',
  calls[0]
)
check(
  'list 能力名 cron_list 且 params 为空对象',
  calls[0].body.name === 'cron_list' && JSON.stringify(calls[0].body.params) === '{}',
  calls[0].body
)
check(
  'list 归一化 employee 对象为 employeeSlug / employeeName',
  listed.data.items[0].employeeSlug === 'boss-lead-radar' && listed.data.items[0].employeeName === '老板雷达',
  listed.data.items[0]
)
check('list 兼容契约的扁平 employeeSlug 字段', listed.data.items[1].employeeSlug === 'copy-writer', listed.data.items[1])
check('list total 透传', listed.data.total === 2 && listed.data.items.length === 2, listed.data)
check(
  'list 保留时间与 enabled 状态',
  listed.data.items[0].nextRunAt === '2026-11-10T01:00:00.000Z' && listed.data.items[1].enabled === false,
  listed.data.items
)

// 3. create 成功 + 缺省时区
calls.length = 0
responder = async () => ({
  status: 200,
  body: {
    success: true,
    data: { cronId: 'cron_new', nextRunAt: '2026-11-10T01:00:00.000Z', cronExpr: '0 9 * * *', timezone: 'Asia/Shanghai' }
  }
})
const created = await invoke('cron:create', { employeeSlug: 'boss-lead-radar', cronExpr: '0 9 * * *' })
check('create 成功返回 ok:true', created.ok === true, created)
check(
  'create 能力名与员工/表达式参数正确',
  calls.length === 1 &&
    calls[0].body.name === 'cron_create' &&
    calls[0].body.params.employeeSlug === 'boss-lead-radar' &&
    calls[0].body.params.cronExpr === '0 9 * * *',
  calls[0]?.body
)
check('create 未传时区时缺省 Asia/Shanghai', calls[0].body.params.timezone === 'Asia/Shanghai', calls[0].body.params)
check(
  'create 返回 cronId 与 nextRunAt',
  created.data.cronId === 'cron_new' && created.data.nextRunAt === '2026-11-10T01:00:00.000Z',
  created.data
)

// 4. 服务端 success:false（HTTP 201）原样透传中文错误
responder = async () => ({
  status: 201,
  body: { success: false, data: null, error: '员工未安装或授权已过期', error_code: 'EMPLOYEE_NOT_INSTALLED' }
})
const rejected = await invoke('cron:create', { employeeSlug: 'boss-lead-radar', cronExpr: '0 9 * * *', timezone: 'Asia/Shanghai' })
check('201 + success:false 返回 ok:false', rejected.ok === false && lastStatus === 201, rejected)
check('透传服务端中文错误原文', rejected.error === '员工未安装或授权已过期', rejected.error)
check('失败结果不带 data', rejected.data === undefined, rejected)

// 5. 201 + success:false：delete 找不到定时器
responder = async () => ({
  status: 201,
  body: { success: false, data: null, error: '定时器不存在', error_code: 'CRON_NOT_FOUND' }
})
const deleteRejected = await invoke('cron:delete', { cronId: 'cron_missing' })
check(
  '201 + success:false 的 delete 也透传中文错误',
  deleteRejected.ok === false && lastStatus === 201 && deleteRejected.error === '定时器不存在',
  deleteRejected
)

// 6. 缺参 / 非法参数本地校验（不应请求服务端）
calls.length = 0
const noSlug = await invoke('cron:create', { cronExpr: '0 9 * * *' })
check('create 缺员工 slug 时本地报错', noSlug.ok === false && noSlug.error === '员工 slug 必填', noSlug)

const noExpr = await invoke('cron:create', { employeeSlug: 'boss-lead-radar' })
check('create 缺 cron 表达式时本地报错', noExpr.ok === false && noExpr.error === 'cron 表达式必填', noExpr)

const badExpr = await invoke('cron:create', { employeeSlug: 'boss-lead-radar', cronExpr: '0 9 * *' })
check(
  'create cron 非 5 段时本地报错',
  badExpr.ok === false && badExpr.error.indexOf('5 段') >= 0,
  badExpr
)

const noCronId = await invoke('cron:delete', {})
check('delete 缺 cronId 时本地报错', noCronId.ok === false && noCronId.error === 'cronId 必填', noCronId)

check('本地校验失败不会请求服务端', calls.length === 0, calls)

// 7. delete 成功：cronId 必须原样传递
calls.length = 0
responder = async () => ({ status: 200, body: { success: true, data: { cronId: 'cron_9', deleted: true } } })
const deleted = await invoke('cron:delete', { cronId: 'cron_9' })
check('delete 成功返回 deleted:true', deleted.ok === true && deleted.data.deleted === true, deleted)
check(
  'delete 把 cronId 传给 cron_delete 能力',
  calls.length === 1 &&
    calls[0].body.name === 'cron_delete' &&
    calls[0].body.params.cronId === 'cron_9',
  calls[0]?.body
)

// 8. 网络/客户端异常不能把 IPC handler 打崩
responder = async () => {
  throw new Error('连不上服务器')
}
const networkFailed = await invoke('cron:list')
check(
  'api 抛错时返回 ok:false 且带原因',
  networkFailed.ok === false && networkFailed.error.indexOf('连不上服务器') >= 0,
  networkFailed
)

// ---- 结果 ----
if (failures.length > 0) {
  console.error('P27 定时任务 SMOKE FAILED')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}

console.log('P27 定时任务 SMOKE OK (' + passed + ' checks)')
