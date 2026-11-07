import { loadServerEnv } from "./_env.mjs";
loadServerEnv();
// W2 冒烟：登录 → 发代理令牌 → compute 非流式/流式 → 查积分与用量
const BASE = process.env.BASE || "http://127.0.0.1:3000/api";

async function j(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(path + " -> " + res.status + " " + JSON.stringify(body).slice(0, 500));
  return body;
}

// 每次换成新手机号，避免 60 秒短信频控与旧账号脏数据影响冒烟可重复性
const phone = process.env.SMOKE_PHONE || "139" + String(Date.now()).slice(-8);

// 1. 短信验证码（开发模式会回显 devCode）
const send = await j("/auth/sms/send", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ phone }),
});
console.log("1) sms/send:", JSON.stringify(send));

const login = await j("/auth/sms/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ phone, code: send.devCode }),
});
const token = login.accessToken;
const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
console.log("2) login ok user:", login.user.id, "credits:", login.user.credits);

// 1.5 重置该测试账号的当月免费额度与积分，让冒烟可重复（不影响真实用户）
{
  const { createRequire } = await import("node:module");
  const path = await import("node:path");
  const req = createRequire(path.resolve("packages/server/package.json"));
  const { PrismaClient } = req("@prisma/client");
  const prisma = new PrismaClient();
  const now = new Date();
  const limit = 10;
  await prisma.userMonthlyUsage.upsert({
    where: { userId_year_month: { userId: login.user.id, year: now.getFullYear(), month: now.getMonth() + 1 } },
    update: { quotaLimit: limit, quotaUsed: 0, quotaRemaining: limit },
    create: { userId: login.user.id, year: now.getFullYear(), month: now.getMonth() + 1, quotaLimit: limit, quotaUsed: 0, quotaRemaining: limit, resetAt: new Date(now.getFullYear(), now.getMonth() + 1, 1) },
  });
  await prisma.user.update({ where: { id: login.user.id }, data: { credits: 0, totalCreditsConsumed: 0, totalCreditsRecharged: 0 } });
  await prisma.$disconnect();
  console.log("2.5) reset test user quota=10 credits=0");
}

// 2. 代理令牌
const pt = await j("/volcengine/proxy-token", { headers: auth });
console.log("3) proxy token:", pt.token.slice(0, 28) + "...");

// 3. 模型列表（ComputeAuthGuard + proxy token）
const models = await j("/compute/models", { headers: { authorization: "Bearer " + pt.token } });
console.log("4) compute/models:", models.data.length, "个；样例:", JSON.stringify(models.data.slice(0, 2)));

// 4. 非流式 chat
const chat = await j("/compute/chat/completions", {
  method: "POST",
  headers: { authorization: "Bearer " + pt.token, "content-type": "application/json" },
  body: JSON.stringify({
    model: "doubao-seed-2.0-pro",
    messages: [{ role: "user", content: "用一句话介绍你自己" }],
  }),
});
console.log("5) non-stream reply:", JSON.stringify(chat.choices?.[0]?.message?.content || chat).slice(0, 200));
console.log("   usage:", JSON.stringify(chat.usage));

// 5. 流式 chat（SSE 逐块）
const res = await fetch(BASE + "/compute/chat/completions", {
  method: "POST",
  headers: { authorization: "Bearer " + pt.token, "content-type": "application/json" },
  body: JSON.stringify({
    model: "doubao-seed-2.0-pro",
    stream: true,
    messages: [{ role: "user", content: "数到三，每个数字一行" }],
  }),
});
let sse = "";
let deltas = 0;
const reader = res.body.getReader();
const dec = new TextDecoder();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  const t = dec.decode(value, { stream: true });
  sse += t;
  deltas += (t.match(/data: /g) || []).length;
}
console.log("6) stream status:", res.status, "chunks(data:):", deltas, "bytes:", sse.length);
console.log("   tail:", JSON.stringify(sse.slice(-240)));

// 6. 积分与用量
const bal = await j("/credits/balance", { headers: auth });
const tx = await j("/credits/transactions?limit=5", { headers: auth });
const recs = await j("/credits/ai-usage-records?limit=5", { headers: auth });
const stats = await j("/credits/ai-usage-stats", { headers: auth });
console.log("7) balance:", JSON.stringify(bal));
console.log("   transactions:", tx.total, tx.items.map(i => i.type + ":" + i.amount + " " + i.description).join(" | "));
console.log("   usage records:", recs.total, recs.items.map(i => i.modelId + " tok=" + i.totalTokens + " credits=" + i.creditsCharged).join(" | "));
console.log("8) stats:", JSON.stringify({ totalRequests: stats.totalRequests, totalTokens: stats.totalTokens, totalCreditsCharged: stats.totalCreditsCharged, byModel: stats.byModel }));
console.log("SMOKE OK");
