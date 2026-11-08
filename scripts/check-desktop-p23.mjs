#!/usr/bin/env node
/**
 * P23 桌面端静态检查：记忆管理页 + preload/main IPC + Shell 导航。
 * 用法：node scripts/check-desktop-p23.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..')
const desktop = path.join(root, 'packages', 'desktop', 'src')
const memoryPage = path.join(desktop, 'renderer', 'src', 'pages', 'Memory.tsx')
const shellPage = path.join(desktop, 'renderer', 'src', 'pages', 'Shell.tsx')
const preloadFile = path.join(desktop, 'preload', 'index.ts')
const mainFile = path.join(desktop, 'main', 'index.ts')
const stylesFile = path.join(desktop, 'renderer', 'src', 'styles.css')

let checks = 0
let failed = 0

function read(file) {
  if (!existsSync(file)) return null
  return readFileSync(file, 'utf8')
}

function check(name, condition, detail) {
  checks += 1
  if (condition) {
    console.log('[PASS] ' + name + (detail ? ' :: ' + detail : ''))
  } else {
    failed += 1
    console.log('[FAIL] ' + name + (detail ? ' :: ' + detail : ''))
  }
}

const memory = read(memoryPage)
const shell = read(shellPage)
const preload = read(preloadFile)
const main = read(mainFile)
const styles = read(stylesFile)

// 1. 页面文件与 5 个 memory 调用
check('Memory.tsx 存在', !!memory, memory ? memoryPage : 'missing ' + memoryPage)
for (const method of ['stats', 'list', 'remove', 'merge', 'dedupe']) {
  check('Memory.tsx 调用 memory.' + method, !!memory && memory.includes('memory.' + method + '('))
}
check('Memory.tsx 用 confirm 二次确认删除', !!memory && memory.includes('window.confirm'))
check('Memory.tsx 空态文案', !!memory && memory.includes('还没有记忆，员工在任务里说的客户偏好会自动记下来'))
check('Memory.tsx 展示查重建议预览', !!memory && memory.includes('mergedPreview'))
check('Memory.tsx 401 重新登录提示', !!memory && memory.includes('请重新登录'))

// 2. preload 的 memory 域 5 个方法与通道
check('preload 有 memory 域', !!preload && /memory:\s*\{/.test(preload))
const preloadChannels = ['list', 'stats', 'remove', 'merge', 'dedupe']
for (const name of preloadChannels) {
  const methodRe = new RegExp('\\b' + name + '\\s*:\\s*\\([^)]*\\)\\s*=>\\s*ipcRenderer\\.invoke\\(\\s*[\'"]memory:' + name + '[\'"]')
  check('preload memory.' + name + ' 转发 memory:' + name, !!preload && methodRe.test(preload))
}

// 3. main 进程 5 个 handler
for (const channel of ['memory:list', 'memory:stats', 'memory:remove', 'memory:merge', 'memory:dedupe']) {
  check("main 有 handler '" + channel + "'", !!main && main.includes("ipcMain.handle('" + channel + "'"))
}

// 4. Shell 导航与渲染
check("Shell Tab 类型含 'memory'", !!shell && shell.includes("'memory'"))
check("Shell 含 🧠 记忆 导航", !!shell && shell.includes('🧠 记忆'))
check("Shell 点击切到 memory", !!shell && shell.includes("setTab('memory')"))
check('Shell 渲染 Memory 页面', !!shell && /\{tab === 'memory' && <Memory \/>\}/.test(shell))
check('Shell 引入 Memory 组件', !!shell && /import Memory from '\.\/Memory'/.test(shell))

// 5. 样式
check('styles.css 含记忆页样式', !!styles && styles.includes('.memory-card') && styles.includes('.memory-stats'))

if (failed) {
  console.error('P23 desktop check FAILED (' + checks + ' checks, ' + failed + ' failed)')
  process.exit(1)
}
console.log('P23 desktop check OK (' + checks + ' checks)')
