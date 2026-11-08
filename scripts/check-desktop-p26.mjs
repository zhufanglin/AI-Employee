/**
 * P26 定时发布桌面端静态检查。
 *
 * 不启动 Electron：直接读源码，确认主进程/预加载/渲染层三处都接上了定时发布，
 * 且定时发布的推送文案与「到点自动发」的语义没被后续改动悄悄去掉。
 *
 * 运行：node scripts/check-desktop-p26.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL('../' + rel, import.meta.url)), 'utf8')

let passed = 0
const failures = []
function check(name, ok, extra) {
  if (ok) passed += 1
  else failures.push(name + (extra ? ' -> ' + extra : ''))
}

// ---- 1. 主进程 ----
const queueSrc = read('packages/desktop/src/main/publish-queue.ts')
check('publish-queue.ts 存在 PublishQueue 类', /class PublishQueue/.test(queueSrc))
check('导出 registerPublishQueue', /export function registerPublishQueue/.test(queueSrc))
check('导出 defaultQueuePath', /export function defaultQueuePath/.test(queueSrc))
check('队列落在 userData 下的 publish-queue.json', /publish-queue\.json/.test(queueSrc))
check('写入用临时文件 + rename', /renameSync\(tmp, path\)/.test(queueSrc))
check('running 任务重启后回到 pending', /status === 'running' \? 'pending'/.test(queueSrc))
check('坏文件备份为 .broken', /path \+ '\.broken'/.test(queueSrc))
check('迟到判定阈值 LATE_MS', /export const LATE_MS = 10 \* 60 \* 1000/.test(queueSrc))
check('串行执行（running 互斥）', /if \(this\.running\) return \[\]/.test(queueSrc))
check('注册 4 个 IPC 通道', ['queue:list', 'queue:add', 'queue:remove', 'queue:retry'].every((ch) => queueSrc.includes("'" + ch + "'")))
check('三个平台白名单', /export const PLATFORMS = \['douyin', 'xiaohongshu', 'shipinhao'\]/.test(queueSrc))

const indexSrc = read('packages/desktop/src/main/index.ts')
check('index.ts 引入 PublishQueue', /import \{ PublishQueue, defaultQueuePath, registerPublishQueue \} from '\.\/publish-queue'/.test(indexSrc))
check('index.ts 用 platform.publish 执行发布', /publish: \(input: any\) => platform!\.publish\(input\)/.test(indexSrc))
check('index.ts 启动定时器', /function startQueueTimer\(\)/.test(indexSrc))
check('定时器 30 秒一轮', /setInterval\(\(\) => \{ void tickQueue\('timer'\) \}, 30000\)/.test(indexSrc))
check('退出时清掉定时器', /if \(queueTimer\) clearInterval\(queueTimer\)/.test(indexSrc))
check('状态变化推给渲染层 queue:event', /webContents\.send\('queue:event'/.test(indexSrc))

// ---- 2. 预加载 ----
const preloadSrc = read('packages/desktop/src/preload/index.ts')
check('preload 暴露 queue.list/add/remove/retry', ['queue:list', 'queue:add', 'queue:remove', 'queue:retry'].every((ch) => preloadSrc.includes("'" + ch + "'")))
check('preload 暴露 queue.onEvent', /onEvent: \(cb:/.test(preloadSrc))

// ---- 3. 渲染层 ----
const typesSrc = read('packages/desktop/src/renderer/src/types.ts')
check('types.ts 声明 queue 能力', /queue: \{/.test(typesSrc))
check('types.ts 声明 ScheduledPublishJob', /export type ScheduledPublishJob = \{/.test(typesSrc))
check('types.ts 声明 ScheduledPublishInput', /export type ScheduledPublishInput = \{/.test(typesSrc))

const pageSrc = read('packages/desktop/src/renderer/src/pages/Scheduled.tsx')
check('定时页有「定时发布」区块', pageSrc.includes('新建定时发布'))
check('定时页有发布队列表格', pageSrc.includes('发布队列'))
check('定时页支持三平台中文名', pageSrc.includes("label: '抖音'") && pageSrc.includes("label: '小红书'") && pageSrc.includes("label: '视频号'"))
check('定时页有四态展示', ['pending', 'running', 'done', 'failed'].every((s) => pageSrc.includes(s + ':')))
check('定时页能选素材', /fcm\.platform\.pickMedia/.test(pageSrc))
check('定时页默认时间在 1 小时后', /Date\.now\(\) \+ 60 \* 60 \* 1000/.test(pageSrc))
check('定时页订阅 queue:event 刷新', /queue\?\.onEvent/.test(pageSrc))
check('定时页失败可重试', pageSrc.includes('重试'))
check('datetime-local 用本地时间不用 toISOString', /function toLocalInput/.test(pageSrc))

// ---- 4. 文档 ----
check('P26 文档存在', existsSync(fileURLToPath(new URL('../docs/handoff/P26-定时发布.md', import.meta.url))))

console.log('')
if (failures.length === 0) {
  console.log('P26 desktop check OK (' + passed + ' checks, 0 failed)')
  process.exit(0)
}
console.log('P26 desktop check FAILED (' + (passed + failures.length) + ' checks, ' + failures.length + ' failed)')
for (const f of failures) console.log('  FAIL ' + f)
process.exit(1)
