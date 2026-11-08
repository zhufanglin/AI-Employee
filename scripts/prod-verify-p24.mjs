#!/usr/bin/env node
/**
 * 生产验收 P24：平台发布能力（服务器侧登记 + 明确的中文拦截提示）。
 *
 * P24 的真实发布发生在用户本机桌面端（RPA），生产只能验证：
 *   1) 能力目录里登记了 platform_publish / platform_status / platform_stats（category=platform）
 *   2) 三个能力在服务器上调用一律返回「需要在桌面端执行」的中文提示（不能假装成功）
 *   3) 非法平台名/缺参也走同一条提示，不会误触发上游
 *
 * 用法：
 *   FCM_API_BASE=https://api.fcmediaagent.com/api node scripts/prod-verify-p24.mjs
 * 生产有 60 秒短信频控：拿不到 devCode 时自动 sleep 62s 重试，最多 3 次。
 */
const RAW = (process.env.FCM_API_BASE || "http://127.0.0.1:3000").replace(/\/+$/, "");
const BASE = RAW.endsWith("/api") ? RAW : RAW + "/api";
const PHONE = process.env.FCM_PHONE || "13900000002";
const LOCAL_HINT = "平台发布需要在桌面端（本机）执行";
let token = "";
let pass = 0;
function ok(name, detail) { pass += 1; console.log("[PASS] " + name + (detail !== undefined ? " :: " + JSON.stringify(detail) : "")); }
function bad(name, detail) { console.log("[FAIL] " + name + " :: " + String(detail)); process.exitCode = 1; }
function assert(name, cond, detail) { if (cond) ok(name, detail); else bad(name, detail); }
async function call(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { ...options, headers });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}
function dataOf(body) { return body && typeof body === "object" && body.data !== undefined ? body.data : body; }

// 1) 未登录被拒
const anon = await call("/capabilities");
assert("未登录被拒（401）", anon.status === 401, "status=" + anon.status);

// 2) 短信登录
for (let attempt = 0; attempt < 3 && !token; attempt += 1) {
  const sent = await call("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone: PHONE }) });
  const code = sent.body && (sent.body.devCode || (sent.body.data && sent.body.data.devCode));
  if (code) {
    const res = await call("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone: PHONE, code }) });
    const access = res.body && (res.body.accessToken || res.body.token || (res.body.data && res.body.data.accessToken));
    if (access) { token = access; break; }
  }
  if (attempt < 2) { console.log("等待短信频控窗口 62s 后重试…"); await new Promise((r) => setTimeout(r, 62000)); }
}
assert("短信登录成功", !!token, token ? "token 已获取" : "登录失败");
if (!token) { console.log("ABORT: 无法登录"); process.exit(1); }
console.log("BASE = " + BASE);

// 3) 能力目录登记
const caps = await call("/capabilities");
const list = dataOf(caps.body);
const arr = Array.isArray(list) ? list : (list && Array.isArray(list.items) ? list.items : []);
const byName = new Map(arr.map((c) => [c && c.name, c]));
for (const n of ["platform_publish", "platform_status", "platform_stats"]) {
  const c = byName.get(n);
  assert("能力目录含 " + n, !!c, c ? { category: c.category, params: c.params } : "缺失");
  if (c) assert(n + " 分类为 platform", c.category === "platform", c.category);
}

// 4) 三个能力在服务器上必须给出中文提示，且绝不能返回成功
async function run(name, params) {
  const res = await call("/capabilities/run", { method: "POST", body: JSON.stringify({ name, params }) });
  const d = dataOf(res.body);
  const body = res.body || {};
  return {
    status: res.status,
    success: body.success === undefined ? undefined : body.success,
    error: body.error || (d && d.error) || "",
    data: d,
  };
}
const pub = await run("platform_publish", { platform: "douyin", type: "video", title: "验收", content: "验收文案", mediaPaths: "/tmp/x.mp4" });
assert("platform_publish 未返回成功", pub.success !== true, { status: pub.status, success: pub.success });
assert("platform_publish 提示需在桌面端执行", String(pub.error).includes(LOCAL_HINT), pub.error);

const st = await run("platform_status", { platform: "xiaohongshu" });
assert("platform_status 未返回成功", st.success !== true, st.success);
assert("platform_status 提示需在桌面端执行", String(st.error).includes(LOCAL_HINT), st.error);

const stats = await run("platform_stats", { platform: "shipinhao" });
assert("platform_stats 未返回成功", stats.success !== true, stats.success);
assert("platform_stats 提示需在桌面端执行", String(stats.error).includes(LOCAL_HINT), stats.error);

// 5) 缺参/非法平台也走同一条提示（不允许参数校验放行到外部）
const noParam = await run("platform_publish", {});
assert("platform_publish 缺参也提示桌面端", noParam.success !== true && String(noParam.error).includes(LOCAL_HINT), noParam.error);
const badName = await run("platform_publish", { platform: "weibo" });
assert("未知平台不误放行", badName.success !== true, badName.error);

console.log((process.exitCode ? "P24 PROD VERIFY FAILED" : "P24 PROD VERIFY GREEN") + " (" + pass + " checks)");
