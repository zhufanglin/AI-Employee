#!/usr/bin/env node
/**
 * P20 记忆自动去重/合并 + 多轮追问改写 单测。
 * 全部用假 providers + 假 prisma，不连库、不打上游。
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require2 = createRequire("C:/Users/30290/Desktop/fcmediaagent-replica/packages/server/package.json");
const semantic = require2("./dist/capabilities/capabilities/memory-semantic.js");
const mem = require2("./dist/capabilities/capabilities/memory-tools.js");
const worker = await import(pathToFileURL("C:/Users/30290/Desktop/fcmediaagent-replica/packages/worker/tool-loop.mjs").href);

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
      if (prompt.includes("检索改写助手")) {
        if (overrides.rewriteThrows) throw new Error("改写失败");
        if (overrides.rewriteBad) return { choices: [{ message: { content: "" } }] };
        if (typeof overrides.rewrite === "string") return { choices: [{ message: { content: overrides.rewrite } }] };
        return { choices: [{ message: { content: "赵姐的报价是多少" } }] };
      }
      if (prompt.includes("检索关键词")) return { choices: [{ message: { content: '["报价","收费"]' } }] };
      if (prompt.includes("检索排序助手")) {
        const start = prompt.lastIndexOf("\n\n[");
        const items = JSON.parse(prompt.slice(start + 2));
        const scores = items.map((item) => ({ id: item.id, score: String(item.text).includes("赵姐") ? 95 : 5 }));
        return { choices: [{ message: { content: JSON.stringify({ scores }) } }] };
      }
      if (overrides.judgeThrows) throw new Error("判定失败");
      if (typeof overrides.judge === "function") {
        const start = prompt.lastIndexOf("\n\n已有记忆：\n");
        const list = JSON.parse(prompt.slice(start + 8));
        return { choices: [{ message: { content: JSON.stringify(overrides.judge(list)) } }] };
      }
      return { choices: [{ message: { content: '{"relation":"different","id":"","merged":""}' } }] };
    },
  };
  return provider;
}

const now = Date.now();
function baseRows() {
  return [
    { id: "m1", userId: "u1", kind: "preference", title: "赵姐报价", content: "赵姐的报价只接受季度付，且必须含税", tags: "报价,赵姐", createdAt: new Date(now - 86400000), hitCount: 2 },
    { id: "m2", userId: "u1", kind: "note", title: "直播排期", content: "下周三直播，主题是暑期招生", tags: "直播", createdAt: new Date(now - 3600000), hitCount: 0 },
    { id: "m3", userId: "u2", kind: "note", title: "别人的记忆", content: "别家客户的报价", tags: "", createdAt: new Date(now), hitCount: 0 },
  ];
}

function makePrisma(rows) {
  const created = [];
  const updates = [];
  const matches = (row, where) => {
    if (where.userId && row.userId !== where.userId) return false;
    const ors = where.OR || [];
    if (!ors.length) return true;
    return ors.some((cond) => {
      const key = Object.keys(cond)[0];
      return String(row[key] || "").includes(cond[key].contains);
    });
  };
  return {
    created,
    updates,
    agentMemory: {
      findMany: async ({ where }) => rows.filter((row) => matches(row, where)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
      create: async ({ data }) => {
        const row = { id: "new" + (created.length + 1), ...data, createdAt: new Date(), hitCount: 0 };
        rows.push(row);
        created.push(row);
        return row;
      },
      updateMany: async ({ where, data }) => {
        const id = typeof where.id === "string" ? where.id : where.id && where.id.in && where.id.in[0];
        const row = rows.find((item) => item.id === id && (!where.userId || item.userId === where.userId));
        updates.push({ id, data, found: !!row });
        if (!row) return { count: 0 };
        if (data.content !== undefined) row.content = data.content;
        if (data.title !== undefined) row.title = data.title;
        if (data.tags !== undefined) row.tags = data.tags;
        if (data.hitCount && data.hitCount.increment) row.hitCount = (row.hitCount || 0) + data.hitCount.increment;
        return { count: 1 };
      },
      findFirst: async ({ where }) => rows.find((row) => row.id === where.id && (!where.userId || row.userId === where.userId)) || null,
      deleteMany: async ({ where }) => {
        const index = rows.findIndex((row) => row.id === where.id);
        if (index >= 0) rows.splice(index, 1);
        return { count: index >= 0 ? 1 : 0 };
      },
    },
  };
}

const ctx = (params, userId = "u1") => ({ userId, phone: "13900000002", params });

// ---------- 1. 追问改写 ----------
{
  const providers = makeProviders();
  const out = await semantic.rewriteQuery(providers, "那她呢", "用户：赵姐那边报价多少\n助手：我查一下");
  check("追问改写成完整问题", out === "赵姐的报价是多少", out);
  check("改写请求关闭思考", providers.bodies[0] && providers.bodies[0].thinking && providers.bodies[0].thinking.type === "disabled", providers.bodies[0] && providers.bodies[0].thinking);
  const before = providers.prompts.length;
  const again = await semantic.rewriteQuery(providers, "那她呢", "用户：赵姐那边报价多少\n助手：我查一下");
  check("改写命中缓存不重复调模型", again === out && providers.prompts.length === before, providers.prompts.length - before);
  check("没有上下文不改写", (await semantic.rewriteQuery(providers, "那她呢", "")) === null);
  check("改写结果与原文相同视为无需改写", (await semantic.rewriteQuery(makeProviders({ rewrite: "那她呢" }), "那她呢", "用户：随便聊聊")) === null);
  check("改写失败返回 null", (await semantic.rewriteQuery(makeProviders({ rewriteThrows: true }), "那她呢", "用户：赵姐报价多少")) === null);
  check("改写空结果返回 null", (await semantic.rewriteQuery(makeProviders({ rewriteBad: true }), "那她呢", "用户：赵姐报价多少")) === null);
  check("改写超长结果丢弃", (await semantic.rewriteQuery(makeProviders({ rewrite: "赵".repeat(120) }), "那她呢", "用户：赵姐报价多少")) === null);
}

// ---------- 2. 去重判定 ----------
{
  const candidates = [{ id: "m1", title: "赵姐报价", text: "赵姐的报价只接受季度付" }];
  const dup = await semantic.judgeMemory(makeProviders({ judge: () => ({ relation: "duplicate", id: "m1", merged: "" }) }), "赵姐只收季度付", candidates);
  check("判定重复", dup && dup.relation === "duplicate" && dup.id === "m1", dup);
  const merge = await semantic.judgeMemory(makeProviders({ judge: () => ({ relation: "merge", id: "m1", merged: "赵姐只收季度付，5 月起涨价 10%" }) }), "赵姐 5 月起涨价 10%", candidates);
  check("判定合并并带合并正文", merge && merge.relation === "merge" && merge.merged.includes("涨价"), merge);
  const diff = await semantic.judgeMemory(makeProviders({ judge: () => ({ relation: "different" }) }), "别的客户", candidates);
  check("判定无关", diff && diff.relation === "different", diff);
  check("非法 relation 返回 null", (await semantic.judgeMemory(makeProviders({ judge: () => ({ relation: "same" }) }), "x", candidates)) === null);
  check("id 不在候选里返回 null", (await semantic.judgeMemory(makeProviders({ judge: () => ({ relation: "duplicate", id: "zzz" }) }), "x", candidates)) === null);
  check("判定异常返回 null", (await semantic.judgeMemory(makeProviders({ judgeThrows: true }), "x", candidates)) === null);
  check("没有候选直接返回 null", (await semantic.judgeMemory(makeProviders(), "x", [])) === null);
}

// ---------- 3. memory_save 自动去重/合并 ----------
{
  const rows = baseRows();
  const prisma = makePrisma(rows);
  const providers = makeProviders({ judge: () => ({ relation: "duplicate", id: "m1", merged: "" }) });
  const handlers = mem.buildMemoryHandlers(prisma, providers);
  const out = await handlers.memory_save(ctx({ content: "赵姐报价只收季度付、含税", title: "赵姐报价", tags: "季度付" }));
  check("重复记忆不新增", prisma.created.length === 0, prisma.created.length);
  check("重复记忆返回原 id", out.id === "m1" && out.action === "duplicate", out);
  check("重复记忆累加命中并合并标签", rows[0].hitCount === 3 && String(rows[0].tags).includes("季度付"), { hit: rows[0].hitCount, tags: rows[0].tags });
  check("查重请求带上候选正文", providers.prompts.some((p) => p.includes("赵姐的报价只接受季度付")), providers.prompts.length);
}
{
  const rows = baseRows();
  const prisma = makePrisma(rows);
  const providers = makeProviders({ judge: () => ({ relation: "merge", id: "m1", merged: "赵姐的报价只接受季度付且含税；5 月起涨价 10%" }) });
  const handlers = mem.buildMemoryHandlers(prisma, providers);
  const out = await handlers.memory_save(ctx({ content: "赵姐 5 月起涨价 10%", title: "赵姐报价" }));
  check("合并记忆不新增", prisma.created.length === 0, prisma.created.length);
  check("合并记忆返回 merged", out.action === "merged" && out.id === "m1", out);
  check("合并后的正文写回原记忆", rows[0].content.includes("涨价 10%") && rows[0].content.includes("季度付"), rows[0].content);
}
{
  const rows = baseRows();
  const prisma = makePrisma(rows);
  const providers = makeProviders({ judge: () => ({ relation: "merge", id: "m1" }) });
  const handlers = mem.buildMemoryHandlers(prisma, providers);
  const out = await handlers.memory_save(ctx({ content: "赵姐 5 月起涨价 10%" }));
  check("合并没有 merged 正文时追加原文", out.action === "merged" && rows[0].content.includes("涨价 10%") && rows[0].content.includes("季度付"), rows[0].content);
}
{
  const rows = baseRows();
  const prisma = makePrisma(rows);
  const providers = makeProviders();
  const handlers = mem.buildMemoryHandlers(prisma, providers);
  const out = await handlers.memory_save(ctx({ content: "新客户李哥只做年付" }));
  check("无关记忆正常新增", prisma.created.length === 1 && out.action === "created", out);
  check("新增记忆归属当前用户", prisma.created[0].userId === "u1", prisma.created[0].userId);
  check("无关记忆不误合并", String(rows[0].content).includes("赵姐的报价只接受季度付"), rows[0].content);
}
{
  const rows = baseRows();
  const prisma = makePrisma(rows);
  const providers = makeProviders({ judgeThrows: true });
  const handlers = mem.buildMemoryHandlers(prisma, providers);
  const out = await handlers.memory_save(ctx({ content: "赵姐想改成月付" }));
  check("判定异常时按新增写入（不丢记忆）", out.action === "created" && prisma.created.length === 1, out);
}
{
  const rows = baseRows();
  const prisma = makePrisma(rows);
  const providers = makeProviders({ judge: () => ({ relation: "duplicate", id: "m1" }) });
  const handlers = mem.buildMemoryHandlers(prisma, providers);
  const out = await handlers.memory_save(ctx({ content: "赵姐报价只收季度付", dedupe: "off" }));
  check("dedupe=off 直接新增", out.action === "created" && prisma.created.length === 1, out);
  check("dedupe=off 不调用判定模型", !providers.prompts.some((p) => p.includes("记忆库管理员")));
}
{
  const handlers = mem.buildMemoryHandlers(makePrisma(baseRows()), makeProviders());
  let err = null;
  try { await handlers.memory_save(ctx({ content: "x", dedupe: "maybe" })); } catch (error) { err = error; }
  check("dedupe 非法值被拒", err && String(err.message).includes("dedupe 只能是 auto 或 off"), err && err.message);
}
{
  const prisma = makePrisma([]);
  const handlers = mem.buildMemoryHandlers(prisma, makeProviders());
  const out = await handlers.memory_save(ctx({ content: "第一条记忆" }));
  check("空库首条记忆直接新增", out.action === "created" && prisma.created.length === 1, out);
}

// ---------- 4. memory_search 追问改写 ----------
// 改写结果按「上下文+问题」缓存（10 分钟），跨用例会串味，先清掉
semantic.clearRewriteCache && semantic.clearRewriteCache();
{
  const rows = baseRows();
  const prisma = makePrisma(rows);
  const providers = makeProviders();
  const handlers = mem.buildMemoryHandlers(prisma, providers);
  const out = await handlers.memory_search(ctx({ query: "那她呢", context: "用户：赵姐那边报价多少\n助手：我查一下" }));
  check("追问被改写成独立查询", out.rewritten === "赵姐的报价是多少" && out.effectiveQuery === "赵姐的报价是多少", out.rewritten);
  check("改写后仍返回原 query", out.query === "那她呢", out.query);
  check("追问能召回相关记忆", out.total >= 1 && out.items[0].id === "m1", out.items.map((item) => item.id));
  check("改写请求带对话上下文", providers.prompts.some((p) => p.includes("赵姐那边报价多少")));
  check("改写调用关闭思考", providers.bodies.some((b) => b.thinking && b.thinking.type === "disabled"));
}
{
  const rows = baseRows();
  const prisma = makePrisma(rows);
  const providers = makeProviders();
  const handlers = mem.buildMemoryHandlers(prisma, providers);
  const out = await handlers.memory_search(ctx({ query: "赵姐报价" }));
  check("无上下文的检索不调用改写", out.rewritten === null && out.effectiveQuery === "赵姐报价", out.effectiveQuery);
  check("无上下文仍能正常检索", out.total >= 1 && out.items[0].id === "m1", out.items.map((item) => item.id));
}
{
  const rows = baseRows();
  const prisma = makePrisma(rows);
  const providers = makeProviders({ rewriteThrows: true });
  const handlers = mem.buildMemoryHandlers(prisma, providers);
  const out = await handlers.memory_search(ctx({ query: "赵姐报价", context: "用户：赵姐那边报价多少" }));
  check("改写失败退回原问题检索", out.rewritten === null && out.total >= 1, { rewritten: out.rewritten, total: out.total });
}
{
  const rows = baseRows();
  const prisma = makePrisma(rows);
  const providers = makeProviders();
  const handlers = mem.buildMemoryHandlers(prisma, providers);
  const out = await handlers.memory_search(ctx({ query: "那她呢", mode: "keyword", context: "用户：赵姐那边报价多少" }));
  check("keyword 模式不做改写", out.rewritten === null && !providers.prompts.some((p) => p.includes("检索改写助手")), out.rewritten);
}
{
  const rows = baseRows();
  const handlers = mem.buildMemoryHandlers(makePrisma(rows), null);
  const out = await handlers.memory_search(ctx({ query: "那她呢", context: "用户：赵姐那边报价多少" }));
  check("没有语义能力时检索照常可用", out.rewritten === null && out.semantic === false, out.semantic);
}

// ---------- 5. 执行器上下文注入 ----------
{
  const messages = [
    { role: "system", content: "系统提示" },
    { role: "user", content: "赵姐那边报价多少" },
    { role: "assistant", content: "我查一下她的记录" },
  ];
  const context = worker.recentContext(messages);
  check("上下文只取用户/助手消息", !context.includes("系统提示") && context.includes("用户：赵姐那边报价多少"), context);
  check("上下文带角色前缀", context.includes("助手：我查一下她的记录"), context);
  check("上下文长度受限", worker.recentContext(messages, 10).length === 10, worker.recentContext(messages, 10).length);
  check("空对话返回空串", worker.recentContext([]) === "" && worker.recentContext(null) === "");

  const calls = [];
  let step = 0;
  const api = async (path, options) => {
    calls.push({ path, body: options && options.body ? JSON.parse(options.body) : null });
    if (path === "/capabilities") return { items: [{ name: "memory_search", description: "回忆", params: {} }] };
    if (path === "/capabilities/run") return { success: true, data: { total: 1, items: [] } };
    step += 1;
    if (step === 1) return { choices: [{ message: { content: '{"tool":"memory_search","params":{"query":"那她呢"}}' } }] };
    return { choices: [{ message: { content: '{"tool":"finish","params":{"text":"查到了"}}' } }] };
  };
  await worker.runToolLoop({ api, model: "doubao-seed-2-0-lite", messages, maxSteps: 3, timeoutMs: 10000, pollMs: 10 });
  const runCall = calls.find((call) => call.path === "/capabilities/run");
  check("执行器自动带上最近对话", runCall && typeof runCall.body.params.context === "string" && runCall.body.params.context.includes("赵姐"), runCall && runCall.body.params);
  check("执行器保留模型原参数", runCall && runCall.body.params.query === "那她呢", runCall && runCall.body.params.query);
}

console.log((fail === 0 ? "P20 memory SMOKE OK" : "P20 memory SMOKE FAILED") + " (" + pass + " checks, " + fail + " failed)");
process.exit(fail === 0 ? 0 : 1);
