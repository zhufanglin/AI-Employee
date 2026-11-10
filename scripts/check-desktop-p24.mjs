#!/usr/bin/env node
/**
 * P24 桌面端静态检查：平台发布页 + 本机 RPA 模块 + preload/main 接线 + 能力拦截。
 * 用法：node scripts/check-desktop-p24.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..')
const desktop = path.join(root, 'packages', 'desktop', 'src')
const page = path.join(desktop, 'renderer', 'src', 'pages', 'PlatformPublish.tsx')
const shellPage = path.join(desktop, 'renderer', 'src', 'pages', 'Shell.tsx')
const preloadFile = path.join(desktop, 'preload', 'index.ts')
const mainFile = path.join(desktop, 'main', 'index.ts')
const typesFile = path.join(desktop, 'renderer', 'src', 'types.ts')
const stylesFile = path.join(desktop, 'renderer', 'src', 'styles.css')
const platformFile = path.join(desktop, 'main', 'platform.ts')
const driversFile = path.join(desktop, 'main', 'platform-drivers.ts')
const workerLoop = path.join(root, 'packages', 'worker', 'tool-loop.mjs')
const serverCapFile = path.join(root, 'packages', 'server', 'src', 'capabilities', 'capability.service.ts')

let checks = 0
let failed = 0
function read(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}
function check(name, condition, detail) {
  checks += 1
  if (condition) console.log('[PASS] ' + name + (detail ? ' :: ' + detail : ''))
  else { failed += 1; console.log('[FAIL] ' + name + (detail ? ' :: ' + detail : '')) }
}

const pageSrc = read(page)
const shell = read(shellPage)
const preload = read(preloadFile)
const main = read(mainFile)
const types = read(typesFile)
const styles = read(stylesFile)
const platformSrc = read(platformFile)
const drivers = read(driversFile)
const worker = read(workerLoop)
const serverCap = read(serverCapFile)

// 1. 本机 RPA 模块
check('platform.ts 存在', !!platformSrc, platformSrc ? platformFile : 'missing')
check('platform.ts 导出 PlatformManager', !!platformSrc && /export class PlatformManager/.test(platformSrc))
for (const method of ['status', 'login', 'logout', 'publish', 'openDebug']) {
  check('PlatformManager 有 ' + method + '()', !!platformSrc && new RegExp('async ' + method + '\\(').test(platformSrc))
}
check('platform.ts 用持久化 partition', !!platformSrc && /persist:platform-/.test(platformSrc))
check('platform.ts 用 CDP 设置文件输入', !!platformSrc && /DOM\.setFileInputFiles/.test(platformSrc))
check('platform.ts 每步截图', !!platformSrc && /capturePage\(\)/.test(platformSrc))
check('platform.ts 写截图目录 platform-logs', !!platformSrc && /platform-logs/.test(platformSrc))
check('发布前先判登录态（避免选择器错误误导用户）', !!platformSrc && platformSrc.includes("run('检查登录状态'"))
check('未登录提示可照做（点扫码登录）', !!platformSrc && platformSrc.includes('请在「发布」页点「扫码登录」完成登录后再发布'))
check('platform-drivers.ts 存在', !!drivers, drivers ? driversFile : 'missing')
for (const id of ['douyin', 'xiaohongshu', 'shipinhao']) {
  check('drivers 含平台 ' + id, !!drivers && new RegExp(id + ':\\s*\\{').test(drivers))
}
check('drivers 导出 buildContent', !!drivers && /export function buildContent/.test(drivers))
check('drivers 导出 clampTitle', !!drivers && /export function clampTitle/.test(drivers))

// 2. 页面
check('PlatformPublish.tsx 存在', !!pageSrc)
for (const method of ['status', 'login', 'logout', 'publish', 'openDebug', 'pickMedia']) {
  check('页面调用 platform.' + method, !!pageSrc && pageSrc.includes('platform.' + method + '('))
}
check('页面提示扫码登录', !!pageSrc && pageSrc.includes('扫码登录'))
check('页面展示步骤结果', !!pageSrc && pageSrc.includes('platform-steps'))
check('页面展示截图路径', !!pageSrc && pageSrc.includes('screenshots'))

// 3. preload / main / Shell / types / css
check('preload 有 platform 域', !!preload && /platform:\s*\{/.test(preload))
for (const ch of ['status', 'login', 'logout', 'publish', 'open-debug', 'pick-media']) {
  check("preload 转发 platform:" + ch, !!preload && preload.includes("'platform:" + ch + "'"))
}
for (const ch of ['platform:status', 'platform:login', 'platform:logout', 'platform:publish', 'platform:open-debug', 'platform:pick-media']) {
  check("main 有 handler '" + ch + "'", !!main && main.includes("ipcMain.handle('" + ch + "'"))
}
check('main 拦截本机能力 LOCAL_CAPABILITIES', !!main && main.includes('LOCAL_CAPABILITIES'))
for (const name of ['platform_publish', 'platform_status', 'platform_stats']) {
  check('main 拦截 ' + name, !!main && main.includes("'" + name + "'"))
}
check('main 在 /capabilities/run 前分流', !!main && main.includes("path === '/capabilities/run'"))
// 0.1.10：安装版残留 127.0.0.1 服务端地址会直接 fetch failed，必须自动纠正并给可读报错
check('main 纠正安装版的回环服务端地址', !!main && main.includes('isLoopbackBase') && main.includes('app.isPackaged') && main.includes('已改回默认服务端'))
check('main 网络失败给出可读中文提示', !!main && main.includes('连不上服务器（') && main.includes('请检查网络，或到「设置」里更换服务器地址'))
check("Shell Tab 含 'platform'", !!shell && shell.includes("'platform'"))
check('Shell 含 📤 平台发布 导航', !!shell && shell.includes('📤 平台发布'))
check('Shell 渲染 PlatformPublish', !!shell && shell.includes('<PlatformPublish />'))
check('types.ts 有 platform 域与 PlatformStatus', !!types && types.includes('platform: {') && types.includes('PlatformStatus'))
check('styles.css 含平台页样式', !!styles && styles.includes('.platform-card') && styles.includes('.platform-steps'))

// 3.1 平台窗口的 UA 与导航就绪判定（0.1.7 修：小红书/视频号屏蔽 Electron UA）
check('platform.ts 定义 Chrome UA', !!platformSrc && platformSrc.includes('const PLATFORM_UA'))
check('platform.ts 给分区设 UA', !!platformSrc && platformSrc.includes('.setUserAgent(PLATFORM_UA)'))
check('platform.ts 轮询 READY_SCRIPT 判就绪', !!platformSrc && platformSrc.includes('const READY_SCRIPT') && platformSrc.includes('executeJavaScript(READY_SCRIPT)'))
check('navigate 不再依赖 load 事件', !!platformSrc && !platformSrc.includes('打开页面超时（'))
check('platform.ts 有窗口关闭赛跑 untilClosed', !!platformSrc && platformSrc.includes('private async untilClosed'))
check('navigate 就绪探针受窗口关闭保护', !!platformSrc && /untilClosed\([\s\S]{0,80}executeJavaScript\(READY_SCRIPT\)/.test(platformSrc))
check('attachAndEval 有取值超时 EVAL_TIMEOUT_MS', !!platformSrc && platformSrc.includes('const EVAL_TIMEOUT_MS') && platformSrc.includes('页面脚本取值超时'))
check('doLogin 窗口关闭后立即返回中文提示', !!platformSrc && platformSrc.includes('登录窗口已关闭（未完成登录）') && platformSrc.includes('userClosed'))
check('登录弹窗关闭后不再卡住串行锁', !!platformSrc && platformSrc.includes('await this.untilClosed(win, sleep(LOGIN_POLL_MS))'))
check('checkStatus 对空探针不误判已登录', !!platformSrc && platformSrc.includes('页面没有响应，未能检查登录态'))
check('页面登录加了超时兜底 withTimeout', !!pageSrc && pageSrc.includes('function withTimeout<T>') && pageSrc.includes('登录等待超时'))
// 0.1.9 修：untilClosed 里早先挂了 task.then(done)，任务一成功就先把 closed 解成 null，
// 导致 navigate 永远拿不到快照（「打开后台」报「页面没有响应」/「窗口已关闭」）
check('untilClosed 不再让任务成功也解成 null', !!platformSrc && !platformSrc.includes('task.then(done, done)'))
check('untilClosed 由 closed 事件解 null', !!platformSrc && platformSrc.includes('const onClosed = () =>') && platformSrc.includes('win.once(\'closed\', onClosed)'))
check('navigate 每次取值有 2 秒上限', !!platformSrc && platformSrc.includes('const NAV_EVAL_WAIT_MS') && /Promise.race\(\[[\s\S]{0,120}NAV_EVAL_WAIT_MS/.test(platformSrc))
check('打开后台超时不再弹报错', !!platformSrc && platformSrc.includes('const OPEN_DEBUG_TIMEOUT_MS') && platformSrc.includes('已打开窗口，页面还在加载'))

// 0.1.14 修：用户实测「等完刷新登录状态、切页面回来又要重新检查，还得继续等」
check('platform.ts 登录态结果有缓存窗口', !!platformSrc && platformSrc.includes('export const STATUS_CACHE_MS') && platformSrc.includes('this.statusCache'))
check('status 支持强制重查（刷新按钮）', !!platformSrc && platformSrc.includes('opts: { maxAgeMs?: number }') && !!main && main.includes('maxAgeMs: p?.force ? 0 : undefined'))
check('不确定的检查结果不进缓存', !!platformSrc && platformSrc.includes('uncertain') && platformSrc.includes('/没有响应|检查失败/'))
check('退出登录会清掉缓存', !!platformSrc && platformSrc.includes('this.statusCache.delete(platform)'))
check('渲染层切页复用登录态（不再重查十几秒）', !!pageSrc && pageSrc.includes('RENDERER_CACHE_MS') && pageSrc.includes('rememberStatus'))
check('刷新按钮走强制重查', !!pageSrc && pageSrc.includes('void refresh(true)') && pageSrc.includes('{ force: true }'))
check('preload/types 透出 force 参数', !!preload && preload.includes('force?: boolean') && !!types && types.includes('force?: boolean'))

// 0.1.15 P29：窗口复用 + 并行检查 + 拦掉外部协议（Windows 弹「Microsoft Store 查找应用」的真凶）
check('platform.ts 复用常驻窗口池', !!platformSrc && platformSrc.includes('private readonly windows = new Map<string, BrowserWindow>()') && platformSrc.includes('private ensureWindow('))
check('用完只隐藏不销毁（下次直接复用）', !!platformSrc && /private closeWindow\([\s\S]{0,220}win\.hide\(\)/.test(platformSrc))
check('退出登录真的销毁窗口', !!platformSrc && platformSrc.includes('private destroyWindow(') && platformSrc.includes('this.destroyWindow(this.windows.get(platform) || null)'))
check('应用退出时清掉常驻窗口', !!platformSrc && platformSrc.includes('disposeAll()') && !!main && main.includes('platform?.disposeAll()'))
check('三个平台并行查登录态', !!platformSrc && platformSrc.includes('const jobs = ids.map(async (id) =>') && platformSrc.includes('return Promise.all(jobs)'))
check('非 HTTP(S) 协议请求被拦掉', !!platformSrc && platformSrc.includes('ALLOWED_SCHEME') && platformSrc.includes('onBeforeRequest'))
check('协议守卫每个分区只挂一次', !!platformSrc && platformSrc.includes('private readonly guarded = new Set<string>()') && platformSrc.includes('this.guarded.has(partition)'))
check('窗口池支持预热（扫码弹窗更快）', !!platformSrc && platformSrc.includes('warmUp(platform?: string): void') && !!preload && preload.includes("invoke('platform:warm'"))
check('隐藏窗口不做后台节流', !!platformSrc && platformSrc.includes('backgroundThrottling: false'))
check('发布页进入时先预热窗口', !!pageSrc && pageSrc.includes('window.fcm.platform.warm?.()'))

// 0.1.20：修「platform:status → TypeError: Object has been destroyed」
check('窗口显示/隐藏都有销毁守卫', !!platformSrc && platformSrc.includes('private safeShowInactive(') && platformSrc.includes('private safeHide('))
check('platform:status 单平台异常不冒泡到 IPC', !!platformSrc && platformSrc.includes("this.log('[' + id + '] 登录态检查异常：' + msg)"))
check('平台 IPC 统一兜底并落盘堆栈', !!main && main.includes('const guardPlatform = (name: string') && main.includes('has been destroyed'))
check('分区 cookie 读的是 partitionOf（旧代码误写 this.partition）', !!platformSrc && platformSrc.includes('session.fromPartition(this.partitionOf(platform))'))

// 0.1.21：修「点平台发布就弹出视频号助手窗口」（status 为了渲染把窗口显示出来了）
check('登录态检查用 0 透明度显示窗口（不弹窗）', !!platformSrc && platformSrc.includes('private showForRender(') && platformSrc.includes('win.setOpacity(0)'))
check('登录态检查走 showForRender 而不是直接 showInactive', !!platformSrc && platformSrc.includes('if (driver.needsVisibleWindow) this.showForRender(win)'))
check('隐藏/复显窗口都会恢复不透明度', !!platformSrc && /hide\(\)\s*\n?\s*win\.setOpacity\(1\)/.test(platformSrc) && platformSrc.includes('existing.setOpacity(1)'))
check('渲染用窗口文本过短会落日志（排障）', !!platformSrc && platformSrc.includes('页面文本过短'))
check('页面自身跳转导致的 ERR_ABORTED 不再误判为打不开', !!platformSrc && platformSrc.includes('const movedOn = !!startHref && last.href !== startHref'))
check('导航超时前做终检（慢冷启动不误报打开失败）', !!platformSrc && platformSrc.includes('超时终检发现页面其实已就绪'))
check('导航失败后继续探页面（不再直接报登录态检查失败）', !!platformSrc && platformSrc.includes('打开页面未成功，继续尝试读取页面'))
check('导航失败时探测轮次加长', !!platformSrc && platformSrc.includes('const rounds = navError ? 15 : 8'))
check('查登录态不缩短导航超时（避免误判未登录）', !!platformSrc && platformSrc.includes('不要在这里砍超时') && !platformSrc.includes('STATUS_NAV_TIMEOUT_MS'))

// 0.1.22：视频号「发表动态页脏表单」把后续导航全拦掉（comments/stats 打不开评论页/数据页）
check('评论/数据页导航被脏表单拦住时重建窗口重试', !!platformSrc && platformSrc.includes('private async navigateResilient(') && platformSrc.includes("页面被未提交表单拦住，重建窗口后重试"))
check('comments 走 navigateResilient', !!platformSrc && /async comments\([\s\S]{0,2200}navigateResilient\(id, win, driver\.commentsUrl\)/.test(platformSrc))
check('stats 走 navigateResilient', !!platformSrc && /async stats\([\s\S]{0,2200}navigateResilient\(id, win, driver\.dataUrl\)/.test(platformSrc))
check('replyComment 走 navigateResilient', !!platformSrc && platformSrc.includes('navigateResilient(id, w, driver.commentsUrl)'))

// 4. 执行器与能力目录
for (const name of ['platform_publish', 'platform_status', 'platform_stats']) {
  check('worker 白名单含 ' + name, !!worker && worker.includes("'" + name + "'"))
}
check('服务端注册 platformDescriptors', !!serverCap && serverCap.includes('platformDescriptors'))
check('服务端注册 buildPlatformHandlers', !!serverCap && serverCap.includes('buildPlatformHandlers()'))

if (failed) {
  console.error('P24 desktop check FAILED (' + checks + ' checks, ' + failed + ' failed)')
  process.exit(1)
}
console.log('P24 desktop check OK (' + checks + ' checks)')
