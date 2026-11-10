#!/usr/bin/env node
/**
 * P33 一键分发（同一份内容按顺序发到多个平台）静态检查。
 * 用法：node scripts/check-desktop-p33.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..')
const desktop = path.join(root, 'packages', 'desktop', 'src')
const pagePath = path.join(desktop, 'renderer', 'src', 'pages', 'PlatformPublish.tsx')
const stylesPath = path.join(desktop, 'renderer', 'src', 'styles.css')
const page = existsSync(pagePath) ? readFileSync(pagePath, 'utf8') : ''
const styles = existsSync(stylesPath) ? readFileSync(stylesPath, 'utf8') : ''

let checks = 0
let failed = 0
function check(name, ok, detail) {
  checks += 1
  if (ok) console.log('[PASS] ' + name)
  else {
    failed += 1
    console.log('[FAIL] ' + name + (detail ? ' :: ' + detail : ''))
  }
}

check('发布页去掉单选平台 state', !page.includes('setPlatform') && !page.includes("useState('douyin')"))
check('声明多平台目标 targets', /const \[targets, setTargets\] = useState<string\[\]>/.test(page))
check('默认只选抖音一个平台', page.includes("useState<string[]>(['douyin'])"))
check('有 toggleTarget 切换逻辑', /function toggleTarget\(id: string\)/.test(page) && page.includes('prev.includes(id)'))
check('有「全选」按钮', page.includes('全选') && page.includes('setTargets(PLATFORMS.map((p) => p.id))'))
check('发布前校验至少选一个平台', page.includes("请至少选择一个要发布的平台"))
check('同一份 payload 复用给每个平台', page.includes('const payload = {') && page.includes('...payload, platform: id'))
// P40 起：多平台发布前会先过滤掉「不支持图文」的平台，循环变量改名 usable（仍是串行 for 循环 + 累计结果）
check('逐平台串行发布并累计结果', /for \(const id of (targets|usable)\)/.test(page) && page.includes('setMultiResults([...acc])'))
check('单个平台失败不中断后续平台', page.includes('acc.push({') && page.includes('screenshots: [],'))
check('发布进度文案含序号', /'（' \+ \(acc\.length \+ 1\) \+ '\/' \+ (targets|usable)\.length \+ '）正在发布到 '/.test(page))
check('成功一个平台就落结果（崩溃也看得到）', page.includes('setMultiResults([...acc])'))
check('单平台保持原「发布结果」区块', page.includes('if (acc.length === 1) setResult(acc[0])'))
check('多平台给出失败汇总', page.includes("' 个平台没发成功：'"))
check('分发结果表格', page.includes('platform-result-table') && page.includes('multiResults.filter((r) => r.ok).length'))
check('表格展示每平台链接', page.includes('{r.url &&'))
check('未登录平台在多选里标出来', page.includes('（未登录）'))
check('说明文案告知串行与截断', page.includes('按顺序一个个发') && page.includes('自动截断'))
check('按钮文案区分单发/分发', page.includes("'一键分发到 ' + targets.length + ' 个平台'"))
check('样式含 platform-target', styles.includes('.platform-target') && styles.includes('.platform-target.on'))
check('样式含分发结果表', styles.includes('.platform-result-table'))

if (failed) {
  console.error('P33 desktop check FAILED (' + checks + ' checks, ' + failed + ' failed)')
  process.exit(1)
}
console.log('P33 desktop check OK (' + checks + ' checks)')
