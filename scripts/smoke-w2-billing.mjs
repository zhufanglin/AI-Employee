// W2 计费场景 2：免费额度用完 + 有积分 → 应实扣 1 积分并写流水
import { createRequire } from "node:module";
import { loadServerEnv } from "./_env.mjs";
loadServerEnv();
const require = createRequire(import.meta.url);
const { PrismaClient } = require("../node_modules/@prisma/client");
const prisma = new PrismaClient();
const BASE = "http://127.0.0.1:3000/api";
const j = async (p, o = {}) => {
  const r = await fetch(BASE + p, o);
  const txt = await r.text();
  let b; try { b = JSON.parse(txt); } catch { b = txt; }
  if (!r.ok) throw new Error(p + " -> " + r.status + " " + JSON.stringify(b).slice(0, 400));
  return b;
};
// 每次换成新手机号，避免 60 秒短信频控与旧账号脏数据影响冒烟可重复性
const phone = process.env.SMOKE_PHONE || "139" + String(Date.now()).slice(-8);
const send = await j("/auth/sms/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }) });
const login = await j("/auth/sms/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone, code: send.devCode, consent: { version: "2026-11-12", crossBorder: true, source: "smoke" } }) });
const userId = login.user.id;
// 人为制造：额度用完 + 5 积分
await prisma.user.update({ where: { id: userId }, data: { credits: 5 } });
const now = new Date();
await prisma.userMonthlyUsage.upsert({
  where: { userId_year_month: { userId, year: now.getFullYear(), month: now.getMonth() + 1 } },
  update: { quotaUsed: 10, quotaRemaining: 0 },
  create: { userId, year: now.getFullYear(), month: now.getMonth() + 1, quotaLimit: 10, quotaUsed: 10, quotaRemaining: 0, resetAt: new Date(now.getFullYear(), now.getMonth() + 1, 1) },
});
const pt = await j("/volcengine/proxy-token", { headers: { authorization: "Bearer " + login.accessToken } });
const auth = { authorization: "Bearer " + pt.token, "content-type": "application/json" };
const chat = await j("/compute/chat/completions", { method: "POST", headers: auth, body: JSON.stringify({ model: "doubao-seed-2.0-lite", messages: [{ role: "user", content: "回复一个字：好" }] }) });
console.log("reply:", JSON.stringify(chat.choices?.[0]?.message?.content).slice(0, 80), "usage:", JSON.stringify(chat.usage));
const bal = await j("/credits/balance", { headers: { authorization: "Bearer " + login.accessToken } });
const tx = await j("/credits/transactions?limit=3", { headers: { authorization: "Bearer " + login.accessToken } });
const recs = await j("/credits/ai-usage-records?limit=3", { headers: { authorization: "Bearer " + login.accessToken } });
console.log("balance after:", JSON.stringify(bal));
console.log("transactions:", tx.items.map(i => i.type + ":" + i.amount + " " + i.description).join(" | "));
console.log("usage:", recs.items.map(i => i.modelId + " tok=" + i.totalTokens + " credits=" + i.creditsCharged + " partial=" + i.isPartialDeduct).join(" | "));

// 余额清零后再请求，应 402
await prisma.user.update({ where: { id: userId }, data: { credits: 0 } });
const r402 = await fetch(BASE + "/compute/chat/completions", { method: "POST", headers: auth, body: JSON.stringify({ model: "doubao-seed-2.0-lite", messages: [{ role: "user", content: "hi" }] }) });
console.log("402 test:", r402.status, JSON.stringify(await r402.json()).slice(0, 200));
await prisma.$disconnect();
console.log("SCENARIO2 OK");