// User-authorized reconciliation of one known local test reservation only.
import { createRequire } from 'node:module';
import { loadServerEnv } from './_env.mjs';
loadServerEnv();
if (process.env.FCM_APPROVE_LOCAL_REFUND !== '1') throw new Error('Explicit local test refund opt-in required');
const base = 'http://127.0.0.1:3000/api';
const taskId = 'reservation-574781de-381d-4b15-9681-ad62df67dbe7';
const sourceTaskId = '2118413507943030785';
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const db = new (require('@prisma/client').PrismaClient)();
const post = async (path, body, token) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  const result = await r.json();
  if (!r.ok) throw new Error(result?.error?.message || result?.message || `HTTP ${r.status}`);
  return result;
};
try {
  const reservation = await db.mediaTaskRecord.findUnique({ where: { taskId } });
  const source = await db.mediaTaskRecord.findUnique({ where: { taskId: sourceTaskId } });
  if (!reservation || !source || reservation.userId !== source.userId || reservation.status !== 'REVIEW' || reservation.estimatedAmount !== 20) throw new Error('Local test reservation differs from expected state; no change made');
  const before = (await db.user.findUniqueOrThrow({ where: { id: reservation.userId }, select: { credits: true } })).credits;
  const admin = await post('/admin/login', { username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_PASSWORD || 'admin' });
  await post('/admin/media/pending-review/' + encodeURIComponent(taskId) + '/resolve', { action: 'refund', reason: '用户确认：运行商账单全部来源及状态未见该时段第二次提交记录，退回本地测试预扣。' }, admin.accessToken);
  const after = (await db.user.findUniqueOrThrow({ where: { id: reservation.userId }, select: { credits: true } })).credits;
  const updated = await db.mediaTaskRecord.findUniqueOrThrow({ where: { taskId } });
  const refunds = await db.creditTransaction.findMany({ where: { userId: reservation.userId, type: 'refund', description: { contains: taskId } }, select: { amount: true, createdAt: true } });
  if (after !== before + 20 || updated.status !== 'FAILED' || refunds.length !== 1 || refunds[0].amount !== 20) throw new Error('Refund outcome needs manual inspection');
  console.log(JSON.stringify({ before, after, refunded: refunds[0].amount, status: updated.status, reviewRecorded: Boolean(updated.resultMeta?.review) }));
} finally { await db.$disconnect(); }
