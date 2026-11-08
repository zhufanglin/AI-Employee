#!/usr/bin/env node
/**
 * P22 记忆清理定时任务 单测。
 * 假 prisma + 假 CapabilityService，不连库、不打上游、不真的等一周。
 */
import { createRequire } from "node:module";
const require2 = createRequire("C:/Users/30290/Desktop/fcmediaagent-replica/packages/server/package.json");
const mod = require2("./dist/capabilities/memory-cleanup.service.js");
const MemoryCleanupService = mod.MemoryCleanupService;
const nextWeeklyRun = mod.nextWeeklyRun;

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log("PASS " + name + (extra !== undefined ? " " + JSON.stringify(extra) : "")); }
  else { fail++; console.log("FAIL " + name + " " + JSON.stringify(extra)); }
}

function makePrisma(groups) {
  const calls = [];
  return {
    calls,
    agentMemory: {
      groupBy: async (args) => { calls.push(args); return groups; },
    },
  };
}

function makeCaps(resultFor) {
  const calls = [];
  return {
    calls,
    run: async (user, name, params) => {
      calls.push({ userId: user.id, name, params });
      const res = resultFor ? resultFor(user.id) : null;
      if (res) return res;
      return { success: true, data: { applied: 1, proposals: [{}, {}] }, error: null };
    },
  };
}

async function withEnv(pairs, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(pairs)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ── 1. 排程时刻：每周日 03:00（Asia/Shanghai） ──
{
  const sundayEarly = new Date("2026-11-07T18:00:00Z"); // 上海 11-08（周日）02:00
  const r1 = nextWeeklyRun(sundayEarly, 3);
  check("周日 02:00 → 当天 03:00", r1.toISOString() === "2026-11-07T19:00:00.000Z", r1.toISOString());

  const sundayLate = new Date("2026-11-07T20:00:00Z"); // 上海 11-08（周日）04:00
  const r2 = nextWeeklyRun(sundayLate, 3);
  check("周日 04:00 已过点 → 下周日 03:00", r2.toISOString() === "2026-11-14T19:00:00.000Z", r2.toISOString());

  const wednesday = new Date("2026-11-11T04:00:00Z"); // 上海 11-11（周三）12:00
  const r3 = nextWeeklyRun(wednesday, 3);
  check("周三 → 最近的周日 03:00", r3.toISOString() === "2026-11-14T19:00:00.000Z", r3.toISOString());

  const saturday = new Date("2026-11-07T10:00:00Z"); // 上海 11-07（周六）18:00
  const r4 = nextWeeklyRun(saturday, 3);
  check("周六 → 次日（周日）03:00", r4.toISOString() === "2026-11-07T19:00:00.000Z", r4.toISOString());

  check("排程时刻换算到上海是 03:00", new Date(r3.getTime() + 8 * 3600000).toISOString().slice(11, 16) === "03:00", new Date(r3.getTime() + 8 * 3600000).toISOString());
  check("自定义小时生效", nextWeeklyRun(wednesday, 5).toISOString() === "2026-11-14T21:00:00.000Z", nextWeeklyRun(wednesday, 5).toISOString());
}

// ── 2. 只清理记忆足够多的用户 ──
{
  const prisma = makePrisma([
    { userId: "u-big", _count: { _all: 25 } },
    { userId: "u-small", _count: { _all: 3 } },
    { userId: "u-exact", _count: { _all: 20 } },
    { userId: "u-num", _count: 21 },
  ]);
  const caps = makeCaps();
  const svc = new MemoryCleanupService(prisma, caps);
  const run = await svc.runOnce("单测");
  const users = caps.calls.map((c) => c.userId).sort();
  check("记忆少的用户被跳过（阈值 20）", users.join(",") === "u-big,u-exact,u-num", users);
  check("调用次数等于目标用户数", caps.calls.length === 3, caps.calls.length);
  check("汇总合并数与候选数", run && run.users === 3 && run.applied === 3 && run.proposals === 6, run);
  check("默认走 apply、limit=60", caps.calls.every((c) => c.params.mode === "apply" && c.params.limit === 60), caps.calls[0]);
  check("能力名是 memory_dedupe", caps.calls.every((c) => c.name === "memory_dedupe"), caps.calls.map((c) => c.name));
}

// ── 3. 开关关闭时什么都不做 ──
{
  await withEnv({ MEMORY_CLEANUP_ENABLED: "0" }, async () => {
    const prisma = makePrisma([{ userId: "u-big", _count: { _all: 50 } }]);
    const caps = makeCaps();
    const svc = new MemoryCleanupService(prisma, caps);
    svc.onApplicationBootstrap();
    check("关闭时不排程", svc.status().enabled === false && svc.status().nextAt === null, svc.status());
    const run = await svc.runOnce("单测");
    check("关闭时不调用能力", run === null && caps.calls.length === 0, { run, calls: caps.calls.length });
    svc.onApplicationShutdown();
  });
}

// ── 4. 环境变量可调（report 模式 / 条数 / 阈值 / 小时） ──
{
  await withEnv({ MEMORY_CLEANUP_MODE: "report", MEMORY_CLEANUP_LIMIT: "30", MEMORY_CLEANUP_MIN_ROWS: "5", MEMORY_CLEANUP_HOUR: "4" }, async () => {
    const prisma = makePrisma([{ userId: "u-5", _count: { _all: 5 } }, { userId: "u-4", _count: { _all: 4 } }]);
    const caps = makeCaps();
    const svc = new MemoryCleanupService(prisma, caps);
    await svc.runOnce("单测");
    check("阈值可调（5 条也清理）", caps.calls.length === 1 && caps.calls[0].userId === "u-5", caps.calls.map((c) => c.userId));
    check("模式与条数可调", caps.calls[0].params.mode === "report" && caps.calls[0].params.limit === 30, caps.calls[0].params);
    check("小时可调并写进状态", svc.status().schedule.includes("04:00"), svc.status().schedule);
  });
  await withEnv({ MEMORY_CLEANUP_HOUR: "99", MEMORY_CLEANUP_LIMIT: "9999" }, async () => {
    const svc = new MemoryCleanupService(makePrisma([]), makeCaps());
    const st = svc.status();
    check("非法小时回落到 03:00", st.schedule.includes("03:00"), st.schedule);
    check("limit 上限 60", st.limit === 60, st.limit);
  });
}

// ── 5. 单个用户失败不影响其他人 ──
{
  const prisma = makePrisma([{ userId: "u-bad", _count: { _all: 30 } }, { userId: "u-ok", _count: { _all: 30 } }]);
  const caps = makeCaps((id) => (id === "u-bad" ? { success: false, data: null, error: "上游超时" } : null));
  const svc = new MemoryCleanupService(prisma, caps);
  const run = await svc.runOnce("单测");
  check("失败用户记数但不中断", run && run.failed === 1 && run.users === 2, run);
  check("成功用户照常合并", run && run.applied === 1 && run.proposals === 2, run);
  check("两个用户都被尝试", caps.calls.length === 2, caps.calls.map((c) => c.userId));
}

// ── 6. 能力抛异常也不中断 ──
{
  const prisma = makePrisma([{ userId: "u-throw", _count: { _all: 30 } }, { userId: "u-ok", _count: { _all: 30 } }]);
  const calls = [];
  const caps = {
    run: async (user) => {
      calls.push(user.id);
      if (user.id === "u-throw") throw new Error("数据库抖动");
      return { success: true, data: { applied: 0, proposals: [] } };
    },
  };
  const svc = new MemoryCleanupService(prisma, caps);
  const run = await svc.runOnce("单测");
  check("异常被吞掉并记录失败", run && run.failed === 1 && calls.length === 2, { run, calls });
}

// ── 6.5 手动指定 mode（管理端"只出报告"用） ──
{
  const prisma = makePrisma([{ userId: "u-a", _count: { _all: 30 } }]);
  const caps = makeCaps();
  const svc = new MemoryCleanupService(prisma, caps);
  await svc.runOnce("单测", "report");
  check("可临时指定 report 模式", caps.calls.length === 1 && caps.calls[0].params.mode === "report", caps.calls[0] && caps.calls[0].params);
  const caps2 = makeCaps();
  const svc2 = new MemoryCleanupService(prisma, caps2);
  await svc2.runOnce("单测", "随便写");
  check("非法 mode 覆盖回落到默认", caps2.calls[0].params.mode === "apply", caps2.calls[0].params);
}

// ── 7. 启动排程 / 关闭清理定时器 ──
{
  await withEnv({ MEMORY_CLEANUP_ENABLED: undefined }, async () => {
    const svc = new MemoryCleanupService(makePrisma([]), makeCaps());
    svc.onApplicationBootstrap();
    const st = svc.status();
    check("启动后排了下次执行时间", st.enabled === true && typeof st.nextAt === "string" && new Date(st.nextAt).getTime() > Date.now(), st.nextAt);
    check("下次执行是未来 7 天内", new Date(st.nextAt).getTime() - Date.now() <= 7 * 86400000, st.nextAt);
    svc.onApplicationShutdown();
    check("关闭时清理定时器", svc.status().nextAt !== null, "nextAt 保留展示，定时器已清除");
  });
}

console.log("");
if (fail) { console.log("P22 memory-cleanup SMOKE FAILED (" + pass + " checks, " + fail + " failed)"); process.exit(1); }
console.log("P22 memory-cleanup SMOKE OK (" + pass + " checks, 0 failed)");
