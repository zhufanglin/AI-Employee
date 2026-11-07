// T-12 冒烟：微信支付 Native 下单 → 回调/模拟支付入账 → 幂等 → 管理端后台
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
const hide = (o) => ({ ...o });
async function login(phone) {
  const send = await j("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone }) });
  const res = await j("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone, code: send.body.devCode }) });
  return { token: res.body.accessToken, id: res.body.user?.id, phone };
}
const check = (name, cond, detail) => { results.push({ name, ok: !!cond, detail }); console.log((cond ? "PASS " : "FAIL ") + name, detail === undefined ? "" : JSON.stringify(detail)); };
const results = [];
let pkgId = null;
let adminPkgId = null;

try {
  const admin = await j("/auth/admin/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "admin" }) });
  const ah = { authorization: "Bearer " + admin.body.accessToken };
  check("admin login", !!admin.body.accessToken);

  const u = await login("135" + String(Date.now()).slice(-8));
  const uh = { authorization: "Bearer " + u.token };
  check("user login", !!u.token && !!u.id);

  // 1. 支付能力状态（公开）
  const st = await j("/payments/wechat/status");
  check("pay status public", st.status === 200 && st.body.appId === "wx219da5e18416b3fd" && st.body.mchId === "1118595998", st.body);
  check("pay mock enabled (verify env)", st.body.mock === true && st.body.configured === true, st.body);

  // 2. 管理端建套餐（元 -> 分）
  const created = await j("/admin/packages", { method: "POST", headers: ah, body: JSON.stringify({ name: "T12冒烟套餐", credits: 500, price: 2.5, priceDisplay: "¥2.50", sort: 99 }) });
  adminPkgId = created.body?.id;
  check("admin create package yuan->fen", (created.status === 201 || created.status === 200) && created.body.price === 250 && created.body.credits === 500, hide(created.body));

  const patched = await j("/admin/packages/" + adminPkgId, { method: "PATCH", headers: ah, body: JSON.stringify({ price: 3, credits: 600 }) });
  check("admin patch package", patched.body.price === 300 && patched.body.credits === 600, hide(patched.body));

  const badPkg = await j("/admin/packages", { method: "POST", headers: ah, body: JSON.stringify({ name: "坏套餐", credits: 0, price: 1 }) });
  check("admin create rejects invalid credits", badPkg.status === 400, badPkg.status);

  // 3. 用户下单
  const order = await j("/payments/orders", { method: "POST", headers: uh, body: JSON.stringify({ packageId: adminPkgId }) });
  check("create native order", (order.status === 201 || order.status === 200) && /^weixin:\/\/wxpay\/bizpayurl/.test(order.body.codeUrl), hide(order.body));
  const orderNo = order.body.orderNo;
  pkgId = order.body.packageName;

  const mine = await j("/payments/orders/mine", { headers: uh });
  check("order listed in mine", mine.body.items?.some((o) => o.orderNo === orderNo), mine.body.total);

  const balBefore = (await j("/credits/balance", { headers: uh })).body.balance;
  const stPending = await j("/payments/orders/" + orderNo + "/status", { headers: uh });
  check("status pending before pay", stPending.body.status === "pending", stPending.body.status);

  // 4. 回调入账（模拟支付，走 notify 的 mock 明文分支）
  const notify = await j("/payments/wechat/notify", {
    method: "POST",
    body: JSON.stringify({ out_trade_no: orderNo, transaction_id: "mock_tx_" + Date.now(), trade_state: "SUCCESS", amount_total: 300 }),
  });
  check("notify success credited", notify.body.handled === true && notify.body.credited === 600, hide(notify.body));

  const balAfter = (await j("/credits/balance", { headers: uh })).body.balance;
  check("balance increased by 600", balAfter === balBefore + 600, { balBefore, balAfter });

  const stPaid = await j("/payments/orders/" + orderNo + "/status", { headers: uh });
  check("order paid", stPaid.body.status === "paid", stPaid.body.status);

  // 5. 幂等：重复回调不重复入账
  const notify2 = await j("/payments/wechat/notify", {
    method: "POST",
    body: JSON.stringify({ out_trade_no: orderNo, transaction_id: "mock_tx_" + Date.now(), trade_state: "SUCCESS", amount_total: 300 }),
  });
  check("duplicate notify alreadyPaid", notify2.body.handled === true && notify2.body.credited === 0, hide(notify2.body));
  const balAfter2 = (await j("/credits/balance", { headers: uh })).body.balance;
  check("balance unchanged on duplicate", balAfter2 === balAfter, { balAfter, balAfter2 });

  const tx = await j("/credits/transactions", { headers: uh });
  check("recharge transaction written", tx.body.items?.some((t) => t.type === "recharge" && t.amount === 600), tx.body.items?.[0]?.description);

  // 6. 金额不符 -> 冻结订单，不入账
  const order2 = await j("/payments/orders", { method: "POST", headers: uh, body: JSON.stringify({ packageId: adminPkgId }) });
  const notify3 = await j("/payments/wechat/notify", {
    method: "POST",
    body: JSON.stringify({ out_trade_no: order2.body.orderNo, transaction_id: "mock_tx_bad", trade_state: "SUCCESS", amount_total: 1 }),
  });
  check("amount mismatch rejected", /金额不一致/.test(JSON.stringify(notify3.body)), hide(notify3.body));
  const frozen = await j("/payments/orders/" + order2.body.orderNo + "/status", { headers: uh });
  check("mismatch order frozen", frozen.body.status === "amount_mismatch", frozen.body.status);
  const bal3 = (await j("/credits/balance", { headers: uh })).body.balance;
  check("no credits on mismatch", bal3 === balAfter2, { balAfter2, bal3 });

  // 7. 管理端：人工确认 + 用户/订单/流水/概览
  const order3 = await j("/payments/orders", { method: "POST", headers: uh, body: JSON.stringify({ packageId: adminPkgId }) });
  const confirm = await j("/admin/orders/" + order3.body.orderNo + "/confirm", { method: "POST", headers: ah, body: JSON.stringify({ note: "冒烟人工确认" }) });
  check("admin confirm order", confirm.body.alreadyPaid === false && confirm.body.credited === 600, hide(confirm.body));
  const orderAdmin = await j("/admin/orders?keyword=" + u.phone, { headers: ah });
  check("admin orders search by phone", orderAdmin.body.items?.some((o) => o.orderNo === order3.body.orderNo), orderAdmin.body.total);
  check("admin order has user phone", orderAdmin.body.items?.[0]?.user?.phone === u.phone, orderAdmin.body.items?.[0]?.user?.phone);

  const users = await j("/admin/users?keyword=" + u.phone, { headers: ah });
  check("admin users search", users.body.items?.[0]?.id === u.id, users.body.total);
  const adj = await j("/admin/users/" + u.id + "/credits", { method: "POST", headers: ah, body: JSON.stringify({ amount: 5, reason: "冒烟赠送" }) });
  check("admin grant credits", adj.status === 201 || adj.status === 200, hide(adj.body));
  const ded = await j("/admin/users/" + u.id + "/credits", { method: "POST", headers: ah, body: JSON.stringify({ amount: -5, reason: "冒烟扣减" }) });
  check("admin deduct credits", (ded.status === 201 || ded.status === 200) && ded.body.balance === adj.body.balance - 5, hide(ded.body));

  const txs = await j("/admin/credit-transactions?limit=5", { headers: ah });
  check("admin transactions list", Array.isArray(txs.body.items) && txs.body.items.length > 0, txs.body.total);
  const ov = await j("/admin/overview", { headers: ah });
  check("admin overview", ov.body.users > 0 && ov.body.paidOrders > 0 && ov.body.revenueTotal > 0, hide(ov.body));

  const noAuth = await j("/admin/overview");
  check("admin requires auth", noAuth.status === 401 || noAuth.status === 403, noAuth.status);

  const noAuthOrder = await j("/payments/orders", { method: "POST", body: JSON.stringify({ packageId: adminPkgId }) });
  check("order requires auth", noAuthOrder.status === 401 || noAuthOrder.status === 403, noAuthOrder.status);

  const badPkgOrder = await j("/payments/orders", { method: "POST", headers: uh, body: JSON.stringify({ packageId: "nope" }) });
  check("unknown package 404", badPkgOrder.status === 404, badPkgOrder.status);
} catch (err) {
  console.log("ERROR", err?.stack || err);
  results.push({ name: "exception", ok: false, detail: String(err?.message || err) });
} finally {
  try {
    if (adminPkgId) await prisma.creditPackage.update({ where: { id: adminPkgId }, data: { isActive: false } });
    const fs = await import("node:fs");
    fs.writeFileSync("_smoke_t12.json", JSON.stringify({ results, at: new Date().toISOString() }, null, 2));
  } catch {}
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log("\nT-12 smoke: " + (results.length - failed.length) + "/" + results.length + " passed");
if (failed.length) {
  console.log("FAILED:", failed.map((f) => f.name).join(", "));
  process.exit(1);
}
