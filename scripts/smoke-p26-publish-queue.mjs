/**
 * P26 定时发布队列冒烟测试。
 *
 * 不启动 Electron：用 esbuild 把 packages/desktop/src/main/publish-queue.ts 打成 CJS，
 * 注入临时目录、假时钟、假 publish，直接验证排程/到点/失败/重试/持久化/补跑。
 *
 * 运行：node scripts/smoke-p26-publish-queue.mjs
 */
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
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
const { PublishQueue, registerPublishQueue, defaultQueuePath, LATE_MS } = moduleShim.exports

let passed = 0
const failures = []
function check(name, ok, extra) {
  if (ok) {
    passed += 1
  } else {
    failures.push(name + (extra ? ' -> ' + extra : ''))
  }
}

const dir = mkdtempSync(path.join(tmpdir(), 'fcm-queue-'))
const file = path.join(dir, 'publish-queue.json')

let clock = new Date('2026-11-09T01:00:00.000Z').getTime()
const now = () => clock

const calls = []
let responder = async () => ({ ok: true, message: '发布成功', url: 'https://example.com/item/1' })
const publish = async (input) => {
  calls.push(input)
  return responder(input)
}

const made = []
function newQueue() {
  const q = new PublishQueue({ file: () => file, publish, now, log: () => {} })
  made.push(q)
  return q
}

// ---- 1. 校验 ----
const q = newQueue()
const bad = []
for (const [name, input] of [
  ['缺平台', { title: 'x', mediaPaths: ['a.mp4'], scheduledAt: '2026-11-09T02:00:00.000Z' }],
  ['平台非法', { platform: 'weibo', title: 'x', mediaPaths: ['a.mp4'], scheduledAt: '2026-11-09T02:00:00.000Z' }],
  ['缺标题', { platform: 'douyin', mediaPaths: ['a.mp4'], scheduledAt: '2026-11-09T02:00:00.000Z' }],
  ['缺素材', { platform: 'douyin', title: 'x', scheduledAt: '2026-11-09T02:00:00.000Z' }],
  ['时间非法', { platform: 'douyin', title: 'x', mediaPaths: ['a.mp4'], scheduledAt: '明天早上' }],
  ['时间已过', { platform: 'douyin', title: 'x', mediaPaths: ['a.mp4'], scheduledAt: '2026-11-01T02:00:00.000Z' }]
]) {
  try {
    q.add(input)
    bad.push(name + ' 没报错')
  } catch (e) {
    if (!e.message) bad.push(name + ' 报错没有文案')
  }
}
check('6 类非法入参全部被拒', bad.length === 0, bad.join(' / '))

// ---- 2. 正常新增 ----
const job = q.add({
  platform: 'douyin',
  type: 'video',
  title: '测试标题',
  content: '正文内容',
  tags: 'AI, 效率  #干货',
  mediaPaths: 'C:/a.mp4, C:/b.png',
  scheduledAt: '2026-11-09T02:00:00.000Z'
})
check('新增后状态 pending', job.status === 'pending')
check('scheduledAt 归一为 ISO', job.scheduledAt === '2026-11-09T02:00:00.000Z', job.scheduledAt)
check('tags 去掉 # 并按逗号空格切分', JSON.stringify(job.tags) === JSON.stringify(['AI', '效率', '#干货']), JSON.stringify(job.tags))
check('mediaPaths 支持逗号分隔字符串', job.mediaPaths.length === 2, JSON.stringify(job.mediaPaths))
check('id 非空', typeof job.id === 'string' && job.id.length > 5)

// ---- 3. 未到点不触发 ----
check('未到点时 list 有 1 条', q.list().length === 1)
check('未到点时 dueJobs 为空', q.dueJobs().length === 0)
let ran = await q.tick()
check('未到点时 tick 不发', ran.length === 0 && calls.length === 0)

// ---- 4. 到点自动发布 ----
clock = new Date('2026-11-09T02:00:01.000Z').getTime()
check('到点后 dueJobs 命中 1 条', q.dueJobs().length === 1)
ran = await q.tick()
check('tick 执行 1 条', ran.length === 1 && calls.length === 1)
check('发布入参带上标题', calls[0].title === '测试标题')
check('发布入参带上素材', calls[0].mediaPaths.length === 2)
const done = q.list()[0]
check('成功后状态 done', done.status === 'done', done.status)
check('成功后记录作品链接', done.url === 'https://example.com/item/1', String(done.url))
check('成功后记录完成时间', !!done.finishedAt)
check('成功后 attempts=1', done.attempts === 1)
check('再次 tick 不会重复发', (await q.tick()).length === 0 && calls.length === 1)

// ---- 5. 失败分支 ----
responder = async () => ({ ok: false, message: '找不到发布按钮' })
q.add({ platform: 'xiaohongshu', title: '失败用例', mediaPaths: ['c.png'], scheduledAt: '2026-11-09T02:00:00.000Z' })
clock += 1000
await q.tick()
const failed = q.list().find((j) => j.title === '失败用例')
check('publish 返回 ok:false 时状态 failed', failed.status === 'failed', failed.status)
check('失败保留中文原因', failed.message === '找不到发布按钮', String(failed.message))

// ---- 6. 抛异常分支 ----
responder = async () => {
  throw new Error('窗口已关闭')
}
q.add({ platform: 'shipinhao', title: '异常用例', mediaPaths: ['d.mp4'], scheduledAt: '2026-11-09T02:00:00.000Z' })
clock += 1000
await q.tick()
const threw = q.list().find((j) => j.title === '异常用例')
check('publish 抛异常时状态 failed', threw.status === 'failed')
check('异常信息落进 message', threw.message === '窗口已关闭', String(threw.message))

// ---- 7. 重试 ----
responder = async () => ({ ok: true, message: '发布成功', url: 'https://example.com/item/2' })
const retried = q.retry(threw.id)
check('重试后回到 pending', retried.status === 'pending')
check('重试后时间改为现在', Math.abs(new Date(retried.scheduledAt).getTime() - clock) < 1000, retried.scheduledAt)
await q.tick()
const afterRetry = q.list().find((j) => j.id === threw.id)
check('重试成功后 done', afterRetry.status === 'done', afterRetry.status)
let retryErr = ''
try {
  q.retry(afterRetry.id)
} catch (e) {
  retryErr = e.message
}
check('非失败任务不能重试', retryErr.includes('只有失败的任务可以重试'), retryErr)

// ---- 8. 删除 ----
const removable = q.add({ platform: 'douyin', title: '待删', mediaPaths: ['e.mp4'], scheduledAt: '2026-11-09T03:00:00.000Z' })
check('删除返回 true', q.remove(removable.id) === true)
check('删除后列表里没有', !q.list().some((j) => j.id === removable.id))
let delErr = ''
try {
  q.remove('not-exist')
} catch (e) {
  delErr = e.message
}
check('删除不存在的任务报错', delErr.includes('定时任务不存在'), delErr)

// ---- 9. 持久化 + 崩溃恢复 ----
const beforeReload = q.list().length
const reloaded = newQueue()
check('新实例读盘拿到同样的条数', reloaded.list().length === beforeReload, String(reloaded.list().length))
check('新实例读到 done 状态', reloaded.list().some((j) => j.status === 'done'))
check('新实例不会再发已完成任务', (await reloaded.tick()).length === 0)

// 模拟「发布到一半进程被关掉」：文件里留 running
const rawText = readFileSync(file, 'utf8')
const raw = JSON.parse(rawText)
raw.jobs.push({
  id: 'job_crash',
  platform: 'douyin',
  type: 'video',
  title: '崩溃残留',
  content: '',
  tags: [],
  mediaPaths: ['f.mp4'],
  scheduledAt: '2026-11-09T00:00:00.000Z',
  status: 'running',
  attempts: 1,
  createdAt: '2026-11-09T00:00:00.000Z'
})
writeFileSync(file, JSON.stringify(raw), 'utf8')
const recovered = newQueue()
const crashJob = recovered.list().find((j) => j.id === 'job_crash')
check('重启后 running 任务回到 pending', crashJob && crashJob.status === 'pending', crashJob && crashJob.status)
check('补跑时标记 late（超过 10 分钟）', (await recovered.tick()).length >= 1)
check('迟到任务 late=true', recovered.list().find((j) => j.id === 'job_crash').late === true)
check('LATE_MS 为 10 分钟', LATE_MS === 600000, String(LATE_MS))

// ---- 10. 串行执行多条 ----
calls.length = 0
responder = async (input) => {
  await new Promise((r) => setTimeout(r, 5))
  return { ok: true, message: 'ok', url: 'https://example.com/' + input.title }
}
for (const title of ['串行A', '串行B', '串行C']) {
  q.add({ platform: 'douyin', title, mediaPaths: ['g.mp4'], scheduledAt: '2026-11-09T02:00:00.000Z' })
}
clock += 5000
const many = await q.tick()
check('一轮把 3 条到点任务都发完', many.length === 3 && calls.length === 3, String(many.length))
check('按计划时间顺序执行', calls.map((c) => c.title).join(',').startsWith('串行'), calls.map((c) => c.title).join(','))
check('并发 tick 不会重复执行', await (async () => {
  const a = q.tick()
  const b = q.tick()
  const [ra, rb] = await Promise.all([a, b])
  return ra.length === 0 && rb.length === 0
})())

// ---- 11. 坏文件兜底 ----
const brokenFile = path.join(dir, 'broken.json')
writeFileSync(brokenFile, '{ 这不是 JSON', 'utf8')
const broken = new PublishQueue({ file: () => brokenFile, publish, now, log: () => {} })
check('坏文件时返回空队列', broken.list().length === 0)
check('坏文件被备份为 .broken', existsSync(brokenFile + '.broken'))

// ---- 12. IPC 收敛层 ----
const handlers = new Map()
registerPublishQueue({ handle: (ch, fn) => handlers.set(ch, fn) }, q)
check('注册 4 个 queue 通道', ['queue:list', 'queue:add', 'queue:remove', 'queue:retry'].every((ch) => handlers.has(ch)))
const okList = await handlers.get('queue:list')({})
check('queue:list 返回 { ok:true, data:{ items } }', okList.ok === true && Array.isArray(okList.data.items))
const badAdd = await handlers.get('queue:add')({}, { platform: 'nope' })
check('queue:add 非法平台返回 { ok:false, error }', badAdd.ok === false && badAdd.error.includes('平台只能是'), JSON.stringify(badAdd))
const okAdd = await handlers.get('queue:add')({}, { platform: 'douyin', title: 'IPC', mediaPaths: ['h.mp4'], scheduledAt: '2026-11-09T05:00:00.000Z' })
check('queue:add 正常返回 job', okAdd.ok === true && okAdd.data.title === 'IPC')
const okRemove = await handlers.get('queue:remove')({}, { id: okAdd.data.id })
check('queue:remove 正常', okRemove.ok === true && okRemove.data.removed === true)

// ---- 13. 路径助手 ----
check('defaultQueuePath 落在 userData 下', defaultQueuePath('C:/u').replace(/\\/g, '/').endsWith('/u/publish-queue.json'), defaultQueuePath('C:/u'))

rmSync(dir, { recursive: true, force: true })

console.log('')
if (failures.length === 0) {
  console.log('P26 publish-queue SMOKE OK (' + passed + ' checks, 0 failed)')
  process.exit(0)
}
console.log('P26 publish-queue SMOKE FAILED (' + (passed + failures.length) + ' checks, ' + failures.length + ' failed)')
for (const f of failures) console.log('  FAIL ' + f)
process.exit(1)
