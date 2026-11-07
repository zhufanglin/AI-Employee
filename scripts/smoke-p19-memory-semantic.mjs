#!/usr/bin/env node
/**
 * P19 记忆语义检索单测：查询扩展 / 语义重排 / 加权合并 / 失败退化为纯关键词。
 * 全部用假 providers + 假 prisma，不连库、不打上游。
 */
import { createRequire } from "node:module";
const require2 = createRequire("C:/Users/30290/Desktop/fcmediaagent-replica/packages/server/package.json");
const mod = require2("./dist/capabilities/capabilities/memory-semantic.js");
const mem = require2("./dist/capabilities/capabilities/memory-tools.js");

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log("PASS " + name + (extra !== undefined ? " " + JSON.stringify(extra) : "")); }
  else { fail++; console.log("FAIL " + name + " " + JSON.stringify(extra)); }
}

/** 假 providers：根据提示词内容分别返回扩展词 / 相关度 */
function makeProviders(overrides = {}) {
  const calls = [];
  const bodies = [];
  return {
    calls,
    bodies,
    resolve: async (alias) => ({ alias, provider: "ark", baseUrl: "http://fake", apiKey: "k", upstreamModel: alias }),
    chat: async (_target, body) => {
      const prompt = String(body?.messages?.[0]?.content || "");
      calls.push(prompt.slice(0, 40));
      bodies.push(body);
      if (overrides.throwAll) throw new Error("上游挂了");
      if (prompt.includes("检索关键词")) {
        if (overrides.expandThrows) throw new Error("扩展失败");
        if (overrides.expandBadJson) return { choices: [{ message: { content: "我觉得应该搜报价和收费" } }] };
        return { choices: [{ message: { content: '["报价","收费","费用","多少钱"]' } }] };
      }
      if (overrides.rerankThrows) throw new Error("重排失败");
      const start = prompt.lastIndexOf("\n\n[");
      const items = JSON.parse(prompt.slice(start + 2));
      const scoreOf = overrides.scoreOf || ((item) => (String(item.text).includes("报价") ? 92 : 10));
      const scores = items.map((item) => ({ id: item.id, score: scoreOf(item) }));
      return { choices: [{ message: { content: JSON.stringify({ scores }) } }] };
    },
  };
}

function makePrisma(rows) {
  const updates = [];
  return {
    updates,
    agentMemory: {
      findMany: async ({ where }) => {
        const ors = where.OR || [];
        if (!ors.length) return rows.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return rows
          .filter((row) => ors.some((cond) => {
            const key = Object.keys(cond)[0];
            const term = cond[key].contains;
            return String(row[key] || "").includes(term);
          }))
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      },
      updateMany: async ({ where, data }) => { updates.push({ ids: where.id.in, inc: data.hitCount.increment }); return { count: where.id.in.length }; },
      create: async ({ data }) => ({ id: "m" + Math.random().toString(16).slice(2, 8), ...data, createdAt: new Date(), hitCount: 0 }),
      findFirst: async ({ where }) => rows.find((r) => r.id === where.id) || null,
      deleteMany: async () => ({ count: 1 }),
    },
  };
}

const now = Date.now();
const rows = [
  { id: "m-quote", kind: "preference", title: "张姐的付款方式", content: "张姐只接受季度付，不接受年付，报价要含税。", tags: "客户", createdAt: new Date(now - 3600e3), hitCount: 0 },
  { id: "m-other", kind: "note", title: "直播排期", content: "周四晚八点做一场开学季直播，主题是错题本。", tags: "内容", createdAt: new Date(now - 7200e3), hitCount: 0 },
];

// 1. 描述符
const desc = mem.descriptors.find((d) => d.name === "memory_search");
check("memory_search 描述符升级为语义检索", !!desc && /语义/.test(desc.title), desc && desc.title);
check("memory_search 增加 mode 参数", !!desc && !!desc.params.mode, desc && desc.params.mode);
check("memory_search 描述提到字面不同也能召回", !!desc && /字面不同/.test(desc.description));

// 2. 开关
check("默认开启语义", mod.semanticEnabled() === true);
process.env.MEMORY_SEMANTIC = "0";
check("MEMORY_SEMANTIC=0 时关闭", mod.semanticEnabled() === false);
delete process.env.MEMORY_SEMANTIC;

// 3. 查询扩展
mod.clearSemanticCache();
const p1 = makeProviders();
const terms = await mod.expandQuery(p1, "这个客户价格怎么收");
check("扩展出同义词", terms.includes("报价") && terms.includes("收费"), terms);
check("扩展调用了一次模型", p1.calls.length === 1, p1.calls.length);
check("重排候选上限降到 15 条", mod.SEMANTIC_LIMITS.MAX_RERANK_ITEMS === 15, mod.SEMANTIC_LIMITS.MAX_RERANK_ITEMS);
check("调用模型时关闭思考（否则单次检索 20–40s）", p1.bodies[0]?.thinking?.type === "disabled", p1.bodies[0]?.thinking);
check("重排候选上限降到 15 条", mod.SEMANTIC_LIMITS.MAX_RERANK_ITEMS === 15, mod.SEMANTIC_LIMITS.MAX_RERANK_ITEMS);
const again = await mod.expandQuery(p1, "这个客户价格怎么收");
check("同查询命中缓存不重复调用", again.length === terms.length && p1.calls.length === 1, p1.calls.length);

mod.clearSemanticCache();
const pBad = makeProviders({ expandBadJson: true });
check("扩展返回非 JSON 时为空数组", (await mod.expandQuery(pBad, "价格")).length === 0);
mod.clearSemanticCache();
const pThrow = makeProviders({ expandThrows: true });
check("扩展上游异常时为空数组（不抛）", (await mod.expandQuery(pThrow, "价格")).length === 0);

// 4. 重排
const p2 = makeProviders();
const scores = await mod.rerank(p2, "这个客户价格怎么收", rows.map((r) => ({ id: r.id, title: r.title, text: r.content })));
check("重排返回每条分数", !!scores && scores.size === 2, scores && [...scores.entries()]);
check("语义相关的一条得高分", scores.get("m-quote") >= 80, scores.get("m-quote"));
const pThrow2 = makeProviders({ rerankThrows: true });
check("重排上游异常时返回 null（不抛）", (await mod.rerank(pThrow2, "价格", rows)) === null);

// 5. 合并公式
check("关键词满分 + 语义 100 = 100", mod.combineScores(10, 10, 100) === 100);
check("关键词满分 + 语义 0 = 40", mod.combineScores(10, 10, 0) === 40);
check("无语义分时等于关键词归一分", mod.combineScores(5, 10, undefined) === 50);

// 6. 端到端 memory_search（假 prisma）
const prisma = makePrisma(rows);
const handlers = mem.buildMemoryHandlers(prisma, makeProviders());
const semanticHit = await handlers.memory_search({ userId: "u1", params: { query: "这个客户价格怎么收", limit: 5 } });
check("语义检索命中原句里没有「价格」的记忆", semanticHit.items.length > 0 && semanticHit.items[0].id === "m-quote", semanticHit.items.map((i) => i.id));
check("返回 expandedTerms", semanticHit.expandedTerms.includes("报价"), semanticHit.expandedTerms);
check("返回 semantic=true", semanticHit.semantic === true);
check("返回语义分与关键词分", typeof semanticHit.items[0].semanticScore === "number" && typeof semanticHit.items[0].keywordScore === "number", semanticHit.items[0]);
check("命中后累加 hitCount", prisma.updates.length === 1 && prisma.updates[0].inc === 1, prisma.updates);

const p3 = makeProviders();
const keywordHandlers = mem.buildMemoryHandlers(makePrisma(rows), p3);
const keywordOnly = await keywordHandlers.memory_search({ userId: "u1", params: { query: "这个客户价格怎么收", limit: 5, mode: "keyword" } });
check("mode=keyword 时不调模型、不加扩展词", keywordOnly.semantic === false && keywordOnly.expandedTerms.length === 0 && p3.calls.length === 0, { calls: p3.calls.length, total: keywordOnly.total });
check("mode=keyword 时只靠字面（客户标签仍能命中，但没有语义加权）", keywordOnly.items.every((i) => i.semanticScore === null), keywordOnly.items.map((i) => i.semanticScore));

const prisma2 = makePrisma(rows);
const degraded = mem.buildMemoryHandlers(prisma2, makeProviders({ throwAll: true })).memory_search;
const degradedRes = await degraded({ userId: "u1", params: { query: "季度付", limit: 5 } });
check("上游全挂时退化为纯关键词且有结果", degradedRes.semantic === false && degradedRes.total === 1 && degradedRes.items[0].id === "m-quote", { total: degradedRes.total, semantic: degradedRes.semantic });

process.env.MEMORY_SEMANTIC = "0";
const off = await mem.buildMemoryHandlers(makePrisma(rows), makeProviders()).memory_search({ userId: "u1", params: { query: "这个客户价格怎么收" } });
check("MEMORY_SEMANTIC=0 时完全不调模型", off.semantic === false && off.expandedTerms.length === 0);
delete process.env.MEMORY_SEMANTIC;

// 7. 无 providers 时兼容旧行为（P18 单测走的就是这条）
const legacy = await mem.buildMemoryHandlers(makePrisma(rows)).memory_search({ userId: "u1", params: { query: "季度付" } });
check("不传 providers 时保持纯关键词", legacy.semantic === false && legacy.total === 1);

// 7. 纯语义：扩展词一个都召不回时，候选补齐 + 重排仍能命中
const rows3 = [
  ...rows,
  { id: "m-transfer", kind: "fact", title: "王总回款", content: "王总跨境电商回款走 Payoneer，账期 30 天。", tags: null, createdAt: new Date(now - 600e3), hitCount: 0 },
];
mod.clearSemanticCache();
const pureProviders = makeProviders({ scoreOf: (item) => (item.id === "m-transfer" ? 90 : 0) });
const pureHandlers = mem.buildMemoryHandlers(makePrisma(rows3), pureProviders);
const pure = await pureHandlers.memory_search({ userId: "u1", params: { query: "他那边结汇走什么渠道", limit: 5 } });
check("纯语义查询（字面零命中）靠候选补齐命中", pure.total > 0 && pure.items[0].id === "m-transfer", pure.items.map((i) => i.id));
check("补齐候选关键词分为 0、语义分为 90", pure.items[0].keywordScore === 0 && pure.items[0].semanticScore === 90, pure.items[0]);
mod.clearSemanticCache();
const pureKwHandlers = mem.buildMemoryHandlers(makePrisma(rows3), makeProviders({ scoreOf: (item) => (item.id === "m-transfer" ? 90 : 0) }));
const pureKw = await pureKwHandlers.memory_search({ userId: "u1", params: { query: "他那边结汇走什么渠道", limit: 5, mode: "keyword" } });
check("mode=keyword 时同查询捞不到（说明语义确实起作用）", pureKw.total === 0, pureKw.total);

console.log((fail === 0 ? "P19 memory-semantic SMOKE OK" : "P19 memory-semantic SMOKE FAILED") + " (" + pass + " checks, " + fail + " failed)");
process.exit(fail === 0 ? 0 : 1);
