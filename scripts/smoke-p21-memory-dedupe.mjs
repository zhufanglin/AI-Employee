#!/usr/bin/env node
/**
 * P21 存量重复记忆清理（memory_dedupe）单测。
 * 全部用假 providers + 假 prisma，不连库、不打上游。
 * 用法：先编译 server（tsc -p packages/server/tsconfig.json），再 node scripts/smoke-p21-memory-dedupe.mjs
 */
import { createRequire } from "node:module";
const require2 = createRequire("C:/Users/30290/Desktop/fcmediaagent-replica/packages/server/package.json");
const maintenance = require2("./dist/capabilities/capabilities/memory-maintenance.js");

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log("PASS " + name + (extra !== undefined ? " " + JSON.stringify(extra) : "")); }
  else { fail++; console.log("FAIL " + name + " " + JSON.stringify(extra)); }
}

function makeProviders(overrides = {}) {
  const prompts = [];
  const bodies = [];
  const provider = {
    prompts,
    bodies,
    resolve: async (alias) => ({ alias, provider: "ark", baseUrl: "http://fake", apiKey: "k", upstreamModel: alias }),
    chat: async (_target, body) => {
      const prompt = String(body?.messages?.[0]?.content || "");
      prompts.push(prompt);
      bodies.push(body);
      if (overrides.throwAll) throw new Error("上游挂了");
      if (typeof overrides.judge === "function") {
        const start = prompt.lastIndexOf("\n\n已有记忆：\n");
        const list = JSON.parse(prompt.slice(start + 8));
        return { choices: [{ message: { content: JSON.stringify(overrides.judge(list, prompt)) } }] };
      }
      return { choices: [{ message: { content: '{"relation":"different","id":"","merged":""}' } }] };
    },
  };
  return provider;
}

const now = Date.now();
const HOUR = 3600000;
function rows() {
  return [
    { id: "old", userId: "u1", kind: "preference", title: "赵姐报价", content: "赵姐的报价只接受季度付，且必须含税", tags: "报价,赵姐", createdAt: new Date(now - 30 * HOUR), hitCount: 3 },
    { id: "new", userId: "u1", kind: "note", title: "", content: "客户赵姐报价：只接受季度付，必须含税，12 月起改 60 天", tags: "赵姐", createdAt: new Date(now - 1 * HOUR), hitCount: 1 },
    { id: "other", userId: "u1", kind: "note", title: "直播排期", content: "下周三直播，主题是暑期招生方案", tags: "直播", createdAt: new Date(now - 2 * HOUR), hitCount: 0 },
    { id: "same-user-2", userId: "u2", kind: "note", title: "别人的", content: "赵姐的报价只接受季度付，且必须含税", tags: "报价", createdAt: new Date(now - 3 * HOUR), hitCount: 0 },
  ];
}

function makePrisma(initial) {
  const list = initial.map((row) => ({ ...row }));
  const state = { updates: [], deletes: [] };
  const api = {
    findMany: async ({ where, orderBy, take } = {}) => {
      let out = list.filter((row) => !where?.userId || row.userId === where.userId);
      if (orderBy?.createdAt === "desc") out = out.slice().sort((a, b) => b.createdAt - a.createdAt);
      if (take) out = out.slice(0, take);
      return out.map((row) => ({ ...row }));
    },
    update: async ({ where, data }) => {
      const row = list.find((item) => item.id === where.id);
      if (!row) throw new Error("update 找不到记录 " + where.id);
      Object.assign(row, data);
      state.updates.push({ id: where.id, data });
      return { ...row };
    },
    deleteMany: async ({ where }) => {
      const before = list.length;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const row = list[i];
        if (where?.id && row.id !== where.id) continue;
        if (where?.userId && row.userId !== where.userId) continue;
        list.splice(i, 1);
      }
      state.deletes.push({ where, removed: before - list.length });
      return { count: before - list.length };
    },
  };
  return { prisma: { agentMemory: api }, state, list };
}

async function run(handler, params, userId = "u1") {
  try {
    const data = await handler({ userId, phone: null, params });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ── 1. 词面粗筛 ──
{
  const sim = maintenance.similarity("赵姐的报价只接受季度付，且必须含税", "客户赵姐报价：只接受季度付，必须含税");
  check("相似度：改写过的同一件事得分明显偏高", sim.score > 0.25 && sim.shared >= 5, sim);
  const low = maintenance.similarity("赵姐的报价只接受季度付", "下周三直播主题暑期招生");
  check("相似度：无关记忆得分低", low.score < 0.12, low);
  const tokens = maintenance.tokenize("赵姐报价");
  check("分词：中文片段补二元组", tokens.includes("赵姐") && tokens.includes("报价"), tokens.slice(0, 6));
}

// ── 2. report 模式只出报告不动数据 ──
{
  const { prisma, state } = makePrisma(rows());
  const handlers = maintenance.buildMemoryMaintenanceHandlers(prisma, makeProviders({
    judge: () => ({ relation: "merge", id: "old", merged: "赵姐报价只接受季度付、必须含税，12 月起改 60 天" }),
  }));
  const res = await run(handlers.memory_dedupe, {});
  check("report：默认模式是 report", res.ok && res.data.mode === "report", res.ok ? res.data.mode : res.error);
  check("report：出一份合并建议", res.ok && res.data.proposals.length === 1, res.ok ? res.data.proposals : res.error);
  const p = res.ok ? res.data.proposals[0] : {};
  check("report：保留较早的那条（keep=old）", p.keepId === "old" && p.dropId === "new", p);
  check("report：带合并后正文预览", typeof p.mergedPreview === "string" && p.mergedPreview.includes("60 天"), p.mergedPreview);
  check("report：不改任何数据", state.updates.length === 0 && state.deletes.length === 0, state);
  check("report：只对同用户记忆比对（不碰 u2）", res.ok && res.data.proposals.every((item) => item.keepId !== "same-user-2" && item.dropId !== "same-user-2"), res.ok ? res.data.proposals : null);
}

// ── 3. apply 模式执行合并与删除 ──
{
  const { prisma, state, list } = makePrisma(rows());
  const handlers = maintenance.buildMemoryMaintenanceHandlers(prisma, makeProviders({
    judge: () => ({ relation: "merge", id: "old", merged: "赵姐报价只接受季度付、必须含税，12 月起改 60 天" }),
  }));
  const res = await run(handlers.memory_dedupe, { mode: "apply" });
  check("apply：执行了 1 次合并", res.ok && res.data.applied === 1, res.ok ? res.data.applied : res.error);
  const keep = list.find((row) => row.id === "old");
  check("apply：合并写回较早那条（id 不变）", !!keep && keep.content.includes("60 天"), keep?.content);
  check("apply：命中次数相加", keep?.hitCount === 4, keep?.hitCount);
  check("apply：标签取并集", keep?.tags === "报价,赵姐", keep?.tags);
  check("apply：较晚的重复条被删除", !list.some((row) => row.id === "new") && state.deletes.length === 1, state.deletes);
  check("apply：其他记忆与别的用户不受影响", list.some((row) => row.id === "other") && list.some((row) => row.id === "same-user-2"), list.map((row) => row.id));
}

// ── 4. duplicate 判定：正文不重写，只删多余条 ──
{
  const { prisma, list } = makePrisma(rows());
  const handlers = maintenance.buildMemoryMaintenanceHandlers(prisma, makeProviders({
    judge: () => ({ relation: "duplicate", id: "old", merged: "" }),
  }));
  const res = await run(handlers.memory_dedupe, { mode: "apply" });
  const keep = list.find((row) => row.id === "old");
  check("duplicate：正文保持不变", res.ok && keep?.content === "赵姐的报价只接受季度付，且必须含税", keep?.content);
  check("duplicate：多余条被删除", res.ok && res.data.proposals[0].relation === "duplicate" && !list.some((row) => row.id === "new"), res.ok ? res.data.proposals[0] : res.error);
}

// ── 5. different / 无关记忆都不产生动作 ──
{
  const { prisma, state } = makePrisma(rows());
  const providers = makeProviders({ judge: () => ({ relation: "different", id: "", merged: "" }) });
  const handlers = maintenance.buildMemoryMaintenanceHandlers(prisma, providers);
  const res = await run(handlers.memory_dedupe, { mode: "apply" });
  check("different：不出建议、不改数据", res.ok && res.data.proposals.length === 0 && state.updates.length === 0, res.ok ? res.data : res.error);
  check("different：模型确实被问过（说明粗筛放行了相似条目）", providers.prompts.length >= 1, providers.prompts.length);
}
{
  const only = [
    { id: "a", userId: "u1", kind: "note", title: "直播", content: "下周三直播主题暑期招生", tags: "", createdAt: new Date(now), hitCount: 0 },
    { id: "b", userId: "u1", kind: "note", title: "发票", content: "开票抬头是公司全称", tags: "", createdAt: new Date(now - HOUR), hitCount: 0 },
  ];
  const { prisma, state } = makePrisma(only);
  const providers = makeProviders({ judge: () => ({ relation: "duplicate", id: "a", merged: "" }) });
  const handlers = maintenance.buildMemoryMaintenanceHandlers(prisma, providers);
  const res = await run(handlers.memory_dedupe, { mode: "apply" });
  check("粗筛：毫不相干的记忆不调用模型", res.ok && providers.prompts.length === 0 && state.deletes.length === 0, { calls: providers.prompts.length, data: res.data });
}

// ── 6. 参数校验与扫描范围 ──
{
  const { prisma } = makePrisma(rows());
  const providers = makeProviders({});
  const handlers = maintenance.buildMemoryMaintenanceHandlers(prisma, providers);
  const bad = await run(handlers.memory_dedupe, { mode: "wipe" });
  check("参数：非法 mode 被拒绝", !bad.ok && bad.error.includes("mode 只能是 report 或 apply"), bad.error);
  const badLimit = await run(handlers.memory_dedupe, { limit: 0 });
  check("参数：非法 limit 被拒绝", !badLimit.ok && badLimit.error.includes("limit 必须是正整数"), badLimit.error);

  const many = [];
  for (let i = 0; i < 10; i += 1) many.push({ id: "x" + i, userId: "u1", kind: "note", title: "", content: "客户" + i + "号报价季度付含税", tags: "", createdAt: new Date(now - i * HOUR), hitCount: 0 });
  const made = makePrisma(many);
  const h2 = maintenance.buildMemoryMaintenanceHandlers(made.prisma, makeProviders({ judge: () => ({ relation: "different", id: "", merged: "" }) }));
  const limited = await run(h2.memory_dedupe, { limit: 3 });
  check("扫描：limit 限制本次扫描条数", limited.ok && limited.data.scanned === 3, limited.ok ? { scanned: limited.data.scanned, total: limited.data.total } : limited.error);
}
{
  const handlers = maintenance.buildMemoryMaintenanceHandlers({ agentMemory: {} }, undefined);
  const res = await run(handlers.memory_dedupe, {});
  check("未配置语义模型时给出明确提示", !res.ok && res.error.includes("记忆清理需要语义模型"), res.error);
  process.env.MEMORY_SEMANTIC = "0";
  const off = await run(maintenance.buildMemoryMaintenanceHandlers({ agentMemory: {} }, makeProviders({})).memory_dedupe, {});
  delete process.env.MEMORY_SEMANTIC;
  check("MEMORY_SEMANTIC=0 时不执行清理", !off.ok && off.error.includes("记忆清理需要语义模型"), off.error);
}

// ── 7. 模型判定失败不影响继续扫描 ──
{
  const { prisma, state } = makePrisma(rows());
  const providers = makeProviders({ throwAll: true });
  const handlers = maintenance.buildMemoryMaintenanceHandlers(prisma, providers);
  const res = await run(handlers.memory_dedupe, { mode: "apply" });
  check("模型异常：不误删、不误改", res.ok && res.data.proposals.length === 0 && state.updates.length === 0 && state.deletes.length === 0, res.ok ? res.data : res.error);
}

console.log("");
if (fail) { console.log("P21 memory-dedupe SMOKE FAILED (" + pass + " checks, " + fail + " failed)"); process.exit(1); }
console.log("P21 memory-dedupe SMOKE OK (" + pass + " checks, 0 failed)");
