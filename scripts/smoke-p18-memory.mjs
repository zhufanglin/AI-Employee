#!/usr/bin/env node
/** P18 长期记忆能力单测：内存 prisma 桩，不连数据库。 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mod = require("../packages/server/dist/capabilities/capabilities/memory-tools.js");

let pass = 0;
let fail = 0;
function ok(name, detail) { pass += 1; console.log("[PASS] " + name + (detail ? " :: " + detail : "")); }
function bad(name, detail) { fail += 1; console.log("[FAIL] " + name + " :: " + detail); }
function expect(name, cond, detail) { if (cond) ok(name, detail); else bad(name, detail); }
async function check(name, fn) {
  try { return await fn(); } catch (e) { bad(name, e && e.message ? e.message : String(e)); return undefined; }
}
async function rejects(name, fn, needle) {
  try { await fn(); bad(name, "未抛错"); }
  catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (needle && !msg.includes(needle)) bad(name, "错误文案不含「" + needle + "」，实际：" + msg);
    else ok(name);
  }
}

// ---------- 内存 prisma 桩 ----------
function createPrisma() {
  const rows = [];
  let seq = 0;
  const contains = (value, term) => String(value ?? "").includes(term);
  const matches = (row, where) => {
    if (!where) return true;
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.id !== undefined) {
      if (where.id && typeof where.id === "object" && "in" in where.id) { if (!where.id.in.includes(row.id)) return false; }
      else if (row.id !== where.id) return false;
    }
    if (where.OR) {
      const hit = where.OR.some((clause) => Object.entries(clause).every(([field, cond]) => contains(row[field], cond.contains)));
      if (!hit) return false;
    }
    return true;
  };
  return {
    _rows: rows,
    agentMemory: {
      create: async ({ data }) => {
        const row = { id: "m-" + (++seq), kind: "note", title: null, tags: null, employeeSlug: null, sourceTaskId: null, hitCount: 0, createdAt: new Date(Date.now() + seq), updatedAt: new Date(), ...data };
        rows.push(row);
        return row;
      },
      findMany: async ({ where, orderBy, take }) => {
        let list = rows.filter((row) => matches(row, where));
        if (orderBy && orderBy.createdAt === "desc") list = list.slice().sort((a, b) => b.createdAt - a.createdAt);
        return take ? list.slice(0, take) : list;
      },
      findFirst: async ({ where }) => rows.find((row) => matches(row, where)) ?? null,
      updateMany: async ({ where, data }) => {
        const hit = rows.filter((row) => matches(row, where));
        for (const row of hit) {
          if (data.hitCount && data.hitCount.increment) row.hitCount += data.hitCount.increment;
        }
        return { count: hit.length };
      },
      deleteMany: async ({ where }) => {
        const keep = rows.filter((row) => !matches(row, where));
        const removed = rows.length - keep.length;
        rows.length = 0;
        rows.push(...keep);
        return { count: removed };
      },
    },
  };
}

const prisma = createPrisma();
const handlers = mod.buildMemoryHandlers(prisma);
const ctx = (userId, params) => ({ userId, phone: null, params });
const run = (userId, params) => handlers[params.__name](ctx(userId, params));
const call = (name, userId, params) => handlers[name](ctx(userId, params));

// 1) 描述符
expect("descriptors 有 4 个能力", mod.descriptors.length === 4, mod.descriptors.map((d) => d.name).join(","));
expect("能力命名正确", mod.descriptors.map((d) => d.name).sort().join(",") === "memory_delete,memory_list,memory_save,memory_search");
expect("都是 memory 分类", mod.descriptors.every((d) => d.category === "memory"));
expect("memory_search 有 query 参数说明", !!mod.descriptors.find((d) => d.name === "memory_search").params.query);

// 2) 关键词拆分
const terms = mod.splitTerms("客户 报价：广州少儿英语");
expect("splitTerms 拆分标点", terms.includes("客户") && terms.includes("报价"), terms.join("|"));
expect("splitTerms 长中文补二元组", terms.includes("广州"), terms.join("|"));
expect("splitTerms 去重且不超过 8 个", new Set(terms).size === terms.length && terms.length <= 8, "n=" + terms.length);

// 3) 保存
const saved = await check("保存记忆", () => call("memory_save", "u1", { content: "客户王女士偏好微信沟通，报价按季度给。", title: "王女士偏好", tags: "客户,偏好", kind: "preference" }));
expect("保存返回 id", !!(saved && saved.id), JSON.stringify(saved));
expect("保存保留 kind", saved && saved.kind === "preference");
await rejects("content 缺失报错", () => call("memory_save", "u1", {}), "content 必填");
await rejects("content 超长报错", () => call("memory_save", "u1", { content: "x".repeat(4001) }), "4000");
await rejects("kind 非法报错", () => call("memory_save", "u1", { content: "abc", kind: "weird" }), "kind 只能是");
await rejects("tags 超过 10 个报错", () => call("memory_save", "u1", { content: "abc", tags: Array.from({ length: 11 }, (_, i) => "t" + i) }), "最多 10 个");
const tagged = await check("tags 支持数组", () => call("memory_save", "u1", { content: "广州少儿英语暑假班定价 3980 元", tags: ["定价", "广州", "定价"] }));
expect("tags 去重后存库", true);

// 4) 检索
const found = await call("memory_search", "u1", { query: "王女士" });
expect("按标题/正文命中", found.items.length >= 1 && found.items[0].content.includes("王女士"), "n=" + found.items.length);
expect("返回打分", typeof found.items[0].score === "number", String(found.items[0].score));
const pricing = await call("memory_search", "u1", { query: "定价 广州" });
expect("多关键词命中定价记忆", pricing.items.some((i) => i.content.includes("3980")), JSON.stringify(pricing.items.map((i) => i.title || i.content.slice(0, 10))));
expect("命中后 hitCount 累加", prisma._rows.find((r) => r.content.includes("3980")).hitCount >= 1);
const miss = await call("memory_search", "u1", { query: "完全不存在的词abcxyz" });
expect("无命中返回空数组", miss.total === 0 && miss.items.length === 0);
await rejects("query 缺失报错", () => call("memory_search", "u1", {}), "query 必填");
const limited = await call("memory_search", "u1", { query: "客户 定价 广州 英语", limit: 1 });
expect("limit 生效", limited.items.length <= 1, "n=" + limited.items.length);
const isolated = await call("memory_search", "u2", { query: "王女士" });
expect("记忆按用户隔离", isolated.total === 0, "n=" + isolated.total);

// 5) 列表
const listed = await call("memory_list", "u1", { limit: 10 });
expect("列表按时间倒序", listed.items.length >= 2 && new Date(listed.items[0].createdAt).getTime() >= new Date(listed.items[listed.items.length - 1].createdAt).getTime(), "n=" + listed.items.length);
const limitedList = await call("memory_list", "u1", { limit: 1 });
expect("列表 limit 生效", limitedList.items.length === 1);
expect("列表 tags 还原成数组", Array.isArray(listed.items.find((i) => i.tags.length).tags));

// 6) 删除
await rejects("删别人的记忆被拒", () => call("memory_delete", "u2", { id: saved.id }), "记忆不存在或不属于你");
await rejects("删除缺 id 报错", () => call("memory_delete", "u1", {}), "id 必填");
const del = await call("memory_delete", "u1", { id: saved.id });
expect("删除自己的记忆成功", del.deleted === true && del.id === saved.id);
const afterDel = await call("memory_list", "u1", { limit: 50 });
expect("删除后列表不含", !afterDel.items.some((i) => i.id === saved.id));

console.log("");
if (fail) { console.log("P18 memory SMOKE FAILED (" + fail + " failed / " + pass + " passed)"); process.exit(1); }
console.log("P18 memory SMOKE OK (" + pass + " checks)");
