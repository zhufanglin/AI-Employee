// P46 冒烟：云端执行器并发池（默认 2、上限 4）+ 同用户串行
//  - 静态断言：读源码检查并发配置、inFlightByUser、并发池、excludeUserIds、日志与空闲判定
//  - 单元式断言：校验并发度归一化与同用户串行的调度顺序（与执行器同一套规则）
//  - HTTP 断言（可选）：配置 FCM_SMOKE_API / FCM_SMOKE_TOKEN 时，验证带 excludeUserIds 的 pull 返回 200
// 零第三方依赖；结束只设置 process.exitCode，不调用 process.exit。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let checks = 0;
const ok = (name, cond, detail = "") => {
  checks += 1;
  assert.ok(cond, name + (detail ? "：" + detail : ""));
  console.log("  [ok] " + name);
};
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

try {
// ---- 1. 执行器静态结构 ----
const worker = read("../packages/worker/cloud-executor.mjs");
ok("执行器读取 FCM_WORKER_CONCURRENCY", /FCM_WORKER_CONCURRENCY/.test(worker));
ok("并发度归一化：默认 2、区间 1~4", /function normalizeConcurrency/.test(worker) && /return fallback/.test(worker) && /Math\.min\(4, Math\.max\(1/.test(worker));
ok("维护 inFlightByUser（同一用户串行）",
  /const inFlightByUser = new Map\(\)/.test(worker) && /inFlightByUser\.set\(userId, promise\)/.test(worker) && /inFlightByUser\.delete\(userId\)/.test(worker));
ok("并发池按 running 计数", /while \(running < CONCURRENCY\)/.test(worker) && /running \+= 1/.test(worker) && /running -= 1/.test(worker));
ok("只有空闲槽位才 pull", /const free = CONCURRENCY - running/.test(worker) && /const limit = Math\.min\(free, CLAIM_LIMIT_MAX\)/.test(worker));
ok("pull 请求带 limit 与 excludeUserIds", /body: JSON\.stringify\(\{ limit, excludeUserIds \}\)/.test(worker));
ok("领到任务打 claim 日志（含 running）", /log\("claim", \{ taskId, employee, userId, running \}\)/.test(worker));
ok("同用户任务就地等待、不丢弃", /const previous = SERIALIZE_PER_USER && userId \? inFlightByUser\.get\(userId\) : undefined/.test(worker) && /await previous/.test(worker) && /SERIALIZE_PER_USER = USER_CONCURRENCY <= 1/.test(worker));
// 心跳必须在「等同一用户空闲」之前就启动，否则排队中的任务会被服务端判失联并重新排队
const taskSection = worker.slice(worker.indexOf("function startTask"), worker.indexOf("async function pump"));
ok("领取后立即起 claimToken 心跳（覆盖排队等待）",
  /setInterval\(/.test(taskSection) && /await previous/.test(taskSection) && taskSection.indexOf("setInterval(") < taskSection.indexOf("await previous"));
ok("空闲判定改为在跑任务数", /if \(!\(running > 0\) && Date\.now\(\) - lastIdleLog >= IDLE_LOG_MS\)/.test(worker));
ok("保留 IDLE_LOG_MS 逻辑", /const IDLE_LOG_MS = Number\(process\.env\.FCM_IDLE_LOG_MS/.test(worker));
ok("旧的 busy 单任务标记已移除", !/\bbusy\s*=/.test(worker) && !/if \(busy\)/.test(worker));
ok("不再硬编码单条领取", !/pull\?limit=1/.test(worker));

// ---- 2. 服务端接口静态结构 ----
const service = read("../packages/server/src/employee/employee-execution.service.ts");
ok("claimCloudTasks 接收 excludeUserIds", /async claimCloudTasks\(userId: string, limitRaw\?: string \| number, excludeUserIdsRaw\?: unknown\)/.test(service));
ok("服务端按 excludeUserIds 过滤候选任务", /excludedUserIds\.length \? \{ notIn: excludedUserIds \} : userId/.test(service));
ok("单次认领上限提到 4", /CLAIM_LIMIT_MAX = 4/.test(service));
const controller = read("../packages/server/src/employee/employee-execution.controller.ts");
ok("pull 控制器透传 body 中的 excludeUserIds", /@Post\("pull"\)/.test(controller) && /body\.excludeUserIds/.test(controller));

// ---- 3. 单元式断言：并发度归一化 + 同用户串行调度顺序 ----
// 与执行器 normalizeConcurrency 保持同一规则（默认 2、上限 4、下限 1）
const normalize = (raw) => {
  if (raw === undefined || raw === null || String(raw).trim() === "") return 2;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 2;
  return Math.min(4, Math.max(1, Math.floor(n)));
};
assert.equal(normalize(undefined), 2, "缺省并发应为 2");
assert.equal(normalize(""), 2, "空串并发应回落 2");
assert.equal(normalize("abc"), 2, "非法并发应回落 2");
assert.equal(normalize("1"), 1, "FCM_WORKER_CONCURRENCY=1 应回到单条串行");
assert.equal(normalize("2"), 2);
assert.equal(normalize("9"), 4, "并发上限应为 4");
assert.equal(normalize("0"), 1, "并发下限应为 1");
checks += 1;
console.log("  [ok] 并发度归一化：缺省 2 / 上限 4 / 调回 1");

// 模拟执行器调度：池 2、任务 t1(u1) t2(u2) t3(u1) t4(u3)，期望同用户 t1、t3 串行且不漏跑
const events = [];
const inFlightByUser = new Map();
let running = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const taskUser = { t1: "u1", t2: "u2", t3: "u1", t4: "u3" };
const startTask = (id) => {
  const uid = taskUser[id];
  const previous = inFlightByUser.get(uid);
  running += 1;
  events.push("start:" + id);
  const promise = (async () => {
    if (previous) { events.push("wait:" + id); await previous; }
    events.push("run:" + id);
    await sleep(5);
    events.push("end:" + id);
  })();
  inFlightByUser.set(uid, promise);
  promise.finally(() => {
    running -= 1;
    if (inFlightByUser.get(uid) === promise) inFlightByUser.delete(uid);
  });
  return promise;
};
// 池 2：先领 t1、t2；它们结束后再领 t3、t4（t3 因 u1 已空闲直接跑）
await Promise.all([startTask("t1"), startTask("t2")]);
await sleep(20);
assert.equal(running, 0, "前两条任务跑完后槽位应全部释放");
await Promise.all([startTask("t3"), startTask("t4")]);
await sleep(20);
assert.equal(running, 0);
assert.ok(!events.includes("wait:t3"), "同用户上一条已结束时不应再等待");
// 再造一次重叠：u1 连续两条同批进来，后一条必须等待
events.length = 0;
const p1 = startTask("t1");
const p3 = startTask("t3");
await Promise.all([p1, p3]);
assert.ok(events.indexOf("wait:t3") > events.indexOf("start:t1") && events.indexOf("wait:t3") < events.indexOf("run:t3"), "同用户后一条应等待前一条结束再开跑");
assert.ok(!events.includes("end:t3") || events.indexOf("end:t1") < events.indexOf("run:t3"), "同用户任务不得重叠执行");
checks += 1;
console.log("  [ok] 同用户任务串行排队、任务不丢弃");

// ---- 4. HTTP 断言（可选，需显式配置，避免误领真实任务）----
const api = (process.env.FCM_SMOKE_API || "").replace(/\/$/, "");
const token = process.env.FCM_SMOKE_TOKEN || "";
if (!api || !token) {
  console.log("  [skip] 未设置 FCM_SMOKE_API / FCM_SMOKE_TOKEN，跳过 pull 接口 HTTP 断言");
} else {
  const req = async (path, init = {}) => {
    const res = await fetch(api + path, {
      ...init,
      headers: { "content-type": "application/json", authorization: "Bearer " + token, ...(init.headers || {}) },
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
  };
  const me = await req("/auth/me");
  const uid = (me.body && (me.body.id || (me.body.user && me.body.user.id))) || "";
  ok("HTTP: /auth/me 可用", me.status === 200 && !!uid, "status=" + me.status);
  // 排除自己：同一账号（唯一的任务归属）必然领不到任务，且不会把任何 queued 任务改成 running
  const excluded = await req("/employee-execution/pull?limit=1", { method: "POST", body: JSON.stringify({ limit: 1, excludeUserIds: [uid] }) });
  ok("HTTP: 带 excludeUserIds 的 pull 返回 200", excluded.status === 200, "status=" + excluded.status + " body=" + JSON.stringify(excluded.body).slice(0, 160));
  ok("HTTP: 排除在跑用户后返回空列表", Array.isArray(excluded.body && excluded.body.items) && excluded.body.items.length === 0);
  ok("HTTP: 返回 count 字段", typeof (excluded.body && excluded.body.count) === "number");
  ok("HTTP: limit 解析为数字且不会领到别人的任务", !(excluded.body && excluded.body.items && excluded.body.items.some((item) => item && item.userId && item.userId !== uid)));
  if (process.env.FCM_SMOKE_ALLOW_CLAIM === "1") {
    // 仅在显式允许时才走「不排除任何人」的领取路径，可能把真实 queued 任务置为 running
    const normal = await req("/employee-execution/pull?limit=1", { method: "POST", body: JSON.stringify({ limit: 1, excludeUserIds: [] }) });
    ok("HTTP: 不带排除的 pull 仍返回 200", normal.status === 200 && Array.isArray(normal.body && normal.body.items), "status=" + normal.status);
  } else {
    console.log("  [skip] 未设置 FCM_SMOKE_ALLOW_CLAIM=1，跳过会真实领取任务的 pull 调用");
  }
}

console.log("\nP46 RESULT: ALL PASS (" + checks + " checks)");
} catch (error) {
  console.error("\nP46 RESULT: FAILED — " + String((error && error.message) || error));
  process.exitCode = 1;
}
