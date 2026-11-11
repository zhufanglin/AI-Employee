import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const read = (p) => readFileSync(join(repo, p), 'utf8')
const has = (file, pattern, label) => {
  const text = read(file)
  const ok = pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern)
  check(label, ok, ok ? '' : (pattern instanceof RegExp ? pattern.source : pattern) + ' 未命中 ' + file)
}
let passed = 0
const failures = []
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log('[PASS] ' + label) }
  else { failures.push(label + (detail ? ' :: ' + detail : '')); console.log('[FAIL] ' + label + (detail ? ' :: ' + detail : '')) }
}

console.log('== P43 P1 静态断言 ==')
// —— 1) 短信配置接 DB ——
has('packages/server/src/auth/sms.sender.ts', /smsConfig\.findFirst|smsConfig\.findUnique/, '短信发送器从数据库读 SmsConfig')
has('packages/server/src/auth/sms.sender.ts', 'invalidateSmsConfigCache', '短信配置缓存可失效')
has('packages/server/src/auth/sms.sender.ts', /DEV_SMS_ALLOWLIST/, '短信白名单逻辑保留')
has('packages/server/src/auth/auth.module.ts', /exports:\s*\[[^\]]*SmsSender/s, 'AuthModule 导出 SmsSender')
has('packages/server/src/admin/admin-extra.service.ts', 'invalidateSmsConfigCache', '后台保存短信配置后失效缓存')
has('packages/server/src/admin/admin-extra.service.ts', /testSms/, '后台测试短信走真实下发')
// 回归：SmsSender 注入 PrismaService 必须走运行时 import；import type 会让 Nest 在启动时报 UnknownDependenciesException(Function)
check('SmsSender 的 PrismaService 不是 import type',
  !/import type \{[^}]*PrismaService/.test(read('packages/server/src/auth/sms.sender.ts')),
  'import type 会抹掉 emitDecoratorMetadata 的类引用')

// —— 1b) 微信支付配置接 DB + 员工订单前台支付 ——
has('packages/server/src/payments/wechat-pay.service.ts', /wechatPayConfig\.findFirst/, '微信支付从数据库读 WechatPayConfig')
has('packages/server/src/payments/wechat-pay.service.ts', 'invalidateWechatPayConfigCache', '微信支付配置缓存可失效')
has('packages/server/src/admin/admin-extra.service.ts', 'invalidateWechatPayConfigCache', '后台保存支付配置后失效缓存')
has('packages/server/src/employee/employee-order.service.ts', /EMPLOYEE_ORDER_NO_PREFIX/, '员工订单号有独立前缀')
has('packages/server/src/employee/employee-order.service.ts', 'markPaidByOrderNo', '员工订单支持按订单号开通')
has('packages/server/src/payments/payments.service.ts', 'createEmployeePay', '员工订单前台支付服务')

// —— 5) 审批超时 / 驳回重跑 ——
has('packages/server/src/employee/employee.service.ts', /RETRY_LIMIT = 2/, '驳回重跑上限 2 次')
has('packages/server/src/employee/employee.service.ts', /body\?\.rerun !== true/, 'reject 支持 rerun 参数')
has('packages/server/src/employee/employee.service.ts', /status: "queued",\s*\n\s*startedAt: null/, '驳回重跑把任务放回队列')
has('packages/server/src/employee/employee.service.ts', 'autoApproveOverdue', '审批超时自动通过方法存在')
has('packages/server/src/employee/employee-expiry.service.ts', 'EMPLOYEE_APPROVAL_TIMEOUT_HOURS', '审批超时用环境变量开关')
has('packages/server/src/employee/employee-expiry.service.ts', /approvalTimeoutHours: this\.approvalTimeoutHours/, '扫描状态暴露审批超时配置')

// —— 4) 工作区规则注入（AGENTS.md / TOOLS.md）——
has('packages/worker/tool-loop.mjs', 'WORKSPACE_RULES_BUDGET = 4000', 'worker 工作区规则预算 4000')
has('packages/worker/tool-loop.mjs', 'workspaceRulesSection', 'worker 导出 workspaceRulesSection')
has('packages/worker/tool-loop.mjs', /工作区规则已截断/, '工作区规则截断标记')
has('packages/worker/tool-loop.mjs', /workspaceRules/, 'runToolLoop 接受 workspaceRules')
has('packages/server/src/employee/workspace-rules.ts', /AGENTS\.md/, '服务端读 AGENTS.md')
has('packages/server/src/employee/workspace-rules.ts', /TOOLS\.md/, '服务端读 TOOLS.md')
has('packages/server/src/employee/employee.service.ts', /workspaceRules,/, '桌面 pull 下发工作区规则')
has('packages/server/src/employee/employee-execution.service.ts', /workspaceRules,/, '云端 claim 下发工作区规则')
has('packages/desktop/src/main/executor.ts', 'readWorkspaceRules', '桌面执行器读工作区规则')
has('packages/worker/cloud-executor.mjs', /workspaceRules/, '云端执行器透传工作区规则')

// 注入顺序：能力参数说明 -> 工作区规则 -> needs -> skill -> strategy -> persona
{
  const full = read('packages/worker/tool-loop.mjs')
  const body = full.slice(full.indexOf('export async function runToolLoop'))
  const text = body
  const iCap = text.indexOf('能力参数说明：')
  const iRules = text.indexOf('workspaceRulesSection(workspaceRules)')
  const iNeeds = text.indexOf('needsSection(needs)')
  const iSkill = text.indexOf('skillSection(skill)')
  const iStrategy = text.indexOf('strategySection(strategy')
  const iPersona = text.indexOf('personaSection(persona)')
  check('注入顺序 能力说明<工作区规则<needs<skill<strategy<persona',
    iCap > 0 && iRules > iCap && iNeeds > iRules && iSkill > iNeeds && iStrategy > iSkill && iPersona > iStrategy,
    JSON.stringify({ iCap, iRules, iNeeds, iSkill, iStrategy, iPersona }))
}

// —— soulContent 死字段 ——
has('packages/server/src/employee/employee.service.ts', 'soulContent: withSkill ? soul : null', '详情返回 soulContent（回落 skillMd）')

// —— toolapi 真生成 ——
has('packages/server/src/toolapi/toolapi.service.ts', 'parseStrategies', '今日沟通建议解析模型输出')
has('packages/server/src/toolapi/toolapi.service.ts', /this\.aiText\(owner, prompt\)/, '今日沟通建议调用真模型')
has('packages/server/src/toolapi/toolapi.service.ts', /没有可用的潜在客户数据/, '无客户数据时明确报错')
has('packages/server/src/toolapi/toolapi.controller.ts', /generateTodayCommunications\(this\.phone\(r\), \{ limit: b\?\.limit \}\)/, '控制器支持 limit 入参')

// —— 7) 桌面 IPC 补齐 ——
for (const [file, channel] of [['packages/desktop/src/main/index.ts', 'dialog:save'], ['packages/desktop/src/main/index.ts', 'settings:reset'], ['packages/desktop/src/main/index.ts', 'chat:send-with-media'], ['packages/desktop/src/main/index.ts', 'session:delete']]) {
  has(file, channel, 'IPC ' + channel + ' 已注册')
}
has('packages/desktop/src/preload/index.ts', 'sendWithMedia', 'preload 暴露 sendWithMedia')
has('packages/desktop/src/preload/index.ts', /reset: \(\) => ipcRenderer\.invoke\('settings:reset'\)/, 'preload 暴露 settings.reset')
has('packages/desktop/src/preload/index.ts', 'saveTextFile', 'preload 暴露 dialog:save')
has('packages/desktop/src/renderer/src/types.ts', 'sendWithMedia', '渲染层类型含 sendWithMedia')

// —— 6) asar 热更新 ——
has('packages/desktop/src/main/asar-update.ts', 'asar-update:check', 'asar 热更新 IPC check')
has('packages/desktop/src/main/asar-update.ts', /sha512/i, 'asar 包 sha512 校验')
has('packages/desktop/src/main/asar-update.ts', /app\.asar\.bak-/, '装前备份 app.asar')
has('packages/desktop/src/main/asar-update.ts', 'relaunch', '装完自动重启')
has('packages/desktop/src/main/index.ts', 'registerAsarUpdate', 'asar 模块已注册')
has('scripts/publish-asar.mjs', /--upload/, '发布脚本支持 --upload')
has('packages/desktop/src/renderer/src/pages/Settings.tsx', /asarUpdate|热更新|增量更新/, '设置页有热更新入口')

// —— 7) 客户端日志 ——
has('packages/desktop/src/main/log-ops.ts', 'log:getRecent', '日志 IPC getRecent')
has('packages/desktop/src/main/log-ops.ts', /basename/, '日志文件名防穿越')
has('packages/desktop/src/main/index.ts', 'registerLogOps', '日志模块已注册')
has('packages/desktop/src/preload/index.ts', 'logs:', 'preload 暴露 logs')
has('packages/desktop/src/renderer/src/types.ts', 'asarUpdate:', '渲染层类型含 asarUpdate')

console.log('\nP43 P1 RESULT: ' + (failures.length ? 'FAILED (' + passed + ' passed, ' + failures.length + ' failed)' : 'ALL PASS (' + passed + ' checks)'))
if (failures.length) { console.log(failures.map((f) => ' - ' + f).join('\n')); process.exit(1) }
