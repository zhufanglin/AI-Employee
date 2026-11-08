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
