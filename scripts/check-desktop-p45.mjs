#!/usr/bin/env node
/**
 * P45 合规基线静态检查：条款服务端渲染 + 客户端同意闸门 + 设置页入口 + 首启顺序。
 * 用法：node scripts/check-desktop-p45.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..')
const server = path.join(root, 'packages', 'server', 'src')
const desktop = path.join(root, 'packages', 'desktop', 'src')

function read(p) {
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}
const pages = read(path.join(server, 'legal', 'legal.pages.ts'))
const controller = read(path.join(server, 'legal', 'legal.controller.ts'))
const serverModule = read(path.join(server, 'legal', 'legal.module.ts'))
const appModule = read(path.join(server, 'app.module.ts'))
const main = read(path.join(desktop, 'main', 'index.ts'))
const preload = read(path.join(desktop, 'preload', 'index.ts'))
const types = read(path.join(desktop, 'renderer', 'src', 'types.ts'))
const appTsx = read(path.join(desktop, 'renderer', 'src', 'App.tsx'))
const gate = read(path.join(desktop, 'renderer', 'src', 'pages', 'LegalGate.tsx'))
const settings = read(path.join(desktop, 'renderer', 'src', 'pages', 'Settings.tsx'))
const login = read(path.join(desktop, 'renderer', 'src', 'pages', 'Login.tsx'))

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

// ---- 服务端 ----
check('服务端有 LEGAL_VERSION', /export const LEGAL_VERSION\s*=\s*["']\d{4}-\d{2}-\d{2}["']/.test(pages))
check('服务端有运营主体信息', pages.includes('OPERATOR') && pages.includes('fcmediaagent.com'))
check('三份正文齐全（terms/privacy/aigc）', /LEGAL_DOCS:.+=\s*\{/.test(pages) && /keys?\.(terms|privacy|aigc)/.test(pages) || (pages.includes('terms:') && pages.includes('privacy:') && pages.includes('aigc:')))
check('协议含退款条款', pages.includes('退款'))
check('隐私政策写明跨境存储', pages.includes('跨境') && pages.includes('美国'))
check('隐私政策列出第三方处理方', pages.includes('火山方舟') && pages.includes('RunningHub') && pages.includes('Tavily'))
check('AIGC 说明含显式与隐式标识', pages.includes('显式标识') && pages.includes('隐式标识'))
check('导出 LEGAL_DOCS 与 legalIndex', pages.includes('LEGAL_DOCS') && pages.includes('legalIndex'))
check('控制器为 @Public 公开访问', controller.includes('@Public()') && controller.includes('@Controller'))
check('条款页服务端渲染 HTML', controller.includes('text/html') && controller.includes('render'))
check('未知条款返回 404', controller.includes('NotFound') || controller.includes('404'))
check('legal.module 已注册', serverModule.includes('@Module'))
check('app.module 已 import LegalModule', appModule.includes('LegalModule'))

// ---- 客户端主进程 ----
check('main 有 legal:meta IPC', main.includes("'legal:meta'"))
check('main 有 legal:accept IPC', main.includes("'legal:accept'"))
check('main 有 legal:open IPC', main.includes("'legal:open'"))
check('同意版本落盘 settings.legalAcceptedVersion', main.includes('legalAcceptedVersion'))
check('有离线兜底版本号', main.includes('LEGAL_FALLBACK_VERSION'))
check('settings:get 返回 legalAcceptedVersion', /legalAcceptedVersion:\s*settings\.legalAcceptedVersion/.test(main))
check('外部链接拼出 /api/legal/<key>', main.includes("'/legal/'") && /origin \+ '\/api' \+ path/.test(main))

// ---- preload / types ----
check('preload 暴露 legal 三方法', /legal:\s*\{/.test(preload) && preload.includes('legal:meta') && preload.includes('legal:accept') && preload.includes('legal:open'))
check('types 有 LegalDocKey 联合类型', types.includes("'terms' | 'privacy' | 'aigc'"))
check('types 的 settings 含 legalAcceptedVersion', types.includes('legalAcceptedVersion'))

// ---- 渲染层 ----
check('存在 LegalGate 页面', gate.length > 500 && gate.includes('export default function LegalGate'))
check('同意闸门需显式勾选', gate.includes('checked') && gate.includes('useState(false)'))
check('闸门提供三份文本入口', gate.includes('legal.open') && gate.includes('docs'))
check('闸门有不同意即退出', gate.includes('window.close'))
check('App.tsx 引入 LegalGate', appTsx.includes("import LegalGate from './pages/LegalGate'"))
check('App.tsx 版本不一致才拦截', /meta\.version !== s\.legalAcceptedVersion/.test(appTsx))
check('App.tsx 先渲染 LegalGate 再进主界面', appTsx.indexOf('if (legal) return <LegalGate') > -1 && appTsx.indexOf('if (legal) return <LegalGate') < appTsx.indexOf('<Shell'))
check('设置页有「关于与合规」卡片', settings.includes('关于与合规') && settings.includes('legal.meta'))
check('设置页可重新同意当前版本', settings.includes('legal.accept'))

// ---- P45-2 个人信息跨境「单独同意」 ----
check('main 存跨境单独同意开关', main.includes('legalCrossBorderAccepted'))
check('闸门有独立跨境勾选', gate.includes('crossBorder') && gate.includes('我单独同意'))
check('闸门未勾跨境不可继续', /disabled=\{[^}]*!crossBorder/.test(gate))
check('login 上报 consent 载荷', /consent:\s*consentPayload\(\)/.test(main) && main.includes('function consentPayload'))
check('settings:get 返回跨境同意', main.includes('legalCrossBorderAccepted:'))
check('types 的 settings 含跨境同意', types.includes('legalCrossBorderAccepted'))

// ---- P45-6 登录页协议行 ----
check('登录页有协议行', login.includes('登录即表示') && login.includes("legal.open('terms')") && login.includes("legal.open('privacy')"))

// ---- 服务端同意落库 ----
const authService = read(path.join(server, 'auth', 'auth.service.ts'))
const authDto = read(path.join(server, 'auth', 'auth.dto.ts'))
const authCtrl = read(path.join(server, 'auth', 'auth.controller.ts'))
const schema = read(path.join(root, 'packages', 'server', 'prisma', 'schema.prisma'))
check('schema 有 ConsentRecord 表', /model ConsentRecord/.test(schema) && schema.includes('@@map("ConsentRecord")'))
check('同一用户同文档同版本唯一', /@@unique\(\[userId, docKey, version\]\)/.test(schema))
check('main 的 legal:accept 会即时上报', main.includes("'/auth/consent'") && /await api\('\/auth\/consent'/.test(main))
check('main 返回 recorded 标记', /legalCrossBorderAccepted:\s*!!settings\.legalCrossBorderAccepted,\s*recorded/.test(main))
check('types 的 accept 返回 recorded', types.includes('recorded?: boolean'))
check('服务端有 POST /auth/consent', /@Post\("consent"\)/.test(authCtrl) && authCtrl.includes('async recordConsent'))
check('新账号强制同意', authService.includes('assertConsentForNewAccount') && authService.includes('AUTH_REQUIRE_CONSENT'))
check('跨境单独同意独立记录', authService.includes('"cross-border"'))
check('重复同意幂等（忽略 P2002）', authService.includes('P2002'))
check('DTO 有 ConsentDto', authDto.includes('class ConsentDto') && authDto.includes('crossBorder'))
check('控制器带 ip/userAgent', authCtrl.includes('withClientMeta'))

if (failed) {
  console.error('P45 desktop check FAILED (' + checks + ' checks, ' + failed + ' failed)')
  process.exit(1)
}
console.log('P45 desktop check OK (' + checks + ' checks)')
