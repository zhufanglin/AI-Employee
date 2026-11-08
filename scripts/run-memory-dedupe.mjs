#!/usr/bin/env node
/**
 * 运维脚本：清理存量重复记忆（P21）。
 *
 * 用法（本机或生产机都能跑）：
 *   node scripts/run-memory-dedupe.mjs                      # 只出报告，不改数据
 *   node scripts/run-memory-dedupe.mjs --mode=apply         # 执行合并与删除
 *   node scripts/run-memory-dedupe.mjs --limit=60           # 本次扫描 60 条（最多 60）
 *   FCM_API_BASE=https://api.fcmediaagent.com/api FCM_PHONE=13900000002 node scripts/run-memory-dedupe.mjs
 *
 * 备注：清理需要短信登录（白名单手机号自动回 devCode），无需人工输入验证码。
 */
const BASE = process.env.FCM_API_BASE || "http://127.0.0.1:3000/api";
const PHONE = process.env.FCM_PHONE || "13900000002";
const args = new Map(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, ...rest] = a.replace(/^--/, "").split("=");
    return [k, rest.join("=") || "1"];
  }),
);
const mode = args.get("mode") === "apply" ? "apply" : "report";
const limit = Number(args.get("limit") || 30);
let token = "";

async function call(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { ...options, headers });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

async function login() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sent = await call("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone: PHONE }) });
    const code = sent.body && (sent.body.devCode || (sent.body.data && sent.body.data.devCode));
    if (code) {
      const res = await call("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone: PHONE, code }) });
      const access = res.body && (res.body.accessToken || res.body.token || (res.body.data && res.body.data.accessToken));
      if (access) { token = access; return; }
    }
    console.log("短信频控中，等 62 秒重试…");
    await new Promise((r) => setTimeout(r, 62000));
  }
  throw new Error("登录失败");
}

await login();
const res = await call("/capabilities/run", { method: "POST", body: JSON.stringify({ name: "memory_dedupe", params: { mode, limit } }) });
const body = res.body || {};
if (!body.success) {
  console.error("清理失败：" + (body.error || res.status));
  process.exit(1);
}
const data = body.data || {};
console.log("模式：" + data.mode + "，扫描 " + data.scanned + "/" + data.total + " 条，模型调用 " + data.calls + " 次，耗时 " + data.durationMs + "ms" + (data.truncated ? "（本轮达到上限，建议再跑一次）" : ""));
if (!data.proposals.length) {
  console.log("没有发现重复记忆。");
} else {
  console.log("");
  data.proposals.forEach((p, i) => {
    console.log((i + 1) + ". [" + (p.relation === "merge" ? "可合并" : "重复") + "] 保留 " + (p.keepTitle || p.keepId) + "（" + p.keepCreatedAt + "）");
    console.log("   删除 " + (p.dropTitle || p.dropId) + "（" + p.dropCreatedAt + "），词面相似度 " + p.similarity);
    if (p.mergedPreview) console.log("   合并后：" + p.mergedPreview);
  });
  console.log("");
  if (data.mode === "apply") console.log("已执行 " + data.applied + " 处合并，重复条目已删除。");
  else console.log("以上为报告；确认无误后加 --mode=apply 执行。");
}
