#!/usr/bin/env node
/**
 * P46 静态检查：
 * 1) 企业资料完整度卡片（6 项判定 / 进度 / 引导文案 / 打开与复制路径）；
 * 2) 服务端任务列表 queuePosition 只读字段 + 渲染层「排队中，前面还有 N 个任务」。
 * 用法：node scripts/check-desktop-p46.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..')
const desktop = path.join(root, 'packages', 'desktop', 'src')
const server = path.join(root, 'packages', 'server', 'src')

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const page = read(path.join(desktop, 'renderer', 'src', 'pages', 'EmployeeOffice.tsx'))
const styles = read(path.join(desktop, 'renderer', 'src', 'styles.css'))
const taskService = read(path.join(server, 'employee', 'employee.service.ts'))

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

// ---- 1. 资料卡组件 ----
check('员工办公区引入了资料文件名常量', /const PROFILE_FILE = '企业基础资料\.md'/.test(page))
check('资料卡组件存在（企业资料完整度 + profile-card）', page.includes('企业资料完整度') && page.includes('className="office-block profile-card'))
check('资料卡有折叠开关', page.includes('profileOpen') && page.includes('setProfileOpen'))

// ---- 2. 6 项判定关键词 ----
const labels = ['公司/品牌名', '主营业务', '目标客户', '核心优势', '话术口径', '输出偏好']
for (const label of labels) check('6 项含「' + label + '」', page.includes("label: '" + label + "'"))
check('6 项配置为 PROFILE_SPECS 且 total 取自常量', page.includes('const PROFILE_SPECS: ProfileSpec[]') && page.includes('PROFILE_SPECS.length'))
check('判定规则认「（请填写）」占位', page.includes('（请填写）') && page.includes('PROFILE_PLACEHOLDER'))
check('判定规则有 200 字符空小节阈值', page.includes('EMPTY_SECTION_CHARS = 200'))
check('按 Markdown 小节标题切分正文', page.includes('function profileSectionBody') && page.includes('PROFILE_HEADING'))
check('按冒号取值判断是否真的填了', page.includes('function profileLineValue') && page.includes("indexOf('：')"))

// ---- 3. 进度与引导 ----
check('展示「已填 N/6」进度', page.includes('已填 {profileJudge.done}/') && page.includes('未读到资料内容'))
check('有进度条元素', page.includes('profile-progress-bar'))
check('列出缺失项中文清单', page.includes('还缺这些：') && page.includes('profileJudge.missing'))
check('6/6 时只显示一行绿字', page.includes('资料已完整，员工产出会贴合你的业务') && page.includes('profile-card-done'))
check('有「一键打开资料文件编辑」', page.includes('一键打开资料文件编辑') && page.includes('openProfileFile'))
check('打开编辑走 files.open', page.includes('files.open({ path: profilePath })'))
check('读不到内容时给下载指引', page.includes('下载《企业基础资料.md》') && page.includes('downloadProfileFile'))
check('可复制资料路径', page.includes('复制路径') && page.includes('navigator.clipboard.writeText'))
check('可上传填好的同名文件', page.includes('上传填好的同名文件'))
check('读内容走 files:list + files:read（本地工作区）', page.includes("files.list({})") && page.includes('files.read({ path: hit.path'))

// ---- 4. queuePosition 服务端 ----
check('服务端列表返回 queuePosition 字段', taskService.includes('queuePosition') && taskService.includes('const queuePositions = new Map<string, number>()'))
check('queued 任务按 createdAt 升序排序', /where: \{ userId, status: "queued" \}[\s\S]{0,120}orderBy: \{ createdAt: "asc" \}/.test(taskService))
check('非 queued 任务 queuePosition 为 null', /status === "queued" \? queuePositions.get\(item.id\) \?\? null : null/.test(taskService))

// ---- 5. queuePosition 渲染层 ----
check('任务卡片读取 task.queuePosition', page.includes('task.queuePosition'))
check('queued 任务显示「排队中，前面还有 N 个任务」', page.includes('排队中，前面还有 ') && page.includes('task.queuePosition - 1'))

// ---- 6. 样式 ----
for (const cls of ['.profile-card', '.profile-progress-text', '.profile-progress-bar', '.profile-field', '.profile-done', '.queue-hint']) {
  check('样式含 ' + cls, styles.includes(cls + ' '))
}

if (failed) {
  console.error('P46 desktop check FAILED (' + checks + ' checks, ' + failed + ' failed)')
  process.exitCode = 1
} else {
  console.log('P46 desktop check OK (' + checks + ' checks)')
}
