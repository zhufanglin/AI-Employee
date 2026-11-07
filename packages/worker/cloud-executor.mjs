#!/usr/bin/env node
/**
 * 云端员工执行器（staging/测试机用）
 *  - 每 30s 向服务端上报执行节点心跳
 *  - 每 8s 拉取 executor=cloud 的 queued 任务，调模型产出后回写 awaiting_approval
 *  - 依赖：无第三方包（Node 18+ 内置 fetch）
 * 环境变量：FCM_API / FCM_PHONE / FCM_DEVICE_ID / FCM_POLL_MS / FCM_MODEL
 */
import { runToolLoop } from './tool-loop.mjs';
const API = (process.env.FCM_API || "http://127.0.0.1:3100/api").replace(/\/$/, "");
const PHONE = process.env.FCM_PHONE || "";
const DEVICE_ID = process.env.FCM_DEVICE_ID || "cloud-staging-1";
const POLL_MS = Number(process.env.FCM_POLL_MS || 8000);
const REQ_TIMEOUT_MS = Number(process.env.FCM_REQ_TIMEOUT_MS || 180000);
const HEARTBEAT_MS = 30000;
const MAX_OUTPUT = 200000;

let token = process.env.FCM_TOKEN || "";
let employees = new Map();
let employeesAt = 0;
let busy = false;

const log = (...a) => console.log(new Date().toISOString(), "[worker]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, init = {}, retry = true) {
  const headers = { "content-type": "application/json", ...(init.headers || {}) };
  if (token) headers.authorization = "Bearer " + token;
  const requestTimeout = AbortSignal.timeout(REQ_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, requestTimeout]) : requestTimeout;
  const res = await fetch(API + path, { ...init, headers, signal });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (res.status === 401 && retry && PHONE) {
    await login();
    return call(path, init, false);
  }
  if (!res.ok) throw new Error((body && (body.error?.message || body.message)) || "HTTP " + res.status);
  return body;
}

async function login() {
  if (!PHONE) throw new Error("FCM_PHONE 未配置，无法自动登录");
  const send = await call("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone: PHONE }) }, false);
  const code = send && send.devCode;
  if (!code) throw new Error("服务端未返回 devCode（短信未处于开发模式）");
  const r = await call("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone: PHONE, code }) }, false);
  token = r.accessToken;
  log("logged in as", r.user && r.user.phone);
}

async function loadEmployees() {
  if (Date.now() - employeesAt < 60000 && employees.size) return;
  const r = await call("/employees/mine");
  employees = new Map((r.items || []).map((e) => [e.id, e]));
  employeesAt = Date.now();
}

function asList(v) { return Array.isArray(v) ? v : []; }
function str(v, d = "") { return typeof v === "string" && v.trim() ? v.trim() : d; }

function buildMessages(task, emp) {
  const lines = [
    "你是「" + str(emp?.name, "AI 员工") + "」，一个可交付结果的 AI 员工。",
    str(emp?.title) ? "岗位：" + str(emp.title) : "",
    str(emp?.mission) ? "使命：" + str(emp.mission) : "",
    str(emp?.coreDirective) ? "核心指令：" + str(emp.coreDirective) : "",
    str(emp?.description) ? "职责说明：" + str(emp.description) : "",
    asList(emp?.capabilities).length ? "能力：" + asList(emp.capabilities).join("；") : "",
    asList(emp?.kpi).length ? "考核指标：" + asList(emp.kpi).join("；") : "",
    "最终交付应是可验收的成品（结构化中文、必要的清单/表格/步骤），通过 finish 工具返回。",
  ].filter(Boolean);
  const input = task.input;
  const inputText = typeof input === "string"
    ? input
    : input && typeof input === "object"
      ? str(input.text) || str(input.prompt) || JSON.stringify(input, null, 2)
      : "";
  return [
    { role: "system", content: lines.join("\n") },
    { role: "user", content: "任务标题：" + str(task.title, "一次性任务") + (inputText ? "\n\n任务输入：\n" + inputText : "") },
  ];
}

async function pickModel(emp) {
  let cfg = emp?.agentConfig;
  if (typeof cfg === "string") { try { cfg = JSON.parse(cfg); } catch { cfg = null; } }
  if (cfg && typeof cfg.model === "string" && cfg.model.trim()) return cfg.model.trim();
  if (process.env.FCM_MODEL) return process.env.FCM_MODEL;
  const r = await call("/compute/models");
  const arr = Array.isArray(r) ? r : (r && r.data) || [];
  return arr[0] && arr[0].id;
}

async function execute(task, signal) {
  await loadEmployees();
  const emp = employees.get(task.employeeId);
  if (!emp) throw new Error("员工未安装或不在我的员工列表中，无法执行");
  log("picked model", emp && emp.slug);
  const model = await pickModel(emp);
  const skill = (task && typeof task.employeeSkillMd === "string" && task.employeeSkillMd) || (emp && typeof emp.skillMd === "string" && emp.skillMd) || "";
  log("model =", model, "skillChars =", skill ? skill.length : 0);
  const out = await runToolLoop({
    api: call, model, messages: buildMessages(task, emp), skill, signal,
    maxSteps: Number(process.env.FCM_EXECUTOR_MAX_STEPS || 8),
    timeoutMs: Number(process.env.FCM_EXECUTOR_TASK_TIMEOUT_MS || 900000),
  });
  return out;
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const pulled = await call("/employee-execution/pull?limit=1", { method: "POST", body: "{}" });
    const task = pulled && pulled.items && pulled.items[0];
    if (!task) return;
    log("claimed", task.id, task.title);
    const claimToken = task.outputMeta?.claimToken;
    if (!claimToken) throw new Error("任务缺少领取凭据");
    const abort = new AbortController();
    const taskHeartbeat = setInterval(() => {
      call('/employee-execution/tasks/' + encodeURIComponent(task.id) + '/heartbeat', { method: 'POST', body: JSON.stringify({ claimToken }) })
        .catch(e => { if (/领取已失效/.test(String(e?.message || e))) abort.abort(); });
    }, 30000);
    try {
      const out = await execute(task, abort.signal);
      await call("/employee-tasks/" + encodeURIComponent(task.id), {
        method: "PATCH",
        body: JSON.stringify({
          status: "awaiting_approval",
          claimToken,
          outputKind: "text",
          outputText: out.content.slice(0, MAX_OUTPUT),
          outputMeta: { ...(task.outputMeta || {}), executor: "cloud", node: DEVICE_ID, model: out.model, usage: out.usages, steps: out.steps, media: out.media, finishedAt: new Date().toISOString() },
          artifacts: [{ kind: "text", text: out.content.slice(0, 20000), mime: "text/plain" }, ...(out.files || []).map(f => ({ kind: 'workspace-file', path: f.key, text: f.name, mime: 'application/octet-stream' })), ...out.media.filter(m => m.url).map(m => ({ kind: m.kind, path: m.url, mime: m.kind === 'image' ? 'image/*' : 'video/*' }))],
        }),
      });
      log("done", task.id);
    } catch (e) {
      const message = String((e && e.message) || e).slice(0, 500);
      log("failed", task.id, message);
      try {
        await call("/employee-tasks/" + encodeURIComponent(task.id), {
          method: "PATCH",
          body: JSON.stringify({ status: "failed", claimToken, error: message, outputMeta: { ...(task.outputMeta || {}), executor: "cloud", node: DEVICE_ID, ...(e?.partial || {}) }, artifacts: (e?.partial?.media || []).filter(m => m.url).map(m => ({ kind: m.kind, path: m.url, mime: m.kind === 'image' ? 'image/*' : 'video/*' })) }),
        });
      } catch (e2) { log("report-failed", String((e2 && e2.message) || e2)); }
    } finally { clearInterval(taskHeartbeat); }
  } catch (e) {
    log("poll error", String((e && e.message) || e));
  } finally {
    busy = false;
  }
}

async function heartbeat() {
  try {
    await call("/employee-execution/heartbeat", {
      method: "POST",
      body: JSON.stringify({ deviceId: DEVICE_ID, executor: "cloud", metadata: { host: process.env.HOSTNAME || "staging", runtime: process.version } }),
    });
  } catch (e) { log("heartbeat failed", String((e && e.message) || e)); }
}

(async () => {
  log("starting", { api: API, device: DEVICE_ID });
  for (let i = 0; i < 30; i++) {
    try { if (!token && PHONE) await login(); await heartbeat(); break; }
    catch (e) { log("init retry", String((e && e.message) || e)); await sleep(5000); }
  }
  setInterval(heartbeat, HEARTBEAT_MS);
  for (;;) { await tick(); await sleep(POLL_MS); }
})();
