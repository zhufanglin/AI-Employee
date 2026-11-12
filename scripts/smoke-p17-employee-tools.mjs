#!/usr/bin/env node
/** P17 员工派活 + 定时任务能力单测：内存 prisma 桩，不连数据库。 */
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const tools = require("../packages/server/dist/capabilities/capabilities/employee-tools.js");

const USER = "u1";
let pass = 0;
let fail = 0;

function ok(name) { pass += 1; console.log("[PASS] " + name); }
function bad(name, detail) { fail += 1; console.log("[FAIL] " + name + " :: " + detail); }
async function check(name, fn) {
  try { const v = await fn(); ok(name); return v; }
  catch (e) { bad(name, e && e.message ? e.message : String(e)); return undefined; }
}
async function rejects(name, fn, needle) {
  try {
    await fn();
    bad(name, "未抛错");
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (needle && !msg.includes(needle)) bad(name, "错误文案不含「" + needle + "」，实际：" + msg);
    else ok(name);
  }
}

// ---------- 内存 prisma 桩 ----------
function timeVal(value) {
  if (value === null || value === undefined) return Number.POSITIVE_INFINITY;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function createStore() {
  const db = { employees: [], installs: [], purchases: [], tasks: [], artifacts: [], crons: [] };
  let seq = 0;
  const nid = (prefix) => prefix + "-" + (++seq);

  const matchesTask = (row, where) => {
    if (!where) return true;
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.status !== undefined) {
      if (where.status && typeof where.status === "object" && "in" in where.status) {
        if (!where.status.in.includes(row.status)) return false;
      } else if (row.status !== where.status) return false;
    }
    return true;
  };

  const prisma = {
    aiEmployee: {
      findUnique: async ({ where }) => {
        if (where && where.slug !== undefined) return db.employees.find((e) => e.slug === where.slug) ?? null;
        if (where && where.id !== undefined) return db.employees.find((e) => e.id === where.id) ?? null;
        return null;
      },
      findMany: async ({ where }) => {
        let rows = db.employees;
        if (where && where.id && Array.isArray(where.id.in)) rows = rows.filter((e) => where.id.in.includes(e.id));
        return rows.map((e) => ({ ...e }));
      },
    },
    aiEmployeeInstall: {
      findUnique: async ({ where }) => {
        const key = where.userId_employeeId;
        return db.installs.find((i) => i.userId === key.userId && i.employeeId === key.employeeId) ?? null;
      },
    },
    aiEmployeePurchase: {
      findUnique: async ({ where }) => {
        const key = where.userId_employeeId;
        return db.purchases.find((p) => p.userId === key.userId && p.employeeId === key.employeeId) ?? null;
      },
    },
    employeeTask: {
      count: async ({ where }) => db.tasks.filter((t) => matchesTask(t, where)).length,
      create: async ({ data }) => {
        const now = new Date();
        const row = { id: nid("task"), outputText: null, error: null, finishedAt: null, createdAt: now, updatedAt: now, ...data };
        db.tasks.push(row);
        return { ...row };
      },
      findUnique: async ({ where }) => db.tasks.find((t) => t.id === where.id) ?? null,
    },
    employeeTaskArtifact: {
      findMany: async ({ where }) =>
        db.artifacts
          .filter((a) => a.taskId === where.taskId)
          .sort((a, b) => timeVal(a.createdAt) - timeVal(b.createdAt))
          .map((a) => ({ ...a })),
    },
    employeeCron: {
      create: async ({ data }) => {
        const now = new Date();
        const row = { id: nid("cron"), enabled: true, lastRunAt: null, createdAt: now, updatedAt: now, ...data };
        db.crons.push(row);
        return { ...row };
      },
      findMany: async ({ where }) => {
        const rows = db.crons.filter((c) => !where || c.userId === where.userId).slice();
        rows.sort((a, b) => timeVal(a.nextRunAt) - timeVal(b.nextRunAt));
        return rows.map((c) => ({ ...c }));
      },
      findFirst: async ({ where }) =>
        db.crons.find((c) => c.id === where.id && (where.userId === undefined || c.userId === where.userId)) ?? null,
      deleteMany: async ({ where }) => {
        const before = db.crons.length;
        db.crons = db.crons.filter((c) => !(c.id === where.id && (where.userId === undefined || c.userId === where.userId)));
        return { count: before - db.crons.length };
      },
    },
  };
  return { prisma, db, nid };
}

function employee(overrides) {
  return { id: "e-free", slug: "free-bot", name: "免费员工", price: 0, isBundled: true, cliRequirement: "none", isActive: true, ...overrides };
}

function baseStore() {
  const s = createStore();
  s.db.employees.push(
    employee(),
    employee({ id: "e-desk", slug: "desk-bot", name: "桌面员工", cliRequirement: "required", isBundled: true }),
    employee({ id: "e-paid", slug: "paid-bot", name: "付费员工", price: 9900, isBundled: false }),
    employee({ id: "e-off", slug: "off-bot", name: "下架员工", isActive: false }),
  );
  s.db.installs.push(
    { userId: USER, employeeId: "e-free", enabled: true, expiresAt: null },
    { userId: USER, employeeId: "e-desk", enabled: true, expiresAt: null },
    { userId: USER, employeeId: "e-paid", enabled: true, expiresAt: null },
    { userId: "u-exp", employeeId: "e-free", enabled: true, expiresAt: new Date(Date.now() - 86400000) },
    { userId: "u-nopurchase", employeeId: "e-paid", enabled: true, expiresAt: null },
    { userId: "u-dead", employeeId: "e-free", enabled: false, expiresAt: null },
  );
  s.db.purchases.push({ userId: USER, employeeId: "e-paid", status: "active", expiresAt: null });
  return s;
}

function handlers(store) { return tools.buildEmployeeHandlers(store.prisma); }

async function dispatch(store, params, userId = USER) {
  return handlers(store).employee_dispatch({ userId, phone: null, params });
}

// ---------- 能力清单 ----------
await check("descriptors 恰好包含 7 个能力且命名正确", () => {
  const names = tools.descriptors.map((d) => d.name);
  // cron_update 只服务桌面端启停/改时间（P43），刻意不进 worker 白名单。
  assert.deepEqual(names, ["employee_dispatch", "team_run", "employee_task_status", "cron_create", "cron_list", "cron_update", "cron_delete"]);
  for (const d of tools.descriptors) {
    assert.equal(typeof d.title, "string");
    assert.equal(typeof d.category, "string");
    assert.equal(d.category, "employee");
  }
});

// ---------- employee_dispatch ----------
await rejects("派活：员工 slug 不存在被拒", async () => {
  await dispatch(baseStore(), { employeeSlug: "nope-bot", input: "写周报" });
}, "员工不存在或已下架");

await rejects("派活：员工已下架被拒", async () => {
  await dispatch(baseStore(), { employeeSlug: "off-bot", input: "写周报" });
}, "员工不存在或已下架");

await rejects("派活：未安装被拒", async () => {
  await dispatch(baseStore(), { employeeSlug: "free-bot", input: "写周报" }, "u-none");
}, "员工未安装或授权已过期");

await rejects("派活：安装已过期被拒", async () => {
  await dispatch(baseStore(), { employeeSlug: "free-bot", input: "写周报" }, "u-exp");
}, "员工未安装或授权已过期");

await rejects("派活：安装被禁用被拒", async () => {
  await dispatch(baseStore(), { employeeSlug: "free-bot", input: "写周报" }, "u-dead");
}, "员工未安装或授权已过期");

await rejects("派活：付费员工无有效购买记录被拒", async () => {
  await dispatch(baseStore(), { employeeSlug: "paid-bot", input: "写周报" }, "u-nopurchase");
}, "员工未安装或授权已过期");

await rejects("派活：input 为空被拒", async () => {
  await dispatch(baseStore(), { employeeSlug: "free-bot", input: "  " });
}, "input 必填");

await rejects("派活：employeeSlug 缺失被拒", async () => {
  await dispatch(baseStore(), { input: "写周报" });
}, "employeeSlug 必填");

await rejects("派活：parentEmployeeSlug 指向目标员工被拒（不能给自己派活）", async () => {
  await dispatch(baseStore(), { employeeSlug: "free-bot", input: "写周报", parentEmployeeSlug: "free-bot" });
}, "不能给自己派活");

await check("派活：免费员工正常创建 queued 任务，executor=cloud", async () => {
  const store = baseStore();
  const data = await dispatch(store, { employeeSlug: "free-bot", input: "整理今日行业新闻" });
  assert.equal(typeof data.taskId, "string");
  assert.equal(data.status, "queued");
  assert.equal(data.executor, "cloud");
  assert.deepEqual(data.employee, { slug: "free-bot", name: "免费员工" });
  const row = store.db.tasks.find((t) => t.id === data.taskId);
  assert.ok(row, "任务应写入库");
  assert.equal(row.status, "queued");
  assert.equal(row.executor, "cloud");
  assert.equal(row.title, "免费员工 · 派活");
  assert.equal(row.input, "整理今日行业新闻");
});

await check("派活：cliRequirement=required 走 desktop 执行器", async () => {
  const store = baseStore();
  const data = await dispatch(store, { employeeSlug: "desk-bot", input: "本机整理文件" });
  assert.equal(data.executor, "desktop");
  assert.equal(store.db.tasks.find((t) => t.id === data.taskId).executor, "desktop");
});

await check("派活：自定义 title 生效", async () => {
  const store = baseStore();
  const data = await dispatch(store, { employeeSlug: "free-bot", input: "写周报", title: "本周复盘" });
  assert.equal(store.db.tasks.find((t) => t.id === data.taskId).title, "本周复盘");
});

await check("派活：付费员工有 active 购买记录时可派活", async () => {
  const store = baseStore();
  const data = await dispatch(store, { employeeSlug: "paid-bot", input: "做投放计划" });
  assert.equal(data.status, "queued");
  assert.equal(data.employee.slug, "paid-bot");
});

await rejects("派活：同用户已有 5 条 queued/running 时触发并发上限", async () => {
  const store = baseStore();
  for (let i = 0; i < 5; i++) {
    store.db.tasks.push({ id: "seed-" + i, userId: USER, employeeId: "e-free", title: "t", status: i % 2 ? "running" : "queued", input: "x" });
  }
  await dispatch(store, { employeeSlug: "free-bot", input: "再来一条" });
}, "派活过于频繁，请等当前任务完成");

await check("派活：并发统计只算 queued/running，已结束任务不占额度", async () => {
  const store = baseStore();
  for (let i = 0; i < 5; i++) {
    store.db.tasks.push({ id: "done-" + i, userId: USER, employeeId: "e-free", title: "t", status: "succeeded", input: "x" });
  }
  const data = await dispatch(store, { employeeSlug: "free-bot", input: "新任务" });
  assert.equal(data.status, "queued");
});

await check("派活：并发上限按用户隔离，其他用户的任务不占用额度", async () => {
  const store = baseStore();
  for (let i = 0; i < 5; i++) {
    store.db.tasks.push({ id: "other-" + i, userId: "u2", employeeId: "e-free", title: "t", status: "queued", input: "x" });
  }
  const data = await dispatch(store, { employeeSlug: "free-bot", input: "我的任务" });
  assert.equal(data.status, "queued");
});

// ---------- employee_task_status ----------
function seedTask(store, overrides = {}) {
  const task = {
    id: "task-view",
    userId: USER,
    employeeId: "e-free",
    title: "行业日报",
    status: "succeeded",
    outputText: "x".repeat(5000),
    error: null,
    createdAt: new Date("2026-11-01T02:00:00.000Z"),
    finishedAt: new Date("2026-11-01T03:00:00.000Z"),
    ...overrides,
  };
  store.db.tasks.push(task);
  return task;
}

await check("查任务：返回状态/标题/员工/截断输出/产物与 ISO 时间", async () => {
  const store = baseStore();
  seedTask(store);
  store.db.artifacts.push(
    { taskId: "task-view", kind: "link", url: "https://a.example.com", text: "y".repeat(400), createdAt: new Date("2026-11-01T02:10:00Z") },
    { taskId: "task-view", kind: "text", url: null, text: "简短说明", createdAt: new Date("2026-11-01T02:20:00Z") },
  );
  const data = await handlers(store).employee_task_status({ userId: USER, phone: null, params: { taskId: "task-view" } });
  assert.equal(data.taskId, "task-view");
  assert.equal(data.status, "succeeded");
  assert.equal(data.title, "行业日报");
  assert.deepEqual(data.employee, { slug: "free-bot", name: "免费员工" });
  assert.equal(data.outputText.length, 4000);
  assert.equal(data.artifacts.length, 2);
  assert.equal(data.artifacts[0].kind, "link");
  assert.equal(data.artifacts[0].url, "https://a.example.com");
  assert.equal(data.artifacts[0].text.length, 300);
  assert.equal(data.artifacts[1].text, "简短说明");
  assert.equal(data.error, null);
  assert.equal(data.createdAt, "2026-11-01T02:00:00.000Z");
  assert.equal(data.finishedAt, "2026-11-01T03:00:00.000Z");
});

await check("查任务：未完成任务的 finishedAt 为 null", async () => {
  const store = baseStore();
  seedTask(store, { status: "running", outputText: "处理中", finishedAt: null });
  const data = await handlers(store).employee_task_status({ userId: USER, phone: null, params: { taskId: "task-view" } });
  assert.equal(data.finishedAt, null);
  assert.equal(data.outputText, "处理中");
  assert.equal(data.artifacts.length, 0);
});

await rejects("查任务：任务不存在被拒", async () => {
  await handlers(baseStore()).employee_task_status({ userId: USER, phone: null, params: { taskId: "nope" } });
}, "任务不存在");

await rejects("查任务：他人的任务一律当不存在", async () => {
  const store = baseStore();
  seedTask(store, { userId: "u2" });
  await handlers(store).employee_task_status({ userId: USER, phone: null, params: { taskId: "task-view" } });
}, "任务不存在");

await rejects("查任务：taskId 缺失被拒", async () => {
  await handlers(baseStore()).employee_task_status({ userId: USER, phone: null, params: {} });
}, "taskId 必填");

// ---------- cron_create ----------
await rejects("定时：cron 表达式非法被拒", async () => {
  await handlers(baseStore()).cron_create({ userId: USER, phone: null, params: { employeeSlug: "free-bot", cronExpr: "not a cron" } });
}, "cronExpr 或 timezone 不合法");

await rejects("定时：员工不存在被拒", async () => {
  await handlers(baseStore()).cron_create({ userId: USER, phone: null, params: { employeeSlug: "nope-bot", cronExpr: "0 9 * * *" } });
}, "员工不存在或已下架");

await rejects("定时：未安装该员工被拒", async () => {
  await handlers(baseStore()).cron_create({ userId: "u-none", phone: null, params: { employeeSlug: "free-bot", cronExpr: "0 9 * * *" } });
}, "员工未安装或授权已过期");

await check("定时：正常创建并算出未来 nextRunAt", async () => {
  const store = baseStore();
  const before = Date.now();
  const data = await handlers(store).cron_create({
    userId: USER,
    phone: null,
    params: { employeeSlug: "free-bot", cronExpr: "0 9 * * *", workflowKey: "daily" },
  });
  assert.equal(typeof data.cronId, "string");
  assert.equal(data.cronExpr, "0 9 * * *");
  assert.equal(data.timezone, "Asia/Shanghai");
  assert.deepEqual(data.employee, { slug: "free-bot", name: "免费员工" });
  assert.equal(typeof data.nextRunAt, "string");
  const next = new Date(data.nextRunAt);
  assert.ok(!Number.isNaN(next.getTime()), "nextRunAt 应为合法 ISO");
  assert.ok(next.getTime() > before, "nextRunAt 应在未来");
  assert.equal(next.toISOString(), data.nextRunAt);
  const row = store.db.crons.find((c) => c.id === data.cronId);
  assert.ok(row, "定时任务应写入库");
  assert.equal(row.workflowKey, "daily");
  assert.equal(row.enabled, true);
  assert.equal(row.nextRunAt.toISOString(), data.nextRunAt);
});

await check("定时：自定义 timezone 生效", async () => {
  const store = baseStore();
  const data = await handlers(store).cron_create({
    userId: USER,
    phone: null,
    params: { employeeSlug: "desk-bot", cronExpr: "30 8 * * 1", timezone: "America/New_York" },
  });
  assert.equal(data.timezone, "America/New_York");
  assert.equal(store.db.crons.find((c) => c.id === data.cronId).workflowKey, "default");
});

// ---------- cron_list ----------
await check("定时列表：按 nextRunAt 升序、只含本人、total 正确", async () => {
  const store = baseStore();
  const now = Date.now();
  store.db.crons.push(
    { id: "c-late", userId: USER, employeeId: "e-free", cronExpr: "0 10 * * *", timezone: "Asia/Shanghai", workflowKey: "default", enabled: true, nextRunAt: new Date(now + 7200000), lastRunAt: null },
    { id: "c-early", userId: USER, employeeId: "e-desk", cronExpr: "0 9 * * *", timezone: "Asia/Shanghai", workflowKey: "default", enabled: true, nextRunAt: new Date(now + 1800000), lastRunAt: new Date(now - 3600000) },
    { id: "c-mid", userId: USER, employeeId: "e-free", cronExpr: "0 9 * * *", timezone: "Asia/Shanghai", workflowKey: "default", enabled: false, nextRunAt: new Date(now + 3600000), lastRunAt: null },
    { id: "c-other", userId: "u2", employeeId: "e-free", cronExpr: "0 9 * * *", timezone: "Asia/Shanghai", workflowKey: "default", enabled: true, nextRunAt: new Date(now + 60000), lastRunAt: null },
  );
  const data = await handlers(store).cron_list({ userId: USER, phone: null, params: {} });
  assert.equal(data.total, 3);
  assert.deepEqual(data.items.map((i) => i.cronId), ["c-early", "c-mid", "c-late"]);
  assert.equal(data.items[0].employee.slug, "desk-bot");
  assert.equal(typeof data.items[0].nextRunAt, "string");
  assert.equal(data.items[0].lastRunAt, new Date(now - 3600000).toISOString());
  assert.equal(data.items[1].enabled, false);
  assert.equal(data.items[2].lastRunAt, null);
});

await check("定时列表：没有任务时返回空数组", async () => {
  const data = await handlers(baseStore()).cron_list({ userId: USER, phone: null, params: {} });
  assert.deepEqual(data, { items: [], total: 0 });
});

// ---------- cron_delete ----------
await rejects("定时删除：别人的定时器被拒（当不存在）", async () => {
  const store = baseStore();
  store.db.crons.push({ id: "c-other", userId: "u2", employeeId: "e-free", cronExpr: "0 9 * * *", timezone: "Asia/Shanghai", workflowKey: "default", enabled: true, nextRunAt: new Date(), lastRunAt: null });
  await handlers(store).cron_delete({ userId: USER, phone: null, params: { cronId: "c-other" } });
}, "定时器不存在");

await rejects("定时删除：不存在的定时器被拒", async () => {
  await handlers(baseStore()).cron_delete({ userId: USER, phone: null, params: { cronId: "nope" } });
}, "定时器不存在");

await check("定时删除：删除自己的定时器成功且真正移除", async () => {
  const store = baseStore();
  store.db.crons.push({ id: "c-mine", userId: USER, employeeId: "e-free", cronExpr: "0 9 * * *", timezone: "Asia/Shanghai", workflowKey: "default", enabled: true, nextRunAt: new Date(), lastRunAt: null });
  const data = await handlers(store).cron_delete({ userId: USER, phone: null, params: { cronId: "c-mine" } });
  assert.deepEqual(data, { cronId: "c-mine", deleted: true });
  assert.equal(store.db.crons.some((c) => c.id === "c-mine"), false);
});

console.log("");
if (fail > 0) {
  console.log("P17 employee-tools SMOKE FAILED (" + fail + " failed, " + pass + " passed)");
  process.exit(1);
}
console.log("P17 employee-tools SMOKE OK (" + pass + " checks)");
