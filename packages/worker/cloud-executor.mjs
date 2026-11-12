#!/usr/bin/env node
/**
 * 云端员工执行器（staging/测试机用）
 *  - 每 30s 向服务端上报执行节点心跳
 *  - 每 8s 拉取 executor=cloud 的 queued 任务，调模型产出后回写 awaiting_approval
 *  - 依赖：无第三方包（Node 18+ 内置 fetch）
 * 环境变量：FCM_API / FCM_PHONE / FCM_DEVICE_ID / FCM_POLL_MS / FCM_MODEL
 *          / FCM_WORKER_CONCURRENCY（并发池大小，默认 2，上限 4）
 * 并发模型：
 *  - 池内最多同时跑 FCM_WORKER_CONCURRENCY 条任务，只有空闲槽位才去 pull；
 *  - 同用户并发由 FCM_WORKER_USER_CONCURRENCY 控制：默认等于并发池大小（即同账号也允许并行，
 *    因为单账号是常态，串行会让并发池形同虚设）；设为 1 时恢复「同账号串行」：
 *    申领时把已在跑的用户放进 excludeUserIds 交给服务端过滤；万一服务端仍返回该用户的任务，
 *    就地等该用户空闲再开跑（不丢弃、不 release、claimToken 心跳照常）。
 *  - 默认并发 2；FCM_WORKER_CONCURRENCY=1 时行为与单循环版本一致。
 */
import { runToolLoop } from './tool-loop.mjs';
const API = (process.env.FCM_API || "http://127.0.0.1:3100/api").replace(/\/$/, "");
const PHONE = process.env.FCM_PHONE || "";
const DEVICE_ID = process.env.FCM_DEVICE_ID || "cloud-staging-1";
const POLL_MS = Number(process.env.FCM_POLL_MS || 8000);
const REQ_TIMEOUT_MS = Number(process.env.FCM_REQ_TIMEOUT_MS || 180000);
// 单个工具调用（llm_text 写长文、doc_write 出表格、web_batch 抓 5 个站）常常超过 3 分钟，单独给更长预算；
// 拉任务/心跳仍用 REQ_TIMEOUT_MS，避免长超时把轮询卡住。
const TOOL_TIMEOUT_MS = Number(process.env.FCM_TOOL_TIMEOUT_MS || 600000);
const HEARTBEAT_MS = 30000;
// 空闲心跳日志：worker 只在有任务时才有日志输出，运维监控无法区分「空闲」与「卡死」。
// 每 N 毫秒（默认 30 分钟）在空闲时打一行 idle 日志，作为进程存活的心跳证据。
const IDLE_LOG_MS = Number(process.env.FCM_IDLE_LOG_MS || 1800000);
let lastIdleLog = 0;
const MAX_OUTPUT = 200000;
// 并发池大小：默认 2，非法值回落默认，上限 4（服务端单次认领上限同为 4）
const CONCURRENCY = normalizeConcurrency(process.env.FCM_WORKER_CONCURRENCY);
// 一次 pull 最多申领的条数，与服务端 claimCloudTasks 的上限保持一致
const CLAIM_LIMIT_MAX = 4;
// 同用户并发：默认不限制（跟随并发池），设为 1 则同账号严格串行。
// 单账号是最常见场景，若同账号严格串行，并发池就永远只用一个槽位，加速无从谈起。
const USER_CONCURRENCY = normalizeConcurrency(process.env.FCM_WORKER_USER_CONCURRENCY, CONCURRENCY);
const SERIALIZE_PER_USER = USER_CONCURRENCY <= 1;

let token = process.env.FCM_TOKEN || "";
let employees = new Map();
let employeesAt = 0;
// 在跑任务数（含「已领到、正在等同一用户空闲」的任务）；running > 0 即视为忙
let running = 0;
// userId -> 该用户当前任务的 Promise：同一用户同时只跑 1 条
const inFlightByUser = new Map();

const log = (...a) => console.log(new Date().toISOString(), "[worker]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 解析并发度：默认 2，只接受 1~4 的整数，其余回落默认值 */
function normalizeConcurrency(raw, fallback = 2) {
  // 未配置（undefined/null/空串）走默认 2；配了数字就夹到 1~4，0 表示退回串行
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(4, Math.max(1, Math.floor(n)));
}

/** 任务所属用户：优先 outputMeta.ownerUserId（多租户下发时带），否则用任务的 userId */
function taskUserKey(task) {
  const meta = task && task.outputMeta;
  const fromMeta = meta && typeof meta.ownerUserId === "string" ? meta.ownerUserId.trim() : "";
  const own = task && typeof task.ownerUserId === "string" ? task.ownerUserId.trim() : "";
  const uid = task && typeof task.userId === "string" ? task.userId.trim() : "";
  return fromMeta || own || uid;
}

async function call(path, init = {}, retry = true, timeoutMs = REQ_TIMEOUT_MS) {
  const headers = { "content-type": "application/json", ...(init.headers || {}) };
  if (token) headers.authorization = "Bearer " + token;
  const requestTimeout = AbortSignal.timeout(timeoutMs);
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

/** 工具/模型调用专用：超时预算更长，且把底层英文 abort 错误翻成中文。 */
async function toolCall(path, init = {}) {
  try {
    return await call(path, init, true, TOOL_TIMEOUT_MS);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/aborted|timeout|TimeoutError/i.test(msg)) throw new Error("调用超时（" + Math.round(TOOL_TIMEOUT_MS / 1000) + " 秒）：" + path + "，请缩小单次产出或分批重试");
    throw e;
  }
}

async function execute(task, signal) {
  await loadEmployees();
  let emp = employees.get(task.employeeId);
  // 刚安装的员工可能还没进 60s 缓存：强制刷新一次再判失败（否则「刚装上就派活」必然报未安装）
  if (!emp) {
    employeesAt = 0;
    await loadEmployees();
    emp = employees.get(task.employeeId);
  }
  if (!emp) throw new Error("员工未安装或不在我的员工列表中，无法执行");
  log("picked model", emp && emp.slug);
  const model = await pickModel(emp);
  const skill = (task && typeof task.employeeSkillMd === "string" && task.employeeSkillMd) || (emp && typeof emp.skillMd === "string" && emp.skillMd) || "";
  // P42：战略/人设由服务端按岗位 needs 切片后随任务下发，这里只负责注入
  const strategy = (task && typeof task.strategyText === "string" && task.strategyText) || "";
  const persona = (task && typeof task.personaText === "string" && task.personaText) || "";
  const needs = Array.isArray(task && task.employeeNeeds) ? task.employeeNeeds : [];
  // P43：工作区 AGENTS.md / TOOLS.md 由服务端随任务下发
  const workspaceRules = (task && typeof task.workspaceRules === "string" && task.workspaceRules) || "";
  log("model =", model, "skillChars =", skill ? skill.length : 0, "strategyChars =", strategy.length, "personaChars =", persona.length, "needs =", needs.length, "rulesChars =", workspaceRules.length);
  const out = await runToolLoop({
    api: toolCall, model, messages: buildMessages(task, emp), skill, strategy, persona, needs, workspaceRules,
    strategyMeta: { version: task && task.strategyVersion, updatedAt: task && task.strategyUpdatedAt }, signal,
    maxSteps: Number(process.env.FCM_EXECUTOR_MAX_STEPS || 8),
    timeoutMs: Number(process.env.FCM_EXECUTOR_TASK_TIMEOUT_MS || 900000),
  });
  return out;
}

/**
 * 执行单条已认领的任务：调模型 + 回写。
 * 心跳由 startTask 在领取时启动，覆盖「等同一用户空闲」的排队阶段。
 */
async function runTask(task, claimToken, abort) {
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
  }
}

/**
 * 把一条已领到的任务放进并发池。
 * running 立即 +1（占住槽位），同用户串行靠 inFlightByUser：
 * 若该用户已有任务在跑，先等它结束再真正开跑，任务不丢弃、不 release。
 */
function startTask(task) {
  const taskId = String((task && task.id) || "");
  const claimToken = task && task.outputMeta && task.outputMeta.claimToken;
  if (!taskId || !claimToken) {
    log("claim error", taskId || "(无 id)", "任务缺少领取凭据");
    return false;
  }
  const userId = taskUserKey(task);
  const employee = String((task && task.employeeId) || "");
  const previous = SERIALIZE_PER_USER && userId ? inFlightByUser.get(userId) : undefined;
  running += 1;
  // 需求：每次领到任务打一行 [worker] claim { taskId, employee, running: n }
  log("claim", { taskId, employee, userId, running });
  // 一领到就起 claimToken 心跳：排队等同一用户时也不会被服务端判为失联而重新排队
  const abort = new AbortController();
  const taskHeartbeat = setInterval(() => {
    call('/employee-execution/tasks/' + encodeURIComponent(taskId) + '/heartbeat', { method: 'POST', body: JSON.stringify({ claimToken }) })
      .catch(e => { if (/领取已失效/.test(String(e?.message || e))) abort.abort(); });
  }, 30000);
  const promise = (async () => {
    if (previous) {
      log("wait-user", { taskId, userId, running });
      try { await previous; } catch { /* 前一条失败不影响本条 */ }
    }
    await runTask(task, claimToken, abort);
  })();
  if (userId) inFlightByUser.set(userId, promise);
  promise.catch(() => {}).finally(() => {
    clearInterval(taskHeartbeat);
    running -= 1;
    // 只有自己仍是该用户当前任务时才清理，避免把排队中的后续任务标记抹掉
    if (userId && inFlightByUser.get(userId) === promise) inFlightByUser.delete(userId);
  });
  return true;
}

/** 一轮调度：只在有空闲槽位时 pull；领满一轮就继续领，领不满就交给主循环 sleep。 */
async function pump() {
  while (running < CONCURRENCY) {
    const free = CONCURRENCY - running;
    const limit = Math.min(free, CLAIM_LIMIT_MAX);
    // 只有开启「同账号串行」时才需要服务端过滤掉已在跑的用户
    const excludeUserIds = SERIALIZE_PER_USER ? Array.from(inFlightByUser.keys()) : [];
    let pulled;
    try {
      pulled = await call("/employee-execution/pull?limit=" + limit, {
        method: "POST",
        body: JSON.stringify({ limit, excludeUserIds }),
      });
    } catch (e) {
      log("poll error", String((e && e.message) || e));
      return;
    }
    const items = Array.isArray(pulled && pulled.items) ? pulled.items : [];
    if (!items.length) return;
    let started = 0;
    for (const task of items) {
      if (running >= CONCURRENCY) break;
      if (startTask(task)) started += 1;
    }
    // 本轮没领满，或没有一条能进池（缺 claimToken 等异常），都交给下一轮轮询，避免空转
    if (started === 0 || items.length < free) return;
  }
}

async function heartbeat() {
  try {
    await call("/employee-execution/heartbeat", {
      method: "POST",
      body: JSON.stringify({ deviceId: DEVICE_ID, executor: "cloud", metadata: { host: process.env.HOSTNAME || "staging", runtime: process.version } }),
    });
    // 空闲判定改为「在跑任务数为 0」，并发池下有任意任务在跑都算 busy
    if (!(running > 0) && Date.now() - lastIdleLog >= IDLE_LOG_MS) {
      lastIdleLog = Date.now();
      log("idle", { device: DEVICE_ID, uptimeMin: Math.round(process.uptime() / 60), rssMB: Math.round(process.memoryUsage().rss / 1048576) });
    }
  } catch (e) { log("heartbeat failed", String((e && e.message) || e)); }
}

(async () => {
  log("starting", { api: API, device: DEVICE_ID, concurrency: CONCURRENCY, userConcurrency: SERIALIZE_PER_USER ? 1 : CONCURRENCY });
  for (let i = 0; i < 30; i++) {
    try { if (!token && PHONE) await login(); await heartbeat(); break; }
    catch (e) { log("init retry", String((e && e.message) || e)); await sleep(5000); }
  }
  setInterval(heartbeat, HEARTBEAT_MS);
  // 主循环只负责「有空槽就领」+ 轮询间隔；单条任务的耗时不再阻塞其他槽位
  for (;;) { await pump(); await sleep(POLL_MS); }
})();
