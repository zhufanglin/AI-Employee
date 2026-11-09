import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * P25 + P27 桌面端静态检查（不启动 Electron）：
 * 1) P25 作品数据快照能力（platform.stats + platform:stats 通道 + 页面按钮）
 * 2) 登录态误报修正（judgeLogin 不再默认 true、checkStatus 轮询等页面渲染）
 * 3) P27 文件管理 / 定时任务接线（主进程 registerFileOps/registerCronOps + preload + Shell 页签）
 *
 * 跑法：node scripts/check-desktop-p25.mjs
 */

const root = join(import.meta.dirname, '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const has = (name, src, needle) => {
  const ok = typeof src === 'string' && src.includes(needle)
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name)
  return ok
}
const re = (name, src, pattern) => {
  const ok = typeof src === 'string' && pattern.test(src)
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name)
  return ok
}

const platformFile = 'packages/desktop/src/main/platform.ts'
const driversFile = 'packages/desktop/src/main/platform-drivers.ts'
const mainFile = 'packages/desktop/src/main/index.ts'
const preloadFile = 'packages/desktop/src/preload/index.ts'
const shellFile = 'packages/desktop/src/renderer/src/pages/Shell.tsx'
const pageFile = 'packages/desktop/src/renderer/src/pages/PlatformPublish.tsx'
const typesFile = 'packages/desktop/src/renderer/src/types.ts'
const filesPage = 'packages/desktop/src/renderer/src/pages/Workspace.tsx'
const cronPage = 'packages/desktop/src/renderer/src/pages/Scheduled.tsx'
const fileOps = 'packages/desktop/src/main/file-ops.ts'
const cronOps = 'packages/desktop/src/main/cron-ops.ts'

for (const f of [platformFile, driversFile, mainFile, preloadFile, shellFile, pageFile, typesFile, filesPage, cronPage, fileOps, cronOps]) {
  if (!existsSync(join(root, f))) {
    console.log('[FAIL] 缺文件 ' + f)
    process.exit(1)
  }
}

const platformSrc = read(platformFile)
const driversSrc = read(driversFile)
const mainSrc = read(mainFile)
const preloadSrc = read(preloadFile)
const shellSrc = read(shellFile)
const pageSrc = read(pageFile)
const typesSrc = read(typesFile)

let pass = 0
let fail = 0
const check = (ok) => { if (ok) pass++; else fail++ }

// 1. P25 作品数据快照
check(has('platform.ts 定义 PlatformStatsSnapshot', platformSrc, 'export interface PlatformStatsSnapshot'))
check(has('platform.ts 有 STATS_SCRIPT 快照脚本', platformSrc, 'const STATS_SCRIPT'))
check(re('platform.ts 导出 async stats(platform, opts)', platformSrc, /async stats\(platform: string, opts\?: \{ maxChars\?: number \}\)/))
check(has('stats 先打作品数据页 driver.dataUrl', platformSrc, 'await this.navigate(win, driver.dataUrl)'))
check(has('stats 打不开时回落首页', platformSrc, 'await this.navigate(win, driver.homeUrl)'))
check(has('stats 未登录时返回中文提示而不是空数据', platformSrc, '请先点「扫码登录」'))
check(has('stats 截图落到 platform-logs（shotList）', platformSrc, 'private async shotList('))
check(re('stats maxChars 夹在 500-12000', platformSrc, /Math\.min\(Math\.max\(Number\(opts\?\.maxChars\) \|\| 4000, 500\), 12000\)/))

// 2. drivers 新增登录线索与数据页
check(has('drivers 声明 loggedInCues', driversSrc, 'loggedInCues'))
check(has('drivers 声明 dataUrl', driversSrc, 'dataUrl'))
for (const id of ['douyin', 'xiaohongshu', 'shipinhao']) {
  check(re('drivers ' + id + ' 配了 dataUrl', driversSrc, new RegExp('dataUrl:\\s*\'https://[^\']+\'')))
}
// 真机校准（2026-11-09，P34）：旧路由已失效，改为实测可用路由
check(has('drivers 抖音数据页', driversSrc, '/creator-micro/data-center/operation'))
check(has('drivers 小红书数据页', driversSrc, '/statistics/data-analysis'))
check(has('drivers 视频号数据页', driversSrc, '/platform/statistics'))

// 3. 登录态误报修正
check(!platformSrc.includes("    if (probe?.qr || probe?.loginWord) return { loggedIn: false }\n    return { loggedIn: true, nickname: probe?.nickname || '' }"), 'judgeLogin 不再无条件默认已登录')
check(has('judgeLogin 先看登录线索', platformSrc, "if (probe?.qr || probe?.loginWord) return { loggedIn: false }"))
check(has('judgeLogin 用 loggedInCues 确认已登录', platformSrc, 'driver.loggedInCues'))
check(re('judgeLogin 末尾返回未登录', platformSrc, /\/\/ 页面几乎是空的 = 还没渲染出来，这不算已登录\n    return \{ loggedIn: false \}/))
check(re('checkStatus 轮询等待渲染（P29 起最多 8 轮、首轮 600ms）', platformSrc, /for \(let i = 0; i < 8; i\+\+\)\s*\{\s*await sleep\(i === 0 \? 600 : 900\)/))
check(has('checkStatus 正文超过 120 字即停（P29 提速）', platformSrc, 'text.length > 120'))

// 4. 主进程接线
check(has('main 引入 registerFileOps', mainSrc, "import { registerFileOps } from './file-ops'"))
check(has('main 引入 registerCronOps', mainSrc, "import { registerCronOps } from './cron-ops'"))
check(has('main 工作区根 = userData/workspace', mainSrc, "join(app.getPath('userData'), 'workspace')"))
check(has('main 注册文件 IPC', mainSrc, 'registerFileOps(ipcMain, { root: workspaceRoot })'))
check(has('main 注册定时 IPC', mainSrc, 'registerCronOps(ipcMain, { api })'))
check(has('main 有 platform:stats 通道', mainSrc, "ipcMain.handle('platform:stats'"))
check(has('platform_stats 调真实 stats()', mainSrc, 'await platform.stats(String(args.platform'))
check(!mainSrc.includes('作品数据统计暂未实现'), 'platform_stats 不再是占位实现')

// 5. preload 暴露
for (const ch of ['files:list', 'files:read', 'files:write', 'files:mkdir', 'files:rename', 'files:delete', 'files:reveal', 'files:open']) {
  check(has('preload 暴露 ' + ch, preloadSrc, "'" + ch + "'"))
}
for (const ch of ['cron:list', 'cron:create', 'cron:delete']) {
  check(has('preload 暴露 ' + ch, preloadSrc, "'" + ch + "'"))
}
check(has('preload 暴露 platform:stats', preloadSrc, "'platform:stats'"))

// 6. 渲染层
check(has('Shell 引入 Workspace', shellSrc, "import Workspace from './Workspace'"))
check(has('Shell 引入 Scheduled', shellSrc, "import Scheduled from './Scheduled'"))
check(has('Shell 有文件页签', shellSrc, "setTab('files')"))
check(has('Shell 有定时任务页签', shellSrc, "setTab('scheduled')"))
check(has('Shell 渲染 Workspace', shellSrc, '<Workspace />'))
check(has('Shell 渲染 Scheduled', shellSrc, '<Scheduled />'))
check(has('发布页有数据快照按钮', pageSrc, '数据快照'))
check(has('发布页调 platform.stats', pageSrc, 'window.fcm.platform.stats('))
check(has('发布页展示快照文案', pageSrc, 'platform-stats-text'))
check(has('types 定义 PlatformStatsSnapshot', typesSrc, 'export type PlatformStatsSnapshot'))
check(has('types 定义 FileListData', typesSrc, 'export type FileListData'))
check(has('types 定义 CronOpResult', typesSrc, 'export type CronOpResult'))
check(has('types 暴露 files 桥', typesSrc, 'files: {'))
check(has('types 暴露 cron 桥', typesSrc, 'cron: {'))

// 7. 子 Agent 模块仍未回退
check(has('file-ops 仍旧拦截越界路径', read(fileOps), "export const ERR_OUTSIDE = '路径超出工作区范围'"))
check(has('cron-ops 仍旧包 { ok, data, error }', read(cronOps), 'cron:create'))

console.log('')
if (fail === 0) console.log('P25/P27 desktop check OK (' + pass + ' checks)')
else console.log('P25/P27 desktop check FAILED (' + pass + ' passed, ' + fail + ' failed)')
process.exit(fail === 0 ? 0 : 1)
