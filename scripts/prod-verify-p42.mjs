#!/usr/bin/env node
/** P42 生产验收：人设写入 → 员工任务带上战略/人设（看 worker 日志 strategyChars/personaChars）→ 清理人设 */
const BASE = process.env.FCM_API_BASE || "https://api.fcmediaagent.com/api";
const PHONE = process.env.FCM_PHONE || "13900000002";
const SLUG = process.env.FCM_SLUG || "boss-daily-lead-topics";
let token = "";
let pass = 0;
function ok(n, d) { pass++; console.log("[PASS] " + n + (d ? " :: " + d : "")); }
function bad(n, d) { console.log("[FAIL] " + n + " :: " + d); process.exitCode = 1; }
function check(n, c, d) { c ? ok(n, d) : bad(n, d); }
async function call(p, o = {}) {
  const h = { "content-type": "application/json", ...(o.headers || {}) };
  if (token) h.authorization = "Bearer " + token;
  const r = await fetch(BASE + p, { ...o, headers: h });
  const t = await r.text();
  let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; }
  return { status: r.status, body: b };
}
async function login() {
  for (let i = 0; i < 3; i++) {
    const s = await call("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone: PHONE }) });
    const code = s.body && (s.body.devCode || (s.body.data && s.body.data.devCode));
    if (code) {
      const r = await call("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone: PHONE, code }) });
      const a = r.body && (r.body.accessToken || r.body.token || (r.body.data && r.body.data.accessToken));
      if (a) { token = a; return true; }
    }
    console.log("等待短信频控 62s…");
    await new Promise((x) => setTimeout(x, 62000));
  }
  return false;
}
if (!(await login())) { bad("登录", "失败"); process.exit(1); }
ok("登录成功");
const PNAME = "P42验收人设-可忽略";
const ps = await call("/personas", { method: "POST", body: JSON.stringify({ name: PNAME, positioning: "工业除尘设备顾问", plan: "专业、讲数据、不说空话" }) });
check("人设写入", ps.status === 200 || ps.status === 201, "status=" + ps.status);
const pl = await call("/personas");
const items = (pl.body && (pl.body.items || (pl.body.data && pl.body.data.items))) || [];
const mine = items.find((x) => x.name === PNAME);
check("人设可查", !!mine, "count=" + items.length);

const runRes = await call("/employees/" + SLUG + "/run", { method: "POST", body: JSON.stringify({ input: "用两句话回答：你这次拿到的公司战略与本账号人设分别是什么？把读到的板块标题念出来。不要调用任何工具，直接回答。", executor: "cloud", title: "P42 验收" }) });
const taskId = runRes.body && (runRes.body.id || (runRes.body.task && runRes.body.task.id) || (runRes.body.data && runRes.body.data.id));
check("任务已创建", !!taskId, "status=" + runRes.status + " id=" + taskId + " " + JSON.stringify(runRes.body).slice(0, 160));

let task = null;
const deadline = Date.now() + 8 * 60 * 1000;
while (Date.now() < deadline) {
  await new Promise((x) => setTimeout(x, 6000));
  const got = await call("/employee-tasks/" + taskId);
  task = got.body && (got.body.task || got.body.data || got.body);
  const st = task && task.status;
  if (["succeeded", "failed", "awaiting_approval", "needs_input"].includes(st)) break;
}
check("任务到达终态", !!task && ["succeeded", "awaiting_approval"].includes(task.status), "status=" + (task && task.status) + " err=" + (task && task.error));
const out = (task && (task.outputText || (task.outputMeta && task.outputMeta.text))) || "";
check("有产出文本", out.length > 40, "chars=" + out.length);
console.log("--- 产出前 400 字 ---\n" + out.slice(0, 400));
const meta = (task && task.outputMeta) || {};
console.log("--- outputMeta ---\n" + JSON.stringify({ model: meta.model, steps: meta.steps }).slice(0, 600));

if (mine && mine.id) {
  const del = await call("/personas/" + mine.id, { method: "DELETE" });
  check("人设清理", del.status === 200, "status=" + del.status);
}
console.log("\nP42 PROD RESULT: " + (process.exitCode ? "FAILED" : "ALL PASS") + " (" + pass + " checks) TASK=" + taskId);
