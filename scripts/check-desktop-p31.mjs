/**
 * P31 定时发布多平台分发桌面端静态检查。
 *
 * 不启动 Electron：直接读源码，确认主进程（队列/校验/串行/results）、preload 透传、
 * 渲染层（多选表单/逐平台结果）与类型定义都完成了多平台改造，且 P26 语义没被破坏。
 *
 * 运行：node scripts/check-desktop-p31.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'

const read = (rel) => readFileSync(fileURLToPath(new URL('../' + rel, import.meta.url)), 'utf8')

let passed = 0
const failures = []
function check(name, ok, extra) {
  if (ok) passed += 1
  else failures.push(name + (extra ? ' -> ' + extra : ''))
}

// ---- 1. 主进程：多平台队列 ----
const queueSrc = read('packages/desktop/src/main/publish-queue.ts')
check('主进程：PublishResult 类型存在', /export interface PublishResult \{/.test(queueSrc))
check('主进程：job 存 platforms 数组', /platforms: string\[\]/.test(queueSrc))
check('主进程：job 存 results 数组', /results: PublishResult\[\]/.test(queueSrc))
check('主进程：保留 platform 兼容字段', /\/\*\* 兼容老队列文件与老界面：等于 platforms\[0\] \*\/[\s\S]*?platform: string/.test(queueSrc))
check('主进程：platforms 去重 helper', /function dedupePlatforms/.test(queueSrc))
check('主进程：校验入口 normalizePlatforms 已导出', /export function normalizePlatforms/.test(queueSrc))
check('主进程：旧 platform 字段回退兼容', /const single = text\(input\?\.platform\)/.test(queueSrc))
check('主进程：最多 3 个平台', /MAX_PLATFORMS = 3/.test(queueSrc))
check('主进程：超过上限给中文错误', /最多选择 .* 个发布平台/.test(queueSrc))
check('主进程：非法平台给中文错误', /平台只能是 douyin \/ xiaohongshu \/ shipinhao/.test(queueSrc))
check('主进程：三个平台中文名齐全', /douyin: '抖音'/.test(queueSrc) && /xiaohongshu: '小红书'/.test(queueSrc) && /shipinhao: '视频号'/.test(queueSrc))
check('主进程：逐平台串行 for 循环', /for \(const platform of platforms\)/.test(queueSrc))
check('主进程：每个平台结果 push 进 results', /job\.results\.push\(result\)/.test(queueSrc))
check('主进程：每个平台结束立即落盘', /job\.results\.push\(result\)[\s\S]{0,200}this\.save\(\)/.test(queueSrc))
check('主进程：单平台异常不影响后续（循环内 try/catch）', /for \(const platform of platforms\)[\s\S]*?try \{[\s\S]*?catch \(e\)/.test(queueSrc))
check('主进程：全成功 message 带平台数', /个平台全部发布成功/.test(queueSrc))
check('主进程：部分成功记为 done 且带 x\/n 汇总', /succeeded\.length\}\/\$\{total\} 个平台发布成功/.test(queueSrc))
check('主进程：部分成功不触发自动重试（status=done）', /部分成功也记为 done/.test(queueSrc))
check('主进程：全失败 message 汇总每个平台原因', /全部平台发布失败：/.test(queueSrc))
check('主进程：单平台保留 P26 原文案', /total === 1/.test(queueSrc))
check('主进程：retry 清空 results', /重试会把所有平台重发一遍[\s\S]*?job\.results = \[\]/.test(queueSrc))
check('主进程：老队列文件回退读 platform', /function loadPlatforms/.test(queueSrc) && /const single = text\(raw\?\.platform\)/.test(queueSrc))
check('主进程：results 落盘前做结构归一', /function loadResults/.test(queueSrc))

// ---- 2. preload：协议不变，多平台入参原样透传 ----
const preloadSrc = read('packages/desktop/src/preload/index.ts')
check('preload：queue:add 原样透传入参（多平台无需改通道）', /add: \(input: any\) => ipcRenderer\.invoke\('queue:add', input\)/.test(preloadSrc))
check('preload：onEvent 仍可订阅发布进度', /onEvent: \(cb:/.test(preloadSrc))
check('preload：4 个 queue 通道仍在', ['queue:list', 'queue:add', 'queue:remove', 'queue:retry'].every((ch) => preloadSrc.includes("'" + ch + "'")))

// ---- 3. 渲染层类型 ----
const typesSrc = read('packages/desktop/src/renderer/src/types.ts')
check('types：ScheduledPublishResult 与主进程对齐', /export type ScheduledPublishResult = \{[\s\S]*?platform: string[\s\S]*?ok: boolean[\s\S]*?message: string/.test(typesSrc))
check('types：ScheduledPublishJob 带 platforms', /export type ScheduledPublishJob = \{[\s\S]*?platforms: string\[\]/.test(typesSrc))
check('types：ScheduledPublishJob 带 results', /export type ScheduledPublishJob = \{[\s\S]*?results: ScheduledPublishResult\[\]/.test(typesSrc))
check('types：ScheduledPublishInput 带 platforms?', /export type ScheduledPublishInput = \{[\s\S]*?platforms\?:/.test(typesSrc))
check('types：ScheduledPublishInput 的 platform 变为可选兼容字段', /export type ScheduledPublishInput = \{[\s\S]*?platform\?: PlatformId \| string/.test(typesSrc))

// ---- 4. 渲染层页面 ----
const pageSrc = read('packages/desktop/src/renderer/src/pages/Scheduled.tsx')
check('页面：多选状态 selectedPlatforms', /const \[selectedPlatforms, setSelectedPlatforms\]/.test(pageSrc))
check('页面：三个平台用 checkbox 多选', /type="checkbox"/.test(pageSrc) && /selectedPlatforms\.includes\(item\.id\)/.test(pageSrc))
check('页面：有「全选 / 取消全选」', /取消全选/.test(pageSrc) && /toggleAllPlatforms/.test(pageSrc))
check('页面：单个平台可切换', /function togglePlatform/.test(pageSrc))
check('页面：提交时传 platforms 数组', /queueApi\(\)\.add\(\{[\s\S]{0,120}platforms: selectedPlatforms/.test(pageSrc))
check('页面：不再用单选 select 选平台', !/<select value=\{platform\}/.test(pageSrc))
check('页面：队列「平台」列拼接多平台', /job\.platforms[\s\S]{0,120}\.map\(platformName\)\.join\('\/'\)/.test(pageSrc))
check('页面：结果列逐平台展示', /job\.results && job\.results\.length > 0/.test(pageSrc) && /job\.results\.map/.test(pageSrc))
check('页面：结果列有 ✓ / ✗ 标记', /result\.ok \? '✓' : '✗'/.test(pageSrc))
check('页面：未勾选平台时禁止提交', /disabled=\{busy !== '' \|\|[\s\S]*?selectedPlatforms\.length === 0\}/.test(pageSrc))
check('页面：失败平台展示中文原因', /error small[\s\S]{0,800}result\.message/.test(pageSrc))
check('页面：成功平台展示已发布链接', /已发布/.test(pageSrc))
check('页面：提示串行发布耗时', /串行|逐个平台/.test(pageSrc))
check('页面：JSX/TSX 语法可编译', (() => {
  try {
    const out = transformSync(pageSrc, { loader: 'tsx', format: 'esm', target: 'node18' })
    return out.code.length > 0
  } catch (e) {
    failures.push('页面 TSX 编译异常 -> ' + String(e && e.message ? e.message : e))
    return false
  }
})())

// ---- 5. 文档 ----
check('P31 文档存在', existsSync(fileURLToPath(new URL('../docs/handoff/P31-定时多平台分发.md', import.meta.url))))

console.log('')
if (failures.length === 0) {
  console.log('P31 desktop check OK (' + passed + ' checks, 0 failed)')
  process.exit(0)
}
console.log('P31 desktop check FAILED (' + (passed + failures.length) + ' checks, ' + failures.length + ' failed)')
for (const f of failures) console.log('  FAIL ' + f)
process.exit(1)
