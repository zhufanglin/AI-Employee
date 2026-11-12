/**
 * P45-2 冒烟：法律文本同意 + 个人信息跨境「单独同意」落库
 *
 * 直接调编译后的 AuthService（不依赖短信通道与 HTTP），覆盖：
 *  1) 造账号不带 consent → BadRequest（中文可操作提示），且不落任何同意记录
 *  2) 带 consent（version + crossBorder=true）→ 建号成功，落 4 条 ConsentRecord（terms/privacy/aigc/cross-border）
 *  3) 重复登录同版本 → 幂等，不重复写（仍 4 条）
 *  4) crossBorder=false → 只写 3 条（单独同意不能被通用条款推定）
 *  5) 老账号无 consent 登录不被打断（不阻塞既有用户）
 *
 * 用法：node scripts/smoke-p45-consent.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomInt } from 'node:crypto'

const require = createRequire(import.meta.url)
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '')

// 手工加载 packages/server/.env（只补齐缺失项，不覆盖已有 env）
try {
  const raw = readFileSync(ROOT + '/packages/server/.env', 'utf8').replace(/^\uFEFF/, '')
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {}

const { PrismaClient } = require(ROOT + '/node_modules/.prisma/client')
const { AuthService } = require(ROOT + '/packages/server/dist/auth/auth.service.js')
const { JwtService } = require(ROOT + '/node_modules/@nestjs/jwt')

const prisma = new PrismaClient()
const jwt = new JwtService({ secret: 'smoke-secret', signOptions: { expiresIn: '1h' } })
const smsStub = { send: async () => ({ sent: true, devCode: null }) }
const auth = new AuthService(prisma, jwt, smsStub)

let pass = 0, fail = 0
const chk = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')) }
}
const randPhone = () => '199' + String(randomInt(0, 1e8)).padStart(8, '0')
async function seedCode(phone, code = '123456', purpose = 'login') {
  await prisma.verificationCode.create({
    data: { phone, code, purpose, expiresAt: new Date(Date.now() + 10 * 60 * 1000) }
  })
}
async function consentKeys(userId) {
  const rows = await prisma.consentRecord.findMany({ where: { userId } })
  return { keys: rows.map((r) => r.docKey).sort(), rows }
}

async function main() {
  console.log('== P45 同意记录冒烟 ==')
  const created = []

  // 1) 无同意 → 拒
  const p1 = randPhone(); await seedCode(p1)
  let err1 = null
  try { await auth.smsLogin(p1, '123456') } catch (e) { err1 = e }
  chk('新账号不带同意被拒', !!err1 && /请先阅读并同意/.test(err1.message || ''), err1 && err1.message)
  chk('被拒后没有账号', (await prisma.user.count({ where: { phone: p1 } })) === 0)

  // 2) 带同意 + 跨境单独同意
  const p2 = randPhone(); await seedCode(p2)
  const r2 = await auth.smsLogin(p2, '123456', { version: '2026-11-12', crossBorder: true, source: 'smoke', ip: '127.0.0.1', userAgent: 'smoke' })
  chk('带同意可建号登录', !!r2.accessToken)
  const u2 = await prisma.user.findUnique({ where: { phone: p2 } }); created.push(u2.id)
  const { keys: k2, rows: rows2 } = await consentKeys(u2.id)
  chk('落 4 条同意记录', k2.join(',') === 'aigc,cross-border,privacy,terms', k2)
  chk('版本写入正确', rows2.every((r) => r.version === '2026-11-12'))
  chk('来源/ip 可追溯', rows2.every((r) => r.source === 'smoke' && r.ip === '127.0.0.1'))

  // 3) 幂等
  await seedCode(p2)
  const r3 = await auth.smsLogin(p2, '123456', { version: '2026-11-12', crossBorder: true, source: 'smoke' })
  chk('老账号再次登录成功', !!r3.accessToken)
  chk('同版本不重复写', (await consentKeys(u2.id)).keys.length === 4)

  // 4) crossBorder=false → 3 条
  const p4 = randPhone(); await seedCode(p4)
  await auth.smsLogin(p4, '123456', { version: '2026-11-12', crossBorder: false, source: 'smoke' })
  const u4 = await prisma.user.findUnique({ where: { phone: p4 } }); created.push(u4.id)
  const { keys: k4 } = await consentKeys(u4.id)
  chk('无跨境单独同意只写 3 条', k4.join(',') === 'aigc,privacy,terms', k4)

  // 5) 老账号无 consent 不被打断
  await seedCode(p2)
  const r5 = await auth.smsLogin(p2, '123456')
  chk('老账号无同意载荷仍可登录', !!r5.accessToken)

  // 清理
  for (const id of created) {
    await prisma.consentRecord.deleteMany({ where: { userId: id } })
    await prisma.session.deleteMany({ where: { userId: id } })
    await prisma.user.delete({ where: { id } }).catch(() => {})
  }
  await prisma.verificationCode.deleteMany({ where: { phone: { in: [p1, p2, p4] } } })

  console.log('P45 CONSENT SMOKE ' + (fail === 0 ? 'OK' : 'FAILED') + ' (' + pass + ' checks, ' + fail + ' failed)')
  await prisma.$disconnect()
  process.exitCode = fail === 0 ? 0 : 1
}

main().catch(async (e) => {
  console.error('SMOKE ERROR: ' + (e && e.stack ? e.stack : e))
  await prisma.$disconnect().catch(() => {})
  process.exitCode = 1
})
