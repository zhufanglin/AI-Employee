#!/usr/bin/env node
/** 生产验收 P22：记忆清理定时任务（管理端状态 + 手动触发）。 */
const BASE = process.env.FCM_API_BASE || "http://127.0.0.1:3000/api";
const ADMIN_USER = process.env.FCM_ADMIN_USER || "admin";
const ADMIN_PASS = process.env.FCM_ADMIN_PASS || "fcm_f14cb226!A";
let token = "";
let pass = 0;
function ok(name, detail) { pass += 1; console.log("[PASS] " + name + (detail ? " :: " + detail : "")); }
function bad(name, detail) { console.log("[FAIL] " + name + " :: " + String(detail)); process.exitCode = 1; }
function assert(name, cond, detail) { if (cond) ok(name, detail); else bad(name, detail); }
async function call(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { ...options, headers });
  const text = await res.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

// 1) 未登录不可访问
const anon = await call("/admin/memory-cleanup");
assert("未登录被拒（401）", anon.status === 401, "status=" + anon.status);

// 2) 管理员登录
const login = await call("/auth/admin/login", { method: "POST", body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }) });
const access = login.body && (login.body.accessToken || login.body.token || (login.body.data && login.body.data.accessToken));
assert("管理员登录", !!access, "status=" + login.status);
if (!access) { console.log("ABORT: 无法登录管理端，请用 FCM_ADMIN_USER / FCM_ADMIN_PASS 覆盖"); process.exit(1); }
token = access;

// 3) 定时任务状态
const st = await call("/admin/memory-cleanup");
const s = st.body && (st.body.data || st.body);
assert("状态接口 200", st.status === 200, "status=" + st.status);
assert("定时任务已开启", !!(s && s.enabled === true), JSON.stringify({ enabled: s && s.enabled }));
assert("排程是每周日 03:00（Asia/Shanghai）", !!(s && typeof s.schedule === "string" && s.schedule.includes("03:00") && s.schedule.includes("Asia/Shanghai")), s && s.schedule);
assert("模式 apply / limit 60 / 阈值 20", !!(s && s.mode === "apply" && s.limit === 60 && s.minRows === 20), JSON.stringify({ mode: s && s.mode, limit: s && s.limit, minRows: s && s.minRows }));
const nextMs = s && s.nextAt ? new Date(s.nextAt).getTime() : NaN;
assert("下次执行在未来 7 天内", Number.isFinite(nextMs) && nextMs > Date.now() && nextMs - Date.now() <= 7 * 86400000, s && s.nextAt);

// 4) 手动跑一轮 report（只出报告、不改数据）
const report = await call("/admin/memory-cleanup/run", { method: "POST", body: JSON.stringify({ mode: "report" }) });
const rd = report.body && (report.body.data || report.body);
assert("手动 report 返回 200", report.status === 200, "status=" + report.status);
assert("report 有汇总字段", !!(rd && typeof rd.users === "number" && typeof rd.applied === "number" && typeof rd.proposals === "number" && typeof rd.durationMs === "number"), JSON.stringify(rd && { users: rd.users, applied: rd.applied, proposals: rd.proposals, durationMs: rd.durationMs }));
assert("report 模式不落库（applied=0）", !!(rd && rd.applied === 0), rd && rd.applied);
assert("report 无失败", !!(rd && rd.failed === 0), rd && rd.failed);
assert("reason 记录为管理员手动", !!(rd && rd.reason === "管理员手动"), rd && rd.reason);

// 5) 手动跑一轮 apply（真实执行，当前生产记忆少时应为 0 用户）
const applyRes = await call("/admin/memory-cleanup/run", { method: "POST", body: JSON.stringify({}) });
const ad = applyRes.body && (applyRes.body.data || applyRes.body);
assert("手动 apply 返回 200", applyRes.status === 200, "status=" + applyRes.status);
assert("apply 无失败", !!(ad && ad.failed === 0), ad && ad.failed);
assert("apply 统计到用户数", !!(ad && typeof ad.users === "number"), ad && ad.users);

// 6) 跑过之后 status 里有上次执行
const st2 = await call("/admin/memory-cleanup");
const s2 = st2.body && (st2.body.data || st2.body);
assert("status.lastRun 已记录", !!(s2 && s2.lastRun && s2.lastRun.at), JSON.stringify(s2 && s2.lastRun));

console.log("");
if (process.exitCode) { console.log("P22 PROD VERIFY FAILED"); }
else { console.log("P22 PROD VERIFY GREEN (" + pass + " checks)"); }
