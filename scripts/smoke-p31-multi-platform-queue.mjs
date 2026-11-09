/**
 * P31 定时发布多平台分发冒烟测试。
 *
 * 不启动 Electron：用 esbuild 把 packages/desktop/src/main/publish-queue.ts 打成 CJS，
 * 注入临时目录、假时钟、假 publish，重点验证「一条任务串行发多个平台」：
 * 全成功 / 部分成功 / 全失败 / 中途异常 / results 逐步落盘 / 老格式兼容 /
 * 去重 / 上限 / 非法平台校验 / retry 清空 results / IPC 收敛层。
 *
 * 运行：node scripts/smoke-p31-multi-platform-queue.mjs
 */
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as esbuild from 'esbuild'

const requireFromHere = createRequire(import.meta.url)
const sourcePath = fileURLToPath(new URL('../packages/desktop/src/main/publish-queue.ts', import.meta.url))

const bundle = esbuild.buildSync({
  entryPoints: [sourcePath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['electron'],
  write: false,
  logLevel: 'silent'
})
const compiled = bundle.outputFiles[0].text
const moduleShim = { exports: {} }
new Function('exports', 'require', 'module', '__filename', '__dirname', compiled)(
  moduleShim.exports,
  requireFromHere,
  moduleShim,
  sourcePath,
  path.dirname(sourcePath)
)
const { PublishQueue, registerPublishQueue, PLATFORMS, PLATFORM_LABELS, MAX_PLATFORMS } = moduleShim.exports

let passed = 0
const failures = []
function check(name, ok, extra) {
  if (ok) passed += 1
  else failures.push(name + (extra ? ' -> ' + extra : ''))
}

const dir = mkdtempSync(path.join(tmpdir(), 'fcm-queue-p31-'))
const BASE = new Date('2026-11-10T01:00:00.000Z').getTime()
const DUE = new Date(BASE + 3600 * 1000).toISOString()
let clock = BASE
const now = () => clock
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

let calls = []
let responder = async (input) => ({ ok: true, message: '发布成功', url: 'https://example.com/' + input.platform })
const publish = async (input) => {
  calls.push(input)
  return responder(input)
}

let fileSeq = 0
/** 每个场景独立队列文件，互不污染。 */
function freshQueue(initialJobs) {
  fileSeq += 1
  const file = path.join(dir, 'queue-' + fileSeq + '.json')
  if (initialJobs) writeFileSync(file, JSON.stringify({ version: 1, jobs: initialJobs }, null, 2), 'utf8')
  const queue = new PublishQueue({ file: () => file, publish, now, log: () => {} })
  return { queue, file }
}

function reset(responderFn) {
  clock = BASE
  calls = []
  responder = responderFn || (async (input) => ({ ok: true, message: '发布成功', url: 'https://example.com/' + input.platform }))
}

function readJobs(file) {
  return JSON.parse(readFileSync(file, 'utf8')).jobs
}

function baseJob(overrides) {
  return {
    id: 'job_legacy_1',
    platform: 'xiaohongshu',
    type: 'video',
    title: '老格式任务',
    content: '',
    tags: [],
    mediaPaths: ['old.mp4'],
    scheduledAt: DUE,
    status: 'pending',
    attempts: 0,
    createdAt: new Date(BASE).toISOString(),
    ...overrides
  }
}

// ================= 1. 入参校验：至少 1 / 最多 3 / 白名单 / 去重 =================
reset()
const v = freshQueue().queue
const baseInput = { title: '校验', mediaPaths: ['a.mp4'], scheduledAt: DUE }
const invalidCases = [
  ['platforms 空数组', { ...baseInput, platforms: [] }, '至少选择一个发布平台'],
  ['platforms 不是数组', { ...baseInput, platforms: 'douyin' }, 'platforms 必须是平台 id 数组'],
  ['超过 3 个平台', { ...baseInput, platforms: ['douyin', 'douyin', 'douyin', 'douyin'] }, '最多选择 3 个'],
  ['平台不在白名单', { ...baseInput, platforms: ['douyin', 'weibo'] }, '平台只能是'],
  ['完全没有平台字段', { ...baseInput }, '至少选择一个发布平台']
]
for (const [name, input, expect] of invalidCases) {
  let err = ''
  try {
    v.add(input)
  } catch (e) {
    err = e.message
  }
  check('校验：' + name + ' 被拒且文案正确', err.includes(expect), err)
}

const deduped = v.add({ ...baseInput, title: '去重', platforms: ['douyin', 'douyin', 'xiaohongshu'] })
check('platforms 去重后保留勾选顺序', JSON.stringify(deduped.platforms) === JSON.stringify(['douyin', 'xiaohongshu']), JSON.stringify(deduped.platforms))
check('去重后 platform 等于 platforms[0]', deduped.platform === 'douyin', deduped.platform)
check('新任务 results 初始为空数组', Array.isArray(deduped.results) && deduped.results.length === 0)

const legacyAdd = v.add({ ...baseInput, title: '老字段新增', platform: 'shipinhao' })
check('旧 platform 字段仍可新增', legacyAdd.platform === 'shipinhao')
check('旧 platform 字段内部归一成 platforms 数组', JSON.stringify(legacyAdd.platforms) === JSON.stringify(['shipinhao']), JSON.stringify(legacyAdd.platforms))

const wins = v.add({ ...baseInput, title: '同时给两者', platform: 'douyin', platforms: ['xiaohongshu'] })
check('同时给 platform 和 platforms 时以 platforms 为准', JSON.stringify(wins.platforms) === JSON.stringify(['xiaohongshu']), JSON.stringify(wins.platforms))
check('同时给两者时 platform 同步为 platforms[0]', wins.platform === 'xiaohongshu', wins.platform)

const allThree = v.add({ ...baseInput, title: '三平台', platforms: [...PLATFORMS] })
check('最多 3 个合法平台全部接受', allThree.platforms.length === 3, String(allThree.platforms.length))
check('平台顺序与勾选顺序一致', JSON.stringify(allThree.platforms) === JSON.stringify([...PLATFORMS]), JSON.stringify(allThree.platforms))
check('平台中文名映射完整', ['douyin', 'xiaohongshu', 'shipinhao'].every((id) => PLATFORM_LABELS[id]), JSON.stringify(PLATFORM_LABELS))
check('MAX_PLATFORMS 常量为 3', MAX_PLATFORMS === 3, String(MAX_PLATFORMS))

// ================= 2. 全成功 + 串行 =================
reset(async (input) => {
  await delay(5)
  return { ok: true, message: '发布成功', url: 'https://example.com/' + input.platform }
})
let active = 0
let maxActive = 0
const baseResponder = responder
responder = async (input) => {
  active += 1
  maxActive = Math.max(maxActive, active)
  try {
    return await baseResponder(input)
  } finally {
    active -= 1
  }
}
const s2 = freshQueue()
const job2 = s2.queue.add({ ...baseInput, title: '全成功', platforms: ['douyin', 'xiaohongshu', 'shipinhao'] })
clock = BASE + 3600 * 1000 + 1000
const ran2 = await s2.queue.tick()
const done2 = s2.queue.list().find((j) => j.id === job2.id)
check('全成功：tick 执行 1 条任务', ran2.length === 1)
check('全成功：三个平台各调用一次 publish', calls.length === 3, String(calls.length))
check('全成功：发布顺序为勾选顺序', calls.map((c) => c.platform).join(',') === 'douyin,xiaohongshu,shipinhao', calls.map((c) => c.platform).join(','))
check('全成功：多个平台严格串行（最大并发 1）', maxActive === 1, String(maxActive))
check('全成功：每次 publish 只带单个 platform', calls.every((c) => typeof c.platform === 'string' && !Array.isArray(c.platform)))
check('全成功：results 三条且顺序一致', done2.results.map((r) => r.platform).join(',') === 'douyin,xiaohongshu,shipinhao', JSON.stringify(done2.results.map((r) => r.platform)))
check('全成功：results 全部 ok', done2.results.every((r) => r.ok === true))
check('全成功：status=done', done2.status === 'done', done2.status)
check('全成功：message 为「3 个平台全部发布成功」', done2.message === '3 个平台全部发布成功', done2.message)
check('全成功：url 取第一个成功的链接', done2.url === 'https://example.com/douyin', String(done2.url))
check('全成功：finishedAt 已写入', typeof done2.finishedAt === 'string' && done2.finishedAt.length > 0)
check('全成功：attempts=1', done2.attempts === 1, String(done2.attempts))
const disk2 = readJobs(s2.file).find((j) => j.id === job2.id)
check('全成功：results 已落盘', disk2.results.length === 3, String(disk2.results.length))

// ================= 3. 部分成功 -> done + 2/3 汇总 =================
reset(async (input) => {
  if (input.platform === 'xiaohongshu') return { ok: false, message: '笔记发布按钮未找到' }
  return { ok: true, message: '发布成功', url: 'https://example.com/' + input.platform }
})
const s3 = freshQueue()
const job3 = s3.queue.add({ ...baseInput, title: '部分成功', platforms: ['douyin', 'xiaohongshu', 'shipinhao'] })
clock = BASE + 3600 * 1000 + 1000
await s3.queue.tick()
const partial = s3.queue.list().find((j) => j.id === job3.id)
check('部分成功：仍执行完三个平台', calls.length === 3, String(calls.length))
check('部分成功：status=done（不自动重试已成功平台）', partial.status === 'done', partial.status)
check('部分成功：results 记录 2 成功 1 失败', partial.results.filter((r) => r.ok).length === 2 && partial.results.filter((r) => !r.ok).length === 1)
check('部分成功：失败平台结果带中文原因', partial.results.find((r) => r.platform === 'xiaohongshu').message === '笔记发布按钮未找到')
check('部分成功：message 形如 2/3', partial.message.includes('2/3'), partial.message)
check('部分成功：message 点名失败平台', partial.message.includes('小红书'), partial.message)
check('部分成功：message 带上失败原因', partial.message.includes('笔记发布按钮未找到'), partial.message)
check('部分成功：url 取第一个成功平台', partial.url === 'https://example.com/douyin', String(partial.url))

// ================= 4. 全失败 -> failed + 每个平台原因 =================
reset(async (input) => ({ ok: false, message: '失败-' + input.platform }))
const s4 = freshQueue()
const job4 = s4.queue.add({ ...baseInput, title: '全失败', platforms: ['douyin', 'xiaohongshu', 'shipinhao'] })
clock = BASE + 3600 * 1000 + 1000
await s4.queue.tick()
const allFail = s4.queue.list().find((j) => j.id === job4.id)
check('全失败：status=failed', allFail.status === 'failed', allFail.status)
check('全失败：三个平台都尝试过', calls.length === 3, String(calls.length))
check('全失败：results 三条全失败', allFail.results.length === 3 && allFail.results.every((r) => !r.ok))
check('全失败：message 汇总文案', allFail.message.startsWith('全部平台发布失败：'), allFail.message)
check('全失败：message 含抖音原因', allFail.message.includes('抖音（失败-douyin）'), allFail.message)
check('全失败：message 含小红书原因', allFail.message.includes('小红书（失败-xiaohongshu）'), allFail.message)
check('全失败：message 含视频号原因', allFail.message.includes('视频号（失败-shipinhao）'), allFail.message)
check('全失败：不写 url', allFail.url === undefined, String(allFail.url))

// ================= 5. 某个平台抛异常不影响后面 =================
reset(async (input) => {
  if (input.platform === 'xiaohongshu') throw new Error('平台窗口崩溃了')
  return { ok: true, message: '发布成功', url: 'https://example.com/' + input.platform }
})
const s5 = freshQueue()
const job5 = s5.queue.add({ ...baseInput, title: '中途异常', platforms: ['douyin', 'xiaohongshu', 'shipinhao'] })
clock = BASE + 3600 * 1000 + 1000
await s5.queue.tick()
const threw = s5.queue.list().find((j) => j.id === job5.id)
check('中途异常：异常平台之后的平台仍继续发', calls.map((c) => c.platform).join(',') === 'douyin,xiaohongshu,shipinhao', calls.map((c) => c.platform).join(','))
check('中途异常：status=done（另外两个成功）', threw.status === 'done', threw.status)
check('中途异常：异常信息落进该平台 result', threw.results.find((r) => r.platform === 'xiaohongshu').message === '平台窗口崩溃了')
check('中途异常：message 汇总 2/3', threw.message.includes('2/3') && threw.message.includes('平台窗口崩溃了'), threw.message)
check('中途异常：results 顺序与平台顺序一致且 3 条', threw.results.length === 3 && threw.results[1].platform === 'xiaohongshu')

// ================= 6. results 逐步落盘（发布过程中读盘可见进度） =================
reset(async (input) => ({ ok: true, message: '发布成功', url: 'https://example.com/' + input.platform }))
const s6 = freshQueue()
let progressFile = s6.file
const progressSnapshots = []
const progressResponder = async (input) => {
  const job = readJobs(progressFile).find((j) => j.title === '渐进落盘')
  progressSnapshots.push({ platform: input.platform, count: job.results.length, status: job.status })
  return { ok: true, message: '发布成功', url: 'https://example.com/' + input.platform }
}
responder = progressResponder
const job6 = s6.queue.add({ ...baseInput, title: '渐进落盘', platforms: ['douyin', 'xiaohongshu', 'shipinhao'] })
clock = BASE + 3600 * 1000 + 1000
await s6.queue.tick()
check('逐步落盘：第 1 个平台开始时结果为 0 条', progressSnapshots[0].count === 0, JSON.stringify(progressSnapshots))
check('逐步落盘：第 2 个平台时已落盘 1 条', progressSnapshots[1].count === 1, JSON.stringify(progressSnapshots))
check('逐步落盘：第 3 个平台时已落盘 2 条', progressSnapshots[2].count === 2, JSON.stringify(progressSnapshots))
check('逐步落盘：发布过程中磁盘状态为 running', progressSnapshots.every((s) => s.status === 'running'), JSON.stringify(progressSnapshots))
check('逐步落盘：全部结束后磁盘 results 为 3 条', readJobs(s6.file).find((j) => j.id === job6.id).results.length === 3)
check('逐步落盘：results 每项含 platform/ok/message', job6.results.every((r) => r.platform && typeof r.ok === 'boolean' && typeof r.message === 'string'))

// ================= 7. 老格式 {platform} 队列文件兼容 =================
reset(async (input) => ({ ok: true, message: '发布成功', url: 'https://example.com/' + input.platform }))
const legacy = freshQueue([baseJob()])
const legacyJob = legacy.queue.list()[0]
check('老格式：读盘后 platforms 归一为 [platform]', JSON.stringify(legacyJob.platforms) === JSON.stringify(['xiaohongshu']), JSON.stringify(legacyJob.platforms))
check('老格式：platform 字段保持原值', legacyJob.platform === 'xiaohongshu', legacyJob.platform)
check('老格式：缺失的 results 补为空数组', Array.isArray(legacyJob.results) && legacyJob.results.length === 0)
clock = BASE + 3600 * 1000 + 1000
await legacy.queue.tick()
const legacyDone = legacy.queue.list()[0]
check('老格式：到点仍能发布', calls.length === 1 && calls[0].platform === 'xiaohongshu', JSON.stringify(calls))
check('老格式：单平台成功仍记 done', legacyDone.status === 'done', legacyDone.status)
check('老格式：单平台 results 落一条', legacyDone.results.length === 1 && legacyDone.results[0].ok === true)
check('老格式：单平台成功保留 P26 原文案', legacyDone.message === '发布成功', legacyDone.message)
check('老格式：单平台 url 正常', legacyDone.url === 'https://example.com/xiaohongshu', String(legacyDone.url))

// ================= 8. 崩溃恢复：running 回 pending，results 先保留再重跑 =================
reset(async (input) => ({ ok: true, message: '发布成功', url: 'https://example.com/' + input.platform }))
const crash = freshQueue([
  baseJob({
    id: 'job_crash_multi',
    title: '崩溃多平台',
    status: 'running',
    attempts: 1,
    platforms: ['douyin', 'xiaohongshu'],
    results: [{ platform: 'douyin', ok: true, message: '发布成功', url: 'https://example.com/douyin' }]
  })
])
const crashJob = crash.queue.list()[0]
check('崩溃恢复：running 回落 pending', crashJob.status === 'pending', crashJob.status)
check('崩溃恢复：platforms 保留', JSON.stringify(crashJob.platforms) === JSON.stringify(['douyin', 'xiaohongshu']))
check('崩溃恢复：已完成平台的 result 保留在盘上', crashJob.results.length === 1 && crashJob.results[0].platform === 'douyin')
clock = BASE + 3600 * 1000 + 1000
await crash.queue.tick()
const crashDone = crash.queue.list()[0]
check('崩溃恢复：重跑会重发所有平台', calls.length === 2, String(calls.length))
check('崩溃恢复：重跑后 results 不重复累加', crashDone.results.length === 2, JSON.stringify(crashDone.results.map((r) => r.platform)))

// ================= 9. retry 清空 results =================
reset(async (input) => ({ ok: false, message: '失败-' + input.platform }))
const s9 = freshQueue()
const job9 = s9.queue.add({ ...baseInput, title: '重试清空', platforms: ['douyin', 'xiaohongshu'] })
clock = BASE + 3600 * 1000 + 1000
await s9.queue.tick()
const failed9 = s9.queue.list().find((j) => j.id === job9.id)
check('重试前：failed 且 results 两条', failed9.status === 'failed' && failed9.results.length === 2)
const retried9 = s9.queue.retry(job9.id)
check('retry：状态回到 pending', retried9.status === 'pending', retried9.status)
check('retry：results 被清空', Array.isArray(retried9.results) && retried9.results.length === 0)
check('retry：message 被清空', retried9.message === undefined, String(retried9.message))
check('retry：attempts 逻辑不变（仍为 1）', retried9.attempts === 1, String(retried9.attempts))
reset(async (input) => ({ ok: true, message: '发布成功', url: 'https://example.com/' + input.platform }))
clock = BASE + 3600 * 1000 + 2000
await s9.queue.tick()
const afterRetry9 = s9.queue.list().find((j) => j.id === job9.id)
check('retry 后：两个平台重发成功', calls.length === 2 && afterRetry9.status === 'done', calls.map((c) => c.platform).join(','))
check('retry 后：attempts 累加为 2', afterRetry9.attempts === 2, String(afterRetry9.attempts))
check('retry 后：results 两条新的成功结果', afterRetry9.results.length === 2 && afterRetry9.results.every((r) => r.ok))

// ================= 10. IPC 收敛层继续透传多平台 =================
reset()
const ipcQueue = freshQueue().queue
const handlers = new Map()
registerPublishQueue({ handle: (ch, fn) => handlers.set(ch, fn) }, ipcQueue)
const ipcAdd = await handlers.get('queue:add')({}, { ...baseInput, title: 'IPC 多平台', platforms: ['douyin', 'shipinhao'] })
check('IPC：queue:add 接受 platforms 数组', ipcAdd.ok === true && JSON.stringify(ipcAdd.data.platforms) === JSON.stringify(['douyin', 'shipinhao']), JSON.stringify(ipcAdd))
const ipcBad = await handlers.get('queue:add')({}, { ...baseInput, platforms: ['douyin', 'weibo'] })
check('IPC：非法平台返回 ok:false + 中文错误', ipcBad.ok === false && ipcBad.error.includes('平台只能是'), JSON.stringify(ipcBad))
const ipcEmpty = await handlers.get('queue:add')({}, { ...baseInput, platforms: [] })
check('IPC：空平台数组返回 ok:false', ipcEmpty.ok === false && ipcEmpty.error.includes('至少选择一个发布平台'), JSON.stringify(ipcEmpty))
check('IPC：4 个通道仍然齐备', ['queue:list', 'queue:add', 'queue:remove', 'queue:retry'].every((ch) => handlers.has(ch)))

rmSync(dir, { recursive: true, force: true })

console.log('')
if (failures.length === 0) {
  console.log('P31 multi-platform queue SMOKE OK (' + passed + ' checks, 0 failed)')
  process.exit(0)
}
console.log('P31 multi-platform queue SMOKE FAILED (' + (passed + failures.length) + ' checks, ' + failures.length + ' failed)')
for (const f of failures) console.log('  FAIL ' + f)
process.exit(1)
