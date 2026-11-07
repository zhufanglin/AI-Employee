import { createRequire } from 'node:module';
import { loadServerEnv } from './_env.mjs';
loadServerEnv();
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const { PrismaClient } = require('@prisma/client');
const { JwtService } = require('@nestjs/jwt');
const db = new PrismaClient();
try {
  const initial = await db.mediaTaskRecord.findUnique({ where: { taskId: process.argv[2] } });
  if (!initial) throw new Error('local media task not found');
  const token = new JwtService({ secret: process.env.JWT_SECRET || 'dev-only-change-me' }).sign({ sub: initial.userId, role: 'user' });
  const response = await fetch('http://127.0.0.1:3000/api/media/tasks/' + encodeURIComponent(initial.taskId), { headers: { authorization: 'Bearer ' + token } });
  const body = await response.json();
  const items = await db.mediaTaskRecord.findMany({ where: { userId: initial.userId }, select: { taskId: true, status: true, estimatedAmount: true, settledAmount: true, resultUrl: true, createdAt: true, resultMeta: true } });
  const user = await db.user.findUnique({ where: { id: initial.userId }, select: { credits: true } });
  console.log(JSON.stringify({ queryStatus: response.status, upstreamStatus: body.status || null, tasks: items.map(({ resultMeta, ...item }) => ({ ...item, usage: resultMeta?.usage || null })), credits: user?.credits }, null, 2));
} finally { await db.$disconnect(); }
