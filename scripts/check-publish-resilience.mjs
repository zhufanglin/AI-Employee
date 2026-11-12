/**
 * P26+ 平台发布韧性自测（零新增依赖）。
 *
 * 覆盖四件事：
 *   1) 发布前登录态预检：未登录不调 publish、文案可操作、job.error 与结果文案一致；
 *   2) 瞬时失败判定函数：6 个瞬时样本断言 true + 4 个稳定业务失败断言 false；
 *   3) 自动重试：瞬时失败重试 1 次（sleep 8 秒、results[i].retried=true），重试上限后不再试；
 *   4) 重启恢复：running 任务加载后变 pending，scheduledAt 已过仍会立刻执行。
 *
 * 做法：把主进程两个纯 TS 模块复制到临时目录并改成 .mts，靠 Node 24 内置的 type stripping
 * 直接 import —— 不启动 Electron、不引入任何新依赖。
 *
 * 运行：<node> scripts/check-publish-resilience.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(root, rel), 'utf8')

let passed = 0
const failures = []
function check(name, ok, extra) {
  if (ok) passed += 1
  else failures.push(name + (extra ? ' -> ' + extra : ''))
}

// ---------- 0. 静态断言：接线没被后续改动拆掉 ----------
const queueSrc = read('packages/desktop/src/main/publish-queue.ts')
const indexSrc = read('packages/desktop/src/main/index.ts')
const resilienceSrc = read('packages/desktop/src/main/publish-resilience.ts')

check('queue 引入韧性模块', /from '\.\/publish-resilience'/.test(queueSrc))
check('queue 依赖里声明 status 预检', /status\?: \(platform: string, opts\?: \{ maxAgeMs\?: number \}\) => Promise<any>/.test(queueSrc))
check('登录态预检绕过 5 分钟缓存（maxAgeMs: 0）', /maxAgeMs: 0/.test(queueSrc))
check('未登录文案可操作', queueSrc.includes('未登录，请到「平台发布」页点「扫码登录」后再试'))
check('未登录结果标记 stage=登录', /stage: '登录'/.test(queueSrc))
check('失败结果落 error 字段', /error: message/.test(queueSrc))
check('失败结果落 screenshots 字段', /screenshots: screenshots\.length > 0 \? screenshots : undefined/.test(queueSrc))
check('失败结果落 stage 字段（透传或推断）', /text\(published\?\.stage\) \|\| derivePublishStage/.test(queueSrc))
check('job.error 与平台失败文案一致', /if \(!result\.ok && !job\.error\) job\.error = result\.error \|\| result\.message/.test(queueSrc))
check('瞬时失败才重试', /isTransientPublishError\(result\.error \|\| result\.message\)/.test(queueSrc))
check('重试前 sleep 8 秒', /PLATFORM_RETRY_DELAY_MS/.test(queueSrc) && /PLATFORM_RETRY_DELAY_MS = 8 \* 1000/.test(resilienceSrc))
check('重试次数受 PLATFORM_RETRY_TIMES 上限约束', /retriedTimes < PLATFORM_RETRY_TIMES/.test(queueSrc))
check('重试后标记 retried=true', /result\.retried = true/.test(queueSrc))
check('加载时 running → pending', /status: status === 'running' \? 'pending' : status/.test(queueSrc))
check('加载时保留多平台 results', /results: loadResults\(raw\.results\)/.test(queueSrc))
check('到点判定包含已过时间（<= now）', /parseWhen\(job\.scheduledAt\) <= now/.test(queueSrc))
check('index.ts 注入 platform.status 预检', /status: \(id: string, opts\?: \{ maxAgeMs\?: number \}\) => platform!\.status\(id, opts\)/.test(indexSrc))
check('publish-resilience 纯函数无外部 import', !/^import /m.test(resilienceSrc))

// ---------- 1. 把纯 TS 模块加载起来 ----------
const tempDir = mkdtempSync(join(tmpdir(), 'fcm-publish-resilience-'))
process.on('exit', () => {
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {
    /* 忽略清理失败 */
  }
})

function copyModule(rel, outName, replacements = []) {
  let src = read(rel)
  for (const [from, to] of replacements) src = src.split(from).join(to)
  const out = join(tempDir, outName)
  writeFileSync(out, src, 'utf8')
  return pathToFileURL(out).href
}

const resilienceUrl = copyModule('packages/desktop/src/main/publish-resilience.ts', 'publish-resilience.mts')
const queueUrl = copyModule('packages/desktop/src/main/publish-queue.ts', 'publish-queue.mts', [
  ["from './publish-resilience'", "from './publish-resilience.mts'"]
])

const resilience = await import(resilienceUrl)
const queueModule = await import(queueUrl)
const { PublishQueue } = queueModule
const {
  PLATFORM_RETRY_TIMES,
  PLATFORM_RETRY_DELAY_MS,
  isTransientPublishError,
  transientErrorKind,
  shouldRetryPlatform,
  derivePublishStage
} = resilience

// ---------- 2. 瞬时失败判定：6 个 true 样本 + 4 个 false 样本 ----------
const transientSamples = [
  ['等待上传完成超时（120000ms）', '超时'],
  ['页面没有响应（renderer process unresponsive）', '页面没有响应'],
  ['net::ERR_ABORTED (-3) loading https://creator.douyin.com', 'ERR_ABORTED'],
  ['net::ERR_CONNECTION_RESET', 'net::'],
  ['视频文件加载失败，请稍后重试', '加载失败'],
  ['Target closed', 'target closed']
]
for (const [sample, expectedKind] of transientSamples) {
  check('瞬时样本 true：' + sample, isTransientPublishError(sample) === true)
  check('瞬时归类：' + sample, transientErrorKind(sample) === expectedKind, transientErrorKind(sample))
}

const stableSamples = [
  '还没有选中图片，请先选择素材',
  '标题过长，最多 20 字',
  '抖音未登录，请到「平台发布」页点「扫码登录」后再试',
  '视频号 暂不支持发布图文（图片）'
]
for (const sample of stableSamples) {
  check('稳定失败样本 false：' + sample, isTransientPublishError(sample) === false)
}

// ---------- 3. 重试上限（纯函数 + 运行时行为） ----------
check('重试上限常量 = 1', PLATFORM_RETRY_TIMES === 1, String(PLATFORM_RETRY_TIMES))
check('重试等待 = 8000ms', PLATFORM_RETRY_DELAY_MS === 8000, String(PLATFORM_RETRY_DELAY_MS))
check('第 0 次可重试瞬时失败', shouldRetryPlatform(0, { ok: false, message: 'net::ERR_CONNECTION_RESET' }) === true)
check('第 1 次不再重试（上限）', shouldRetryPlatform(1, { ok: false, message: 'net::ERR_CONNECTION_RESET' }) === false)
check('稳定业务失败不重试', shouldRetryPlatform(0, { ok: false, message: '还没有选中图片，请先选择素材' }) === false)
check('成功结果不重试', shouldRetryPlatform(0, { ok: true, message: '发布成功' }) === false)

// ---------- 4. 阶段推断 ----------
const stageCases = [
  [[{ step: '打开创作后台', ok: true }, { step: '上传素材', ok: false }], '', '上传'],
  [[{ step: '填写标题', ok: false }], '', '填写'],
  [[{ step: '点击发布', ok: false }], '', '提交'],
  [[{ step: '等待发布结果', ok: false }], '', '判定'],
  [[], '上传失败：找不到文件输入框', '上传'],
  [[], '', '提交']
]
for (const [steps, message, expected] of stageCases) {
  check(
    '阶段推断 ' + (steps.map((s) => s.step).join('→') || '无步骤') + ' / ' + (message || '无文案') + ' => ' + expected,
    derivePublishStage(steps, message) === expected,
    derivePublishStage(steps, message)
  )
}

// ---------- 5. 队列行为：登录预检 / 自动重试 / 重启恢复 ----------
function makeQueue(deps = {}) {
  const dir = mkdtempSync(join(tempDir, 'q-'))
  return new PublishQueue({
    file: () => join(dir, 'publish-queue.json'),
    publish: async () => ({ ok: true, message: '发布成功' }),
    log: () => {},
    notify: () => {},
    sleep: async () => {},
    ...deps
  })
}

function addJob(queue, nowMs, platforms = ['douyin']) {
  return queue.add({
    platforms,
    type: 'video',
    title: '韧性自测',
    content: '正文',
    tags: ['测试'],
    mediaPaths: ['C:\\fake\\video.mp4'],
    scheduledAt: new Date(nowMs - 1000).toISOString()
  })
}

const tickWithClock = async (queue) => {
  const ran = await queue.tick()
  return ran
}

// 5.1 未登录：不调 publish、文案与 job.error 一致
{
  const clock = Date.now()
  let publishCalls = 0
  const statusCalls = []
  const queue = makeQueue({
    now: () => clock,
    status: async (platform, opts) => {
      statusCalls.push({ platform, opts })
      return [{ platform, name: '抖音', loggedIn: false, checkedAt: new Date(clock).toISOString() }]
    },
    publish: async () => {
      publishCalls += 1
      return { ok: true, message: '不该被调用' }
    }
  })
  addJob(queue, clock)
  const ran = await tickWithClock(queue, clock)
  const job = queue.list()[0]
  const expected = '抖音未登录，请到「平台发布」页点「扫码登录」后再试'
  check('未登录：tick 执行了该任务', ran.length === 1)
  check('未登录：没有调用 publish', publishCalls === 0, String(publishCalls))
  check('未登录：status 传入 maxAgeMs=0 绕过缓存', statusCalls.length === 1 && statusCalls[0].opts?.maxAgeMs === 0, JSON.stringify(statusCalls))
  check('未登录：结果文案可操作', job.results[0]?.message === expected, job.results[0]?.message)
  check('未登录：job.error 与结果同文案', job.error === expected, job.error)
  check('未登录：结果 stage=登录', job.results[0]?.stage === '登录', job.results[0]?.stage)
  check('未登录：job 记为 failed', job.status === 'failed', job.status)
}

// 5.2 瞬时失败 → 自动重试 1 次 → 成功，sleep 8000，retried=true
{
  const clock = Date.now()
  let publishCalls = 0
  const sleeps = []
  const queue = makeQueue({
    now: () => clock,
    status: async (platform) => [{ platform, loggedIn: true }],
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    publish: async () => {
      publishCalls += 1
      if (publishCalls === 1) {
        return {
          ok: false,
          message: '发布失败：等待上传完成超时（120000ms）',
          screenshots: ['C:\\shots\\upload-timeout.png'],
          steps: [{ step: '上传素材', ok: false, detail: '超时' }]
        }
      }
      return { ok: true, message: '发布成功：已提交', url: 'https://example.com/p/1' }
    }
  })
  addJob(queue, clock)
  await tickWithClock(queue, clock)
  const job = queue.list()[0]
  check('重试：publish 调用 2 次（1 次 + 重试 1 次）', publishCalls === 2, String(publishCalls))
  check('重试：重试前 sleep 8000ms', sleeps.length === 1 && sleeps[0] === 8000, JSON.stringify(sleeps))
  check('重试：成功后 retried=true', job.results[0]?.retried === true)
  check('重试：成功后 job done', job.status === 'done', job.status)
  check('重试：成功后 job.error 为空', job.error === undefined, String(job.error))
}

// 5.3 一直瞬时失败：最多 1 次重试，结果带截图/阶段/错误
{
  const clock = Date.now()
  let publishCalls = 0
  const queue = makeQueue({
    now: () => clock,
    status: async (platform) => [{ platform, loggedIn: true }],
    publish: async () => {
      publishCalls += 1
      return {
        ok: false,
        message: 'net::ERR_CONNECTION_RESET',
        screenshots: ['C:\\shots\\failed.png'],
        steps: [{ step: '等待发布结果', ok: false, detail: 'net::ERR_CONNECTION_RESET' }]
      }
    }
  })
  addJob(queue, clock)
  await tickWithClock(queue, clock)
  const job = queue.list()[0]
  check('重试上限：publish 只调用 2 次', publishCalls === 2, String(publishCalls))
  check('重试上限：结果 retried=true', job.results[0]?.retried === true)
  check('重试上限：job failed', job.status === 'failed', job.status)
  check('重试上限：结果 error 保留原文', job.results[0]?.error === 'net::ERR_CONNECTION_RESET', job.results[0]?.error)
  check('重试上限：结果 stage=判定', job.results[0]?.stage === '判定', job.results[0]?.stage)
  check(
    '重试上限：job.error 与失败文案一致',
    job.error === 'net::ERR_CONNECTION_RESET',
    job.error
  )
}

// 5.4 稳定业务失败：一次就停，不重试
{
  const clock = Date.now()
  let publishCalls = 0
  const sleeps = []
  const queue = makeQueue({
    now: () => clock,
    status: async (platform) => [{ platform, loggedIn: true }],
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    publish: async () => {
      publishCalls += 1
      return { ok: false, message: '还没有选中图片，请先选择素材', screenshots: [], steps: [{ step: '上传素材', ok: false }] }
    }
  })
  addJob(queue, clock)
  await tickWithClock(queue, clock)
  const job = queue.list()[0]
  check('稳定失败：publish 只调用 1 次', publishCalls === 1, String(publishCalls))
  check('稳定失败：没有 sleep', sleeps.length === 0, JSON.stringify(sleeps))
  check('稳定失败：retried 不为 true', job.results[0]?.retried !== true)
  check('稳定失败：截图落盘为数组（空数组不写）', job.results[0]?.screenshots === undefined)
}

// 5.5 重启恢复：running → pending，已过点立即重跑，旧 results 保留后重发
{
  const clock = Date.now()
  const dir = mkdtempSync(join(tempDir, 'recover-'))
  const file = join(dir, 'publish-queue.json')
  const past = new Date(clock - 60 * 60 * 1000).toISOString()
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      jobs: [
        {
          id: 'job_recover',
          platform: 'douyin',
          platforms: ['douyin', 'xiaohongshu'],
          results: [{ platform: 'douyin', ok: true, message: '发布成功', url: 'https://example.com/old' }],
          type: 'video',
          title: '崩溃恢复',
          content: '正文',
          tags: [],
          mediaPaths: ['C:\\fake\\video.mp4'],
          scheduledAt: past,
          status: 'running',
          attempts: 1,
          createdAt: past
        }
      ]
    }),
    'utf8'
  )
  const calls = []
  const queue = new PublishQueue({
    file: () => file,
    now: () => clock,
    log: () => {},
    notify: () => {},
    sleep: async () => {},
    status: async (platform) => [{ platform, loggedIn: true }],
    publish: async (input) => {
      calls.push(input.platform)
      return { ok: true, message: '发布成功' }
    }
  })
  const loaded = queue.list()[0]
  check('恢复：running 变 pending', loaded.status === 'pending', loaded.status)
  check('恢复：旧多平台 results 保留', loaded.results.length === 1 && loaded.results[0].platform === 'douyin')
  check('恢复：盘上状态也改回 pending', JSON.parse(readFileSync(file, 'utf8')).jobs[0].status === 'pending')
  check('恢复：已过 scheduledAt 仍被视为到点', queue.dueJobs().length === 1)
  await queue.tick()
  const job = queue.list()[0]
  check('恢复：立即执行并重发所有平台', calls.length === 2 && calls[0] === 'douyin' && calls[1] === 'xiaohongshu', JSON.stringify(calls))
  check('恢复：attempts 继续累加', job.attempts === 2, String(job.attempts))
  check('恢复：全部成功后 done', job.status === 'done', job.status)
}

// 5.6 多平台：一个未登录不影响其它平台继续发
{
  const clock = Date.now()
  const published = []
  const queue = makeQueue({
    now: () => clock,
    status: async (platform) => [{ platform, loggedIn: platform !== 'douyin' }],
    publish: async (input) => {
      published.push(input.platform)
      return { ok: true, message: '发布成功' }
    }
  })
  addJob(queue, clock, ['douyin', 'xiaohongshu'])
  await tickWithClock(queue)
  const job = queue.list()[0]
  check('多平台：未登录平台不中断后续平台', published.length === 1 && published[0] === 'xiaohongshu', JSON.stringify(published))
  check('多平台：两个平台都有结果', job.results.length === 2)
  check('多平台：部分成功记为 done', job.status === 'done', job.status)
  check('多平台：job.error 记录失败平台文案', job.error === '抖音未登录，请到「平台发布」页点「扫码登录」后再试', job.error)
}

// ---------- 汇总 ----------
console.log('')
if (failures.length === 0) {
  console.log('Publish resilience check OK (' + passed + ' checks, 0 failed)')
  process.exit(0)
}
console.log('Publish resilience check FAILED (' + (passed + failures.length) + ' checks, ' + failures.length + ' failed)')
for (const f of failures) console.log('  FAIL ' + f)
process.exit(1)
