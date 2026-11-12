// T-08 冒烟：套餐兑换码 / 套餐校验 / 员工订单 / 支付前不得授权 / 到期失效
import { createRequire } from "node:module";
import { loadServerEnv } from "./_env.mjs";
loadServerEnv();
const BASE = process.env.FCM_API || "http://127.0.0.1:3000/api";
const SERVER_DIR = process.env.FCM_SERVER_DIR || "C:\\Users\\30290\\Desktop\\fcmediaagent-replica\\packages\\server";
const require = createRequire(SERVER_DIR + "\\package.json");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const j = async (p, opts = {}) => {
  const r = await fetch(BASE + p, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, body: b };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function health() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + "/health"); if (r.ok) return true; } catch {}
    await wait(1000);
  }
  return false;
}
async function login(phone) {
  const send = await j("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone }) });
  const code = send.body.devCode;
  const res = await j("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone, code, consent: { version: "2026-11-12", crossBorder: true, source: "smoke" } }) });
  return { token: res.body.accessToken, id: res.body.user?.id, phone };
}
const out = { steps: [] };
const step = (name, data) => { out.steps.push({ name, ...data }); console.log(name, JSON.stringify(data)); };

const results = [];
const check = (name, cond, detail) => { results.push({ name, ok: !!cond, detail }); console.log((cond ? "PASS " : "FAIL ") + name, detail ?? ""); };

try {
  if (!(await health())) { console.log("SERVER NOT UP"); process.exit(1); }

  const admin = await j("/auth/admin/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "admin" }) });
  const adminAuth = { authorization: "Bearer " + admin.body.accessToken };
  check("admin login", admin.status === 201 || admin.status === 200, admin.status);

  const u1 = await login("137" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0"));
  const u2 = await login("136" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0"));
  const a1 = { authorization: "Bearer " + u1.token };
  const a2 = { authorization: "Bearer " + u2.token };
  check("user login", !!u1.token && !!u2.token);

  // 1. 预设三档（公开）
  const presets = await j("/packages/presets");
  check("presets three tiers", presets.body.items?.length === 3 && presets.body.items.map((p) => p.id).join(",") === "traffic,private-domain,flagship", presets.body.items?.map((p) => p.id));

  // 2. 无效兑换码
  const bad = await j("/redemption/redeem", { method: "POST", headers: a1, body: JSON.stringify({ code: "ZZZZZ-ZZZZZ-ZZZZZ" }) });
  check("invalid code rejected", bad.status === 400 && /不存在/.test(bad.body.message), bad.body.message);

  // 3. 管理员批量生成兑换码
  const batch = await j("/admin/redemption/batch", { method: "POST", headers: adminAuth, body: JSON.stringify({ packageId: "flagship", count: 2, validDays: 45, note: "smoke-t08" }) });
  check("admin batch codes", batch.status === 201 || batch.status === 200, { count: batch.body.count, batchId: batch.body.batchId });
  const code1 = batch.body.codes?.[0];
  const code2 = batch.body.codes?.[1];

  // 4. 核销
  const redeem = await j("/redemption/redeem", { method: "POST", headers: a1, body: JSON.stringify({ code: code1 }) });
  check("redeem grants package", redeem.status === 201 || redeem.status === 200, { packageId: redeem.body.packageId, validDays: redeem.body.validDays, expiresAt: redeem.body.expiresAt });

  // 5. 重复核销
  const again = await j("/redemption/redeem", { method: "POST", headers: a1, body: JSON.stringify({ code: code1 }) });
  check("code cannot be reused", again.status === 400 && /已被使用/.test(again.body.message), again.body.message);

  // 6. 我的套餐
  const mine = await j("/packages/mine", { headers: a1 });
  check("packages/mine active", mine.body.active?.length === 1 && mine.body.effectivePackages?.includes("flagship"), { active: mine.body.active?.length, effective: mine.body.effectivePackages });

  // 7. 套餐校验：临时给一个员工加 requiredPackage
  await prisma.aiEmployee.update({ where: { slug: "boss-lead-radar" }, data: { requiredPackage: "private-domain" } });
  const deny = await j("/employees/boss-lead-radar/install", { method: "POST", headers: a2, body: JSON.stringify({}) });
  check("install denied without package", deny.status === 403 && /套餐/.test(deny.body.message), deny.body.message);

  const grant = await j("/admin/packages/grant", { method: "POST", headers: adminAuth, body: JSON.stringify({ userId: u2.id, packageId: "flagship", validDays: 30, note: "smoke-t08 admin grant" }) });
  check("admin grant package", !!grant.body.id, grant.body.packageId);
  const allow = await j("/employees/boss-lead-radar/install", { method: "POST", headers: a2, body: JSON.stringify({}) });
  check("install allowed after grant (flagship superset)", allow.status === 201 || allow.status === 200, allow.status);
  await prisma.aiEmployee.update({ where: { slug: "boss-lead-radar" }, data: { requiredPackage: null } });
  await j("/employees/boss-lead-radar/install", { method: "DELETE", headers: a2 });

  // 8. 员工订单：造一个付费员工
  await prisma.aiEmployee.upsert({
    where: { slug: "smoke-paid-employee" },
    update: { price: 990, isBundled: false, isActive: true },
    create: { slug: "smoke-paid-employee", name: "冒烟付费员工", title: "smoke", price: 990, priceDisplay: "¥9.9 每天", isBundled: false, isActive: true, category: "smoke" },
  });
  const badDays = await j("/employee-orders", { method: "POST", headers: a1, body: JSON.stringify({ slug: "smoke-paid-employee", durationDays: 3 }) });
  check("invalid duration rejected", badDays.status === 400 && /无效的购买天数/.test(badDays.body.message), badDays.body.message);

  const bundled = await j("/employee-orders", { method: "POST", headers: a1, body: JSON.stringify({ slug: "boss-lead-radar", durationDays: 30 }) });
  check("bundled needs no purchase", bundled.status === 400 && /预装员工无需购买/.test(bundled.body.message), bundled.body.message);

  const order = await j("/employee-orders", { method: "POST", headers: a1, body: JSON.stringify({ slug: "smoke-paid-employee", durationDays: 30 }) });
  check("order created pending", order.status === 201 || order.status === 200, { orderNo: order.body.order?.orderNo, amount: order.body.amount, status: order.body.order?.status });
  check("amount = price * days", order.body.amount === 990 * 30, order.body.amount);

  const beforePay = await j("/employees/smoke-paid-employee/install", { method: "POST", headers: a1, body: JSON.stringify({}) });
  check("install blocked before payment", beforePay.status === 403 && /未购买或已到期/.test(beforePay.body.message), beforePay.body.message);

  const orders = await j("/admin/employee-orders?status=pending", { headers: adminAuth });
  check("admin sees pending order", orders.body.items?.some((o) => o.id === order.body.order.id), orders.body.total);

  const paid = await j("/admin/employee-orders/" + order.body.order.id + "/mark-paid", { method: "POST", headers: adminAuth, body: JSON.stringify({ transactionId: "manual-smoke" }) });
  check("mark paid", paid.body.status === "paid" && !!paid.body.employeeExpiresAt, paid.body.status);

  const afterPay = await j("/employees/smoke-paid-employee/install", { method: "POST", headers: a1, body: JSON.stringify({ days: 9999, expiresAt: "2099-01-01" }) });
  check("install after payment, client cannot extend", afterPay.status === 201 || afterPay.status === 200, { expiresAt: afterPay.body.install?.expiresAt });
  const allowedExpiry = new Date(afterPay.body.install?.expiresAt || 0).getTime();
  const expected = new Date(paid.body.employeeExpiresAt).getTime();
  check("expiry equals server grant (client days ignored)", Math.abs(allowedExpiry - expected) < 5000, { allowedExpiry: afterPay.body.install?.expiresAt, expected: paid.body.employeeExpiresAt });

  const runOk = await j("/employees/smoke-paid-employee/run", { method: "POST", headers: a1, body: JSON.stringify({ title: "paid run" }) });
  check("run after payment", runOk.status === 201 || runOk.status === 200, runOk.status);

  // 9. 到期失效
  await prisma.aiEmployeePurchase.updateMany({ where: { userId: u1.id, employeeSlug: "smoke-paid-employee" }, data: { expiresAt: new Date(Date.now() - 60000) } });
  const expiredRun = await j("/employees/smoke-paid-employee/run", { method: "POST", headers: a1, body: JSON.stringify({ title: "expired run" }) });
  check("run blocked after expiry", expiredRun.status === 403 && /未安装或授权已过期/.test(expiredRun.body.message), expiredRun.body.message);
  const expiredInstall = await j("/employees/smoke-paid-employee/install", { method: "POST", headers: a1, body: JSON.stringify({}) });
  check("install blocked after expiry", expiredInstall.status === 403, expiredInstall.status);

  const scan = await j("/admin/employee-orders/expire-scan", { method: "POST", headers: adminAuth, body: "{}" });
  check("expire scan runs", scan.status === 201 || scan.status === 200, scan.body);

  // 10. 过期令牌/无令牌
  const anon = await j("/packages/mine");
  check("packages/mine requires auth", anon.status === 401, anon.status);

  // 清理
  await prisma.aiEmployeeInstall.deleteMany({ where: { employeeId: (await prisma.aiEmployee.findUnique({ where: { slug: "smoke-paid-employee" } })).id } });
  await prisma.aiEmployeePurchase.deleteMany({ where: { employeeSlug: "smoke-paid-employee" } });
  await prisma.employeeOrder.deleteMany({ where: { employeeSlug: "smoke-paid-employee" } });
  await prisma.aiEmployee.deleteMany({ where: { slug: "smoke-paid-employee" } });
} catch (e) {
  console.error("SMOKE ERROR", e);
  results.push({ name: "unexpected error", ok: false, detail: String(e) });
} finally {
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log("\nRESULT", failed.length === 0 ? "GREEN" : "RED", `${results.length - failed.length}/${results.length}`);
if (failed.length) { console.log(JSON.stringify(failed, null, 1)); process.exit(1); }
