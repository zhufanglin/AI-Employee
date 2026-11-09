#!/usr/bin/env node
/**
 * P30 桌面端接线静态检查：数据快照 → 服务端 platform_metrics_parse → 页面结构化展示。
 * 用法：node scripts/check-desktop-p30.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..')
const desktop = path.join(root, 'packages', 'desktop', 'src')
const page = path.join(desktop, 'renderer', 'src', 'pages', 'PlatformPublish.tsx')
const preloadFile = path.join(desktop, 'preload', 'index.ts')
const mainFile = path.join(desktop, 'main', 'index.ts')
const typesFile = path.join(desktop, 'renderer', 'src', 'types.ts')
const stylesFile = path.join(desktop, 'renderer', 'src', 'styles.css')
const serverMetrics = path.join(root, 'packages', 'server', 'src', 'capabilities', 'platform-metrics.ts')

let checks = 0
let failed = 0
function read(file) { return existsSync(file) ? readFileSync(file, 'utf8') : '' }
function check(name, ok, detail) {
  checks += 1
  if (ok) console.log('[PASS] ' + name + (detail ? ' :: ' + detail : ''))
  else { failed += 1; console.log('[FAIL] ' + name + (detail ? ' :: ' + detail : '')) }
}

const pageSrc = read(page)
const preload = read(preloadFile)
const main = read(mainFile)
const types = read(typesFile)
const styles = read(stylesFile)
const server = read(serverMetrics)

check('服务端解析器存在', !!server, serverMetrics)
check('解析器导出 parsePlatformMetrics', server.includes('export function parsePlatformMetrics'))
check('解析器导出 parseCnNumber', server.includes('export function parseCnNumber'))
check('主进程注册 platform:parse-metrics', main.includes("ipcMain.handle('platform:parse-metrics'"))
check('主进程走 /capabilities/run 调能力', main.includes("'/capabilities/run'") && main.includes('platform_metrics_parse'))
check('主进程按 body.success 判成败（能力失败也是 201）', main.includes('body.success === false'))
check('preload 透出 parseMetrics', preload.includes("invoke('platform:parse-metrics'"))
check('types 定义 PlatformMetrics', types.includes('export type PlatformMetrics =') && types.includes('PlatformMetricsParseResult'))
check('types 的 parseMetrics 签名存在', types.includes('parseMetrics: (p: { platform: string; text: string })'))
check('数据快照后自动解析', pageSrc.includes('void parseMetrics(id, snap.text)'))
check('解析失败不影响原始快照', pageSrc.includes('setMetricsError') && pageSrc.includes('下面仍可看原始文本'))
check('页面渲染指标卡片', pageSrc.includes('platform-metrics-grid') && pageSrc.includes('platform-metric-value'))
check('页面渲染作品表格', pageSrc.includes('platform-works') && pageSrc.includes('playCount'))
check('value 为 null 显示占位符（不拿 0 冒充）', pageSrc.includes("m.value === null ? '—'"))
check('notes 展示解析限制', pageSrc.includes('metrics.notes'))
check('原始文本折叠保留', pageSrc.includes('platform-stats-raw'))
check('样式包含结构化区域', styles.includes('.platform-metrics-grid') && styles.includes('.platform-works'))

if (failed) {
  console.error('P30 desktop check FAILED (' + checks + ' checks, ' + failed + ' failed)')
  process.exit(1)
}
console.log('P30 desktop check OK (' + checks + ' checks)')
