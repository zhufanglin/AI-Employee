#!/usr/bin/env node
/**
 * P43 全面逆向检查：第一波修复的回归冒烟
 * 静态：渠道回调幂等 + 5 秒快回 / 媒体结算与 user_billing / devCode 不回传 / 状态机不可绕过审批 / 市场匿名可访问 / 定时补跑不写假失败
 * 在线：匿名读员工市场与详情（不带 skillMd）/ 登录后带购买状态 / PATCH 不能直接 succeeded / 已领取任务回写必须带 claimToken
 * 用法：node scripts/smoke-p43-p0p1.mjs   （需要本地 API 在 FCM_API_BASE，默认 http://127.0.0.1:3000/api）
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.FCM_API_BASE || "http://127.0.0.1:3000/api";
const PHONE = process.env.FCM_PHONE || "13900000002";
const SLUG = process.env.FCM_SMOKE_EMPLOYEE || "boss-daily-lead-topics";
let pass = 0;
let token = "";

function ok(name, detail) { pass += 1; console.log("[PASS] " + name + (detail ? " :: " + detail : "")); }
function bad(name, detail) { console.log("[FAIL] " + name + " :: " + detail); process.exitCode = 1; }
function check(name, cond, detail) { if (cond) ok(name, detail); else bad(name, detail); }
function read(rel) { return readFileSync(join(ROOT, rel), "utf8"); }

async function call(path, init = {}) {
  const headers = { "content-type": "application/json", ...(init.headers || {}) };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { ...init, headers });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

console.log("=== 静态：渠道回调幂等（域 D P0-2）===");
const schema = read("packages/server/prisma/schema.prisma");
check("Prisma 有 ChannelInboundMsg", /^model ChannelInboundMsg \{/m.test(schema));
check("幂等唯一键 (channel,msgId)", /@@unique\(\[channel, msgId\]\)/.test(schema));
const dispatcher = read("packages/server/src/channels/dispatcher.service.ts");
check("dispatcher 有 claimInbound", /private async claimInbound\(/.test(dispatcher));
// 只有 null 才算重复；空串是「没有幂等键 / 幂等表写失败，放行」，用 !claim 会把正常消息全吞掉。
check("重复 MsgId 直接回 ACK 不建单", /if \(claim === null\)[\s\S]{0,200}return ACK_TEXT;/.test(dispatcher));
check("幂等表写失败不吞消息（重复判定不用 !claim）", !/if \(!claim\)[\s\S]{0,120}重复回调已忽略/.test(dispatcher));
check("建单后回填 taskId", dispatcher.includes("attachInboundTask(claim, task.id)"));
check("建单失败释放占位", dispatcher.includes("releaseInbound(claim)"));
const channels = read("packages/server/src/channels/channels.controller.ts");
check("企微回调文本消息先 ACK 再后台处理", /payload.msgType === "text" && this.config.employeeSlug/.test(channels));
check("公众号回调同样快回", (channels.match(/reply = ACK_TEXT;/g) || []).length >= 2, "count=" + (channels.match(/reply = ACK_TEXT;/g) || []).length);

console.log("=== 静态：媒体计费结算（域 D P0-1/P0-3）===");
const media = read("packages/server/src/media/media.service.ts");
check("media 有 settleSuccess", /private async settleSuccess\(/.test(media));
check("结算只做一次（settledAmount: null 闸门）", /settledAmount: null/.test(media));
check("按实际时长算价", /private actualSeconds\(/.test(media));
check("结算写积分流水", media.includes("媒体任务结算"));
check("提交响应带 user_billing", /user_billing:\s*\{/.test(media));

console.log("=== 静态：认证与短信（域 A P0/P1）===");
const sms = read("packages/server/src/auth/sms.sender.ts");
check("devCode 需显式开关且非生产", /returnCodeAllowed/.test(sms) && /NODE_ENV[\s\S]{0,80}production/.test(sms));
check("devCode 默认 false", /envBool\("DEV_RETURN_SMS_CODE", false\)/.test(sms));
const auth = read("packages/server/src/auth/auth.service.ts");
check("手机号注册强制验证码", /if \(dto.phone\)[\s\S]{0,160}请先获取短信验证码/.test(auth));
check("验证码有效期 10 分钟（对齐原版）", /CODE_TTL_MS = 10 \* 60 \* 1000/.test(auth));

console.log("=== 静态：员工域（域 B P0/P1）===");
const emp = read("packages/server/src/employee/employee.service.ts");
check("PATCH 不能直接置 succeeded", /body.status === "succeeded"[\s\S]{0,160}BadRequestException/.test(emp));
check("已领取任务回写必须带 claimToken", /任务已被执行器领取，回写必须携带领取凭据/.test(emp));
check("市场返回购买状态字段", emp.includes("userPurchaseStatus") && emp.includes("userExpiresAt"));
check("匿名详情不返回 skillMd", /withSkill \?/.test(emp));
const ctrl = read("packages/server/src/employee/employee.controller.ts");
check("marketplace 允许匿名", /@Public\(\)[\s\S]{0,60}@Get\("marketplace"\)/.test(ctrl));
check("marketplace 带了 token 时仍解析 req.user", /@OptionalAuth\(\)[\s\S]{0,60}@Get\("marketplace"\)/.test(ctrl));
check("员工详情允许匿名", /@Public\(\)[\s\S]{0,60}@Get\(":slug"\)/.test(ctrl));
const cronSvc = read("packages/server/src/employee/employee-cron.service.ts");
check("补跑不写 missed_schedule 假失败", !cronSvc.includes("missed_schedule"));
const orderSvc = read("packages/server/src/employee/employee-order.service.ts");
check("订单状态可按 id 或 orderNo 查", /OR: \[\{ orderNo: ref \}, \{ id: ref \}\]/.test(orderSvc));

console.log("=== 在线：匿名读市场/详情 ===");
const anonMarket = await call("/employees/marketplace");
const anonItems = anonMarket.body && (anonMarket.body.items || anonMarket.body.data || []);
check("匿名 GET /employees/marketplace 200", anonMarket.status === 200, "status=" + anonMarket.status);
check("匿名市场有员工且不含 skillMd", Array.isArray(anonItems) && anonItems.length > 0 && anonItems.every((i) => i.skillMd === undefined), "count=" + (Array.isArray(anonItems) ? anonItems.length : "n/a"));
const anonDetail = await call("/employees/" + SLUG);
const anonDoc = anonDetail.body && (anonDetail.body.data || anonDetail.body);
check("匿名 GET /employees/:slug 200", anonDetail.status === 200, "status=" + anonDetail.status);
check("匿名详情 skillMd 为空", !!anonDoc && !anonDoc.skillMd, "len=" + (anonDoc && anonDoc.skillMd ? String(anonDoc.skillMd).length : 0));

async function login() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sent = await call("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone: PHONE }) });
    const code = sent.body && (sent.body.devCode || (sent.body.data && sent.body.data.devCode));
    if (code) {
      const res = await call("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone: PHONE, code }) });
      const access = res.body && (res.body.accessToken || res.body.token || (res.body.data && res.body.data.accessToken));
      if (access) { token = access; return true; }
    }
    console.log("登录被频控或未拿到 devCode，等 62s 重试…");
    await new Promise((r) => setTimeout(r, 62000));
  }
  return false;
}

if (!(await login())) {
  bad("登录", "拿不到 devCode 或 token（本地需 DEV_RETURN_SMS_CODE=true）");
} else {
  ok("登录成功");

  const market = await call("/employees/marketplace");
  const items = (market.body && (market.body.items || market.body.data)) || [];
  const first = Array.isArray(items) ? items[0] : null;
  check("登录后市场带 purchased/userPurchaseStatus", !!first && "purchased" in first && "userPurchaseStatus" in first, first ? JSON.stringify({ purchased: first.purchased, status: first.userPurchaseStatus }) : "no items");

  // 用当前账号已安装的员工做后续用例（未安装时 /run 会 403）
  const mineRes = await call("/employees/mine");
  const mineItems = (mineRes.body && (mineRes.body.items || mineRes.body.data)) || [];
  let installed = Array.isArray(mineItems) ? mineItems.find((i) => i.install && i.install.effectiveEnabled) : null;
  if (!installed) {
    // 本地测试账号常常没装员工：先装一个（预装/免费员工不需要下单）
    const inst = await call("/employees/" + SLUG + "/install", { method: "POST", body: JSON.stringify({}) });
    check("当场安装测试员工", inst.status < 300, "status=" + inst.status + " body=" + JSON.stringify(inst.body).slice(0, 140));
    const again = await call("/employees/mine");
    const againItems = (again.body && (again.body.items || again.body.data)) || [];
    installed = Array.isArray(againItems) ? againItems.find((i) => i.install && i.install.effectiveEnabled) : null;
  }
  const slug = (installed && installed.slug) || SLUG;
  console.log("使用员工 slug=" + slug + (installed ? "（已安装）" : "（回落到默认，可能 403）"));

  const detail = await call("/employees/" + slug);
  const doc = detail.body && (detail.body.data || detail.body);
  check("登录后详情返回 skillMd", !!doc && typeof doc.skillMd === "string" && doc.skillMd.length > 100, "len=" + (doc && doc.skillMd ? doc.skillMd.length : 0));

  // 任务状态机：PATCH 不得直接 succeeded
  const created = await call("/employees/" + slug + "/run", { method: "POST", body: JSON.stringify({ input: { text: "P43 冒烟：状态机校验" }, executor: "cloud", title: "P43 冒烟-状态机" }) });
  const task = created.body && (created.body.task || created.body.data || created.body);
  check("创建任务成功", created.status < 300 && !!task && !!task.id, "status=" + created.status + " id=" + (task && task.id));
  if (task && task.id) {
    const badPatch = await call("/employee-tasks/" + task.id, { method: "PATCH", body: JSON.stringify({ status: "succeeded", outputText: "绕过验收" }) });
    check("PATCH succeeded 被拒", badPatch.status >= 400, "status=" + badPatch.status + " body=" + JSON.stringify(badPatch.body).slice(0, 120));

    const pulled = await call("/employee-execution/pull?limit=10", { method: "POST" });
    const claimedItems = (pulled.body && (pulled.body.items || pulled.body.data)) || [];
    const claimed = Array.isArray(claimedItems) ? claimedItems.find((t) => t.id === task.id) : null;
    const claimToken = claimed && claimed.outputMeta && claimed.outputMeta.claimToken;
    check("云执行器拉取到任务并带 claimToken", !!claimToken, claimToken ? "token len=" + String(claimToken).length : "not claimed");
    if (claimToken) {
      const noLease = await call("/employee-tasks/" + task.id, { method: "PATCH", body: JSON.stringify({ status: "awaiting_approval", outputText: "无凭据回写" }) });
      check("无 claimToken 回写被拒（租约）", noLease.status >= 400, "status=" + noLease.status + " body=" + JSON.stringify(noLease.body).slice(0, 120));
      const withLease = await call("/employee-tasks/" + task.id, { method: "PATCH", body: JSON.stringify({ status: "awaiting_approval", claimToken, outputText: "P43 冒烟回写" }) });
      check("带 claimToken 回写成功", withLease.status < 300, "status=" + withLease.status);
      const approved = await call("/employee-tasks/" + task.id + "/approve", { method: "POST", body: JSON.stringify({}) });
      check("审批接口可置 succeeded", approved.status < 300, "status=" + approved.status);
    }
  }
}

console.log("\nP43 RESULT: " + (process.exitCode ? "FAILED" : "ALL PASS") + " (" + pass + " checks)");
