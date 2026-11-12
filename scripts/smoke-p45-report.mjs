/**
 * P45-4 冒烟：举报与投诉工单
 *
 * 直接调编译后的 ReportService（不依赖 HTTP/短信），覆盖：
 *  1) 类别清单（7 类，含 ai-content 与中文标签）
 *  2) 正常提交 → 落库，字段裁剪正确，匿名也能提交
 *  3) 带 userId 的提交会关联账号
 *  4) 非法类别 / 说明过短 / 说明过长 → 中文 400 提示
 *  5) 联系方式与 URL 超长自动截断（不报错，避免用户白填）
 *  6) 同一 IP 每小时限流 10 次，第 11 次 → 429
 *  7) 管理端列表（total/openCount/items + categoryLabel）
 *  8) 管理端处理（resolved/rejected + handledNote），不存在的工单 → 400
 *
 * 用法：node scripts/smoke-p45-report.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '')

try {
  const raw = readFileSync(ROOT + '/packages/server/.env', 'utf8').replace(/^\uFEFF/, '')
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {}

const { PrismaClient } = require(ROOT + '/node_modules/.prisma/client')
const { ReportService, CATEGORIES } = require(ROOT + '/packages/server/dist/legal/report.service.js')

const prisma = new PrismaClient()
const svc = new ReportService(prisma)

let pass = 0, fail = 0
const chk = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')) }
}
const TAG = 'smoke-p45-report-' + Date.now()

async function expectThrow(fn, needle) {
  try { await fn(); return { threw: false } } catch (e) {
    const msg = String((e && e.message) || e)
    return { threw: true, msg, matched: msg.includes(needle), status: e && e.getStatus ? e.getStatus() : null }
  }
}

async function main() {
  console.log('== P45-4 举报工单冒烟 ==')
  const createdIds = []

  // 1) 类别清单
  const cats = svc.categories()
  chk('类别清单 7 项', cats.length === 7, cats.length)
  chk('含 ai-content 且带中文标签', cats.some((c) => c.key === 'ai-content' && c.label.includes('AI')), cats[0])
  chk('CATEGORIES 与 categories() 一致', CATEGORIES.length === cats.length)

  // 2) 正常提交（匿名）
  const ip1 = TAG + '-ip1'
  const r1 = await svc.submit(
    { category: 'ai-content', content: '任务生成的图片包含虚假信息，请核实处理。', contact: 'user@example.com', targetUrl: 'https://example.com/a.png' },
    { ip: ip1, userAgent: 'smoke-agent/1.0' }
  )
  createdIds.push(r1.id)
  chk('提交返回 id', typeof r1.id === 'string' && r1.id.length > 5, r1.id)
  chk('返回中文类别标签', String(r1.categoryLabel).includes('AI'), r1.categoryLabel)
  chk('返回中文受理说明', String(r1.message).includes('3 个工作日'), r1.message)
  const row1 = await prisma.reportTicket.findUnique({ where: { id: r1.id } })
  chk('落库 category=ai-content', row1 && row1.category === 'ai-content', row1 && row1.category)
  chk('匿名提交 userId 为空', row1 && row1.userId === null, row1 && row1.userId)
  chk('记录 ip/ua/source', row1 && row1.ip === ip1 && row1.userAgent === 'smoke-agent/1.0' && row1.source === 'api', row1 && { ip: row1.ip, ua: row1.userAgent, source: row1.source })
  chk('初始状态 open', row1 && row1.status === 'open', row1 && row1.status)
  chk('contact/targetUrl 已保存', row1 && row1.contact === 'user@example.com' && row1.targetUrl === 'https://example.com/a.png')

  // 3) 带 userId
  const userId = 'smoke-user-' + Date.now()
  const r2 = await svc.submit({ category: 'bug', content: '发布按钮点了没有反应，重复三次都一样。', source: 'desktop' }, { ip: TAG + '-ip2', userId })
  createdIds.push(r2.id)
  const row2 = await prisma.reportTicket.findUnique({ where: { id: r2.id } })
  chk('带 userId 会关联账号', row2 && row2.userId === userId && row2.source === 'desktop', row2 && { u: row2.userId, s: row2.source })

  // 4) 校验
  const e1 = await expectThrow(() => svc.submit({ category: 'nope', content: '违规内容测试文本' }, { ip: TAG + '-ip3' }), '请选择举报类别')
  chk('非法类别 → 400 中文', e1.threw && e1.matched && e1.status === 400, e1)
  const e2 = await expectThrow(() => svc.submit({ category: 'other', content: '短' }, { ip: TAG + '-ip4' }), '至少')
  chk('说明过短 → 400 中文', e2.threw && e2.matched && e2.status === 400, e2)
  const e3 = await expectThrow(() => svc.submit({ category: 'other', content: 'x'.repeat(2001) }, { ip: TAG + '-ip5' }), '不能超过')
  chk('说明过长 → 400 中文', e3.threw && e3.matched && e3.status === 400, e3)
  const before = await prisma.reportTicket.count({ where: { content: '短' } })
  chk('校验失败不落库', before === 0, before)

  // 5) 超长裁剪
  const r3 = await svc.submit(
    { category: 'copyright', content: '这段文字是我原创的文章，对方未经许可搬运到平台上。', contact: 'c'.repeat(200), targetUrl: 'https://example.com/' + 'a'.repeat(600) },
    { ip: TAG + '-ip6' }
  )
  createdIds.push(r3.id)
  const row3 = await prisma.reportTicket.findUnique({ where: { id: r3.id } })
  chk('contact 截断到 120', row3 && row3.contact.length === 120, row3 && row3.contact.length)
  chk('targetUrl 截断到 500', row3 && row3.targetUrl.length === 500, row3 && row3.targetUrl.length)

  // 6) 限流：同 IP 共 11 次
  const limitedIp = TAG + '-limited'
  let okCount = 0
  let limited = null
  for (let i = 0; i < 11; i++) {
    try {
      const rr = await svc.submit({ category: 'other', content: '限流测试第 ' + (i + 1) + ' 次提交内容' }, { ip: limitedIp })
      createdIds.push(rr.id)
      okCount++
    } catch (e) {
      limited = e
      break
    }
  }
  chk('前 10 次放行', okCount === 10, okCount)
  chk('第 11 次 → 429 中文', !!limited && limited.getStatus && limited.getStatus() === 429 && String(limited.message).includes('频繁'), limited && { s: limited.getStatus && limited.getStatus(), m: limited.message })

  // 7) 管理端列表
  const list = await svc.list({ status: 'open', limit: 200 })
  chk('列表返回 total/openCount/items', typeof list.total === 'number' && typeof list.openCount === 'number' && Array.isArray(list.items), { t: list.total, o: list.openCount })
  chk('列表命中刚提交的工单', list.items.some((it) => it.id === r1.id), list.items.length)
  chk('列表项含中文类别标签', list.items.every((it) => typeof it.categoryLabel === 'string' && it.categoryLabel.length > 0))
  const byCategory = await svc.list({ category: 'ai-content', limit: 200 })
  chk('按类别过滤生效', byCategory.items.every((it) => it.category === 'ai-content') && byCategory.items.length >= 1, byCategory.items.length)

  // 8) 管理端处理
  const res1 = await svc.resolve(r1.id, { status: 'resolved', handledBy: 'admin', handledNote: '已核实内容违规，已下线处理' })
  chk('处理成功返回 success', res1.success === true, res1)
  chk('状态改为 resolved', res1.ticket && res1.ticket.status === 'resolved', res1.ticket && res1.ticket.status)
  chk('处理备注已保存', res1.ticket && String(res1.ticket.handledNote).includes('已下线处理'))
  const res2 = await svc.resolve(r2.id, { status: 'rejected', handledNote: '无法复现' })
  chk('驳回状态 rejected', res2.ticket && res2.ticket.status === 'rejected', res2.ticket && res2.ticket.status)
  const e4 = await expectThrow(() => svc.resolve('not-exist-id', { status: 'resolved' }), '工单不存在')
  chk('不存在的工单 → 400', e4.threw && e4.matched && e4.status === 400, e4)

  // 清理
  const del = await prisma.reportTicket.deleteMany({ where: { id: { in: createdIds } } })
  console.log('  清理 ' + del.count + ' 条测试工单')
  chk('测试数据已清理', del.count === createdIds.length, { deleted: del.count, created: createdIds.length })

  console.log('')
  console.log('REPORT SMOKE ' + (fail === 0 ? 'OK' : 'FAILED') + ' (' + (pass + fail) + ' checks, ' + fail + ' failed)')
  process.exitCode = fail === 0 ? 0 : 1
}

main()
  .catch((e) => { console.error('SMOKE ERROR', e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect().catch(() => {}))
