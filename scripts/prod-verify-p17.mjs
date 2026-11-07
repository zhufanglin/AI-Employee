#!/usr/bin/env node
/** 生产验收 P17：image_understand / employee_dispatch + employee_task_status / cron_create+list+delete。 */
const BASE = process.env.FCM_API_BASE || "http://127.0.0.1:3000/api";
const PHONE = process.env.FCM_PHONE || "13900000002";
const SLUG = process.env.FCM_SLUG || "boss-lead-radar";
let token = "";
let pass = 0;
function ok(name, detail) { pass += 1; console.log("[PASS] " + name + (detail ? " :: " + detail : "")); }
function bad(name, detail) { console.log("[FAIL] " + name + " :: " + detail); process.exitCode = 1; }
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

async function login() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sent = await call("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone: PHONE }) });
    const code = sent.body && (sent.body.devCode || (sent.body.data && sent.body.data.devCode));
    if (code) {
      const res = await call("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone: PHONE, code }) });
      const access = res.body && (res.body.accessToken || res.body.token || (res.body.data && res.body.data.accessToken));
      if (access) { token = access; return; }
    }
    console.log("等待短信频控窗口 62s 后重试…");
    await new Promise((r) => setTimeout(r, 62000));
  }
  throw new Error("登录失败");
}

async function run(name, params) {
  const res = await call("/capabilities/run", { method: "POST", body: JSON.stringify({ name, params }) });
  return { status: res.status, data: res.body && res.body.data, body: res.body };
}

await login();
console.log("登录成功，开始 P17 生产验收");

// 1) image_understand：ffmpeg 生成纯红图 → 上传 → 让模型看图
const { execFileSync } = await import("node:child_process");
const fs = await import("node:fs");
const png = "/tmp/p17-red.png";
execFileSync("/usr/bin/ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=red:s=320x200:d=1", "-frames:v", "1", png], { stdio: "ignore" });
const b64 = fs.readFileSync(png).toString("base64");
const IMG = "P17验收-红图.png";
const up = await call("/workspace/upload", { method: "POST", body: JSON.stringify({ name: IMG, base64: b64 }) });
assert("图片上传成功", up.status === 200 || up.status === 201, "status=" + up.status + " bytes=" + (up.body && up.body.bytes));

const vis = await run("image_understand", { source: IMG, question: "这张图主要是什么颜色？用两个字回答。" });
const visText = vis.data && (vis.data.text || vis.data.answer || vis.data.content) || "";
assert("image_understand 调用成功", vis.status === 200 || vis.status === 201, "status=" + vis.status + " " + JSON.stringify(vis.body).slice(0, 200));
assert("看图返回非空文本", visText.length > 0, visText.slice(0, 80));
assert("模型识别出红色", /红|red/i.test(visText), visText.slice(0, 80));
assert("返回模型别名与用量", !!vis.data && !!vis.data.model && !!vis.data.usage, "model=" + (vis.data && vis.data.model));

// 2) employee_dispatch + employee_task_status
const disp = await run("employee_dispatch", { employeeSlug: SLUG, input: "只用一句话介绍你自己，不要调用任何工具。", title: "P17验收-派活" });
const taskId = disp.data && (disp.data.taskId || disp.data.id || (disp.data.task && disp.data.task.id));
assert("employee_dispatch 创建任务", (disp.status === 200 || disp.status === 201) && !!taskId, "status=" + disp.status + " id=" + taskId + " " + JSON.stringify(disp.body).slice(0, 200));
if (taskId) {
  const st = await run("employee_task_status", { taskId });
  assert("employee_task_status 可查", (st.status === 200 || st.status === 201) && !!st.data, "status=" + st.status);
  assert("任务状态字段存在", !!st.data && typeof st.data.status === "string", st.data && st.data.status);
  assert("任务归属当前用户", !!st.data && (st.data.employeeSlug === SLUG || st.data.employee === SLUG || !!st.data.title), JSON.stringify(st.data).slice(0, 160));
}
const dispBad = await run("employee_dispatch", { employeeSlug: "no-such-employee-xyz", input: "测试" });
assert("派活到不存在的员工被拒", !!(dispBad.body && dispBad.body.success === false) && /员工不存在|已下架|未安装/.test(String(dispBad.body.error)), "error=" + (dispBad.body && dispBad.body.error));

// 3) cron_create / cron_list / cron_delete
const cr = await run("cron_create", { employeeSlug: SLUG, cronExpr: "0 9 * * *", title: "P17验收-定时" });
const cronId = cr.data && (cr.data.id || cr.data.cronId);
assert("cron_create 成功", (cr.status === 200 || cr.status === 201) && !!cronId, "status=" + cr.status + " id=" + cronId + " " + JSON.stringify(cr.body).slice(0, 200));
assert("定时器算出 nextRunAt", !!cr.data && !!cr.data.nextRunAt, cr.data && cr.data.nextRunAt);
const list = await run("cron_list", {});
const items = (list.data && (list.data.items || list.data.list)) || [];
const sameCron = (i) => (i.cronId || i.id) === cronId;
assert("cron_list 含新建定时器", Array.isArray(items) && items.some(sameCron), "total=" + items.length);
const delWrong = await run("cron_delete", { id: cronId });
assert("cron_delete 只认 cronId 参数", !!(delWrong.body && delWrong.body.success === false) && /cronId/.test(String(delWrong.body.error)), "error=" + (delWrong.body && delWrong.body.error));
const del = await run("cron_delete", { cronId });
assert("cron_delete 成功", !!(del.body && del.body.success === true) && !!(del.data && del.data.cronId === cronId), "status=" + del.status + " " + JSON.stringify(del.body).slice(0, 160));
const list2 = await run("cron_list", {});
const items2 = (list2.data && (list2.data.items || list2.data.list)) || [];
assert("删除后列表不再包含", Array.isArray(items2) && !items2.some(sameCron), "total=" + items2.length);
const crBad = await run("cron_create", { employeeSlug: SLUG, cronExpr: "not-a-cron" });
assert("非法 cron 表达式被拒", !!(crBad.body && crBad.body.success === false) && /cron/.test(String(crBad.body.error)), "error=" + (crBad.body && crBad.body.error));

// 4) 清理验收图片
const rm = await run("file_delete", { name: IMG });
assert("验收图片已清理", (rm.status === 200 || rm.status === 201), "status=" + rm.status);

console.log((process.exitCode ? "P17 PROD VERIFY FAILED" : "P17 PROD VERIFY GREEN") + " (" + pass + " checks)");
