#!/usr/bin/env node
/**
 * P23 记忆管理 REST（/api/memory/*）单测。
 * 全部用假 prisma / 假 providers / 假 CapabilityService，不连库、不打上游。
 * 用法：先编译 server（tsc -p packages/server/tsconfig.json），再
 *   node scripts/smoke-p23-memory-api.mjs
 */
import { createRequire } from "node:module";
const require2 = createRequire("C:/Users/30290/Desktop/fcmediaagent-replica/packages/server/package.json");
const { MemoryService } = require2("./dist/memory/memory.service.js");
const { MemoryController } = require2("./dist/memory/memory.controller.js");

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log("PASS " + name + (extra !== undefined ? " " + JSON.stringify(extra) : "")); }
  else { fail++; console.log("FAIL " + name + " " + JSON.stringify(extra)); }
}
function thrown(fn) {
  return fn().then(() => null, (e) => e);
}

const now = Date.now();
const HOUR = 3600000;
const DAY = 24 * HOUR;

// ── 通用假 prisma：支持 where/orderBy/take/select/count/groupBy/$transaction ──
function matchWhere(row, where) {
  if (!where) return true;
  for (const [key, val] of Object.entries(where)) {
    if (val === undefined) continue;
    if (key === "OR") {
      if (!val.some((cond) => matchWhere(row, cond))) return false;
      continue;
    }
    if (key === "AND") {
      if (!val.every((cond) => matchWhere(row, cond))) return false;
      continue;
    }
    if (val && typeof val === "object" && !(val instanceof Date)) {
      if (Object.prototype.hasOwnProperty.call(val, "contains")) {
        if (!String(row[key] ?? "").includes(val.contains)) return false;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(val, "in")) {
        if (!val.in.includes(row[key])) return false;
        continue;
      }
      let rangeOk = true;
      const t = row[key] instanceof Date ? row[key].getTime() : new Date(row[key]).getTime();
      if (val.lt !== undefined && !(t < new Date(val.lt).getTime())) rangeOk = false;
      if (val.lte !== undefined && !(t <= new Date(val.lte).getTime())) rangeOk = false;
      if (val.gt !== undefined && !(t > new Date(val.gt).getTime())) rangeOk = false;
      if (val.gte !== undefined && !(t >= new Date(val.gte).getTime())) rangeOk = false;
      if (!rangeOk) return false;
      continue;
    }
    if (row[key] !== val) return false;
  }
  return true;
}

function sortRows(rows, orderBy) {
  const orders = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  return rows.slice().sort((a, b) => {
    for (const order of orders) {
      for (const field of Object.keys(order)) {
        const dir = order[field] === "desc" ? -1 : 1;
        const av = a[field] instanceof Date ? a[field].getTime() : a[field];
        const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
        if (av === bv) continue;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        return av < bv ? -1 * dir : 1 * dir;
      }
    }
    return 0;
  });
}

function project(row, select) {
  if (!select) return { ...row };
  const out = {};
  for (const key of Object.keys(select)) if (select[key]) out[key] = row[key];
  return out;
}

function makePrisma(initial) {
  const list = initial.map((row) => ({ ...row }));
  const state = { updates: [], deletes: [], transactions: 0, inTx: false };
  const filter = (where) => list.filter((row) => matchWhere(row, where));
  const api = {
    findMany: async ({ where, orderBy, take, select } = {}) => {
      let out = sortRows(filter(where), orderBy);
      if (take !== undefined) out = out.slice(0, take);
      return out.map((row) => project(row, select));
    },
    findFirst: async ({ where } = {}) => {
      const row = filter(where)[0];
      return row ? { ...row } : null;
    },
    count: async ({ where } = {}) => filter(where).length,
    groupBy: async ({ by, where } = {}) => {
      const field = Array.isArray(by) ? by[0] : by;
      const counts = new Map();
      for (const row of filter(where)) counts.set(row[field], (counts.get(row[field]) || 0) + 1);
      return Array.from(counts.entries()).map(([value, n]) => ({ [field]: value, _count: { _all: n } }));
    },
    update: async ({ where, data }) => {
      const row = list.find((item) => item.id === where.id);
      if (!row) throw new Error("update 找不到记录 " + where.id);
      Object.assign(row, data);
      row.updatedAt = new Date();
      state.updates.push({ id: where.id, data, inTx: state.inTx });
      return { ...row };
    },
    delete: async ({ where }) => {
      const index = list.findIndex((item) => item.id === where.id);
      if (index < 0) throw new Error("delete 找不到记录 " + where.id);
      const [row] = list.splice(index, 1);
      state.deletes.push({ id: where.id, inTx: state.inTx });
      return { ...row };
    },
    deleteMany: async ({ where } = {}) => {
      const before = list.length;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (matchWhere(list[i], where)) list.splice(i, 1);
      }
      state.deletes.push({ where, removed: before - list.length });
      return { count: before - list.length };
    },
  };
  api.$transaction = async (arg) => {
    if (typeof arg !== "function") throw new Error("本单测只覆盖 $transaction(callback) 形式");
    state.transactions += 1;
    state.inTx = true;
    try {
      return await arg({ agentMemory: api });
    } finally {
      state.inTx = false;
    }
  };
  return { prisma: { agentMemory: api, $transaction: api.$transaction }, state, list };
}

function makeProviders(reply = '{"relation":"different","id":"","merged":""}') {
  const prompts = [];
  const provider = {
    prompts,
    resolve: async (alias) => ({ alias, provider: "ark", baseUrl: "http://fake", apiKey: "k", upstreamModel: alias }),
    chat: async (_target, body) => {
      prompts.push(String(body?.messages?.[0]?.content || ""));
      return { choices: [{ message: { content: reply } }] };
    },
  };
  return provider;
}

function makeCapabilities(data = { mode: "apply", total: 1 }) {
  const calls = [];
  return {
    calls,
    run: async (user, name, params) => {
      calls.push({ user, name, params });
      const next = data instanceof Error ? null : data;
      if (data instanceof Error) throw data;
      if (data && data.__fail) return { success: false, data: null, error: "记忆清理需要语义模型，请检查 MEMORY_SEMANTIC 配置后再试", error_code: "BadRequestException" };
      return { success: true, data: next, error: null };
    },
  };
}

function rsvc(prisma, providers = makeProviders(), capabilities = makeCapabilities()) {
  return new MemoryService(prisma, providers, capabilities);
}

// ── 测试数据 ──
function baseRows() {
  const rows = [
    { id: "m1", userId: "u1", kind: "note", title: "赵姐报价", content: "只接受季度付，报价必须含税", tags: "报价,客户", employeeSlug: "sales", sourceTaskId: null, hitCount: 3, createdAt: new Date(now - 1 * HOUR), updatedAt: new Date(now - 1 * HOUR) },
    { id: "m2", userId: "u1", kind: "fact", title: "报关", content: "报关走宁波港", tags: "报关", employeeSlug: null, sourceTaskId: "t1", hitCount: 0, createdAt: new Date(now - 2 * HOUR), updatedAt: new Date(now - 2 * HOUR) },
    { id: "m3", userId: "u1", kind: "preference", title: "", content: "赵姐偏好微信沟通", tags: null, employeeSlug: null, sourceTaskId: null, hitCount: 0, createdAt: new Date(now - 3 * HOUR), updatedAt: new Date(now - 3 * HOUR) },
    { id: "m4", userId: "u1", kind: "lesson", title: "坑", content: "不要先发货", tags: "报价", employeeSlug: null, sourceTaskId: null, hitCount: 0, createdAt: new Date(now - 4 * HOUR), updatedAt: new Date(now - 4 * HOUR) },
    { id: "m5", userId: "u1", kind: "note", title: "直播排期", content: "下周三直播", tags: "直播,标签A,标签B,标签C,标签D,标签E,标签F,标签G", employeeSlug: null, sourceTaskId: null, hitCount: 0, createdAt: new Date(now - 5 * HOUR), updatedAt: new Date(now - 5 * HOUR) },
  ];
  for (let i = 0; i < 20; i += 1) {
    const at = new Date(now - 6 * HOUR - i * 1000);
    rows.push({ id: "fill" + String(i).padStart(2, "0"), userId: "u1", kind: "note", title: "", content: "填充记忆 " + i, tags: "填充", employeeSlug: null, sourceTaskId: null, hitCount: 0, createdAt: at, updatedAt: at });
  }
  rows.push({ id: "old1", userId: "u1", kind: "lesson", title: "旧事", content: "八天前的老记忆", tags: "旧", employeeSlug: null, sourceTaskId: null, hitCount: 1, createdAt: new Date(now - 8 * DAY), updatedAt: new Date(now - 8 * DAY) });
  rows.push({ id: "u2row", userId: "u2", kind: "note", title: "别人的", content: "越权不该看到", tags: "秘密", employeeSlug: null, sourceTaskId: null, hitCount: 0, createdAt: new Date(now), updatedAt: new Date(now) });
  return rows;
}

const U1 = { id: "u1", phone: "13900000002" };
const U2 = { id: "u2", phone: "13900000003" };

// ── 1. list：默认 limit / 排序 / total / 按用户隔离 ──
{
  const { prisma } = makePrisma(baseRows());
  const svc = rsvc(prisma);
  const page = await svc.list(U1, {});
  check("list：默认 limit=20", page.items.length === 20, page.items.length);
  check("list：total 是该用户全部条数（26）", page.total === 26, page.total);
  check("list：nextCursor 是第 20 条的 id", page.nextCursor === page.items[19].id, page.nextCursor);
  check("list：按 createdAt 倒序", page.items.every((item, i) => i === 0 || new Date(page.items[i - 1].createdAt) >= new Date(item.createdAt)), page.items.slice(0, 3).map((i) => i.id));
  check("list：不返回他人数据", page.items.every((item) => item.id !== "u2row"), page.items.some((i) => i.id === "u2row"));
  check("list：tags 逗号串转数组", Array.isArray(page.items.find((i) => i.id === "m1")?.tags) && page.items.find((i) => i.id === "m1").tags.join("/") === "报价/客户", page.items.find((i) => i.id === "m1")?.tags);
  check("list：空 tags 返回 []", page.items.find((i) => i.id === "m3")?.tags.length === 0, page.items.find((i) => i.id === "m3")?.tags);
  check("list：返回契约字段", ["id", "kind", "title", "content", "tags", "employeeSlug", "sourceTaskId", "hitCount", "createdAt", "updatedAt"].every((k) => k in page.items[0]), Object.keys(page.items[0]));
}

// ── 2. list：cursor 翻页 ──
{
  const { prisma } = makePrisma(baseRows());
  const svc = rsvc(prisma);
  const first = await svc.list(U1, { limit: 10 });
  const second = await svc.list(U1, { limit: 10, cursor: first.nextCursor });
  const third = await svc.list(U1, { limit: 10, cursor: second.nextCursor });
  check("cursor：第二页 10 条", second.items.length === 10, second.items.length);
  check("cursor：第二页 total 仍是全量 26", second.total === 26, second.total);
  check("cursor：两页无重叠", second.items.every((item) => !first.items.some((f) => f.id === item.id)), second.items.map((i) => i.id));
  check("cursor：最后一页 6 条且 nextCursor=null", third.items.length === 6 && third.nextCursor === null, { n: third.items.length, next: third.nextCursor });
  check("cursor：伪造游标按第一页处理", (await svc.list(U1, { limit: 10, cursor: "nope" })).items[0].id === first.items[0].id, first.items[0].id);
  check("cursor：他人 id 不能当游标越界", (await svc.list(U1, { limit: 10, cursor: "u2row" })).items[0].id === first.items[0].id);
}

// ── 3. list：kind / query 过滤 / limit 边界 ──
{
  const { prisma } = makePrisma(baseRows());
  const svc = rsvc(prisma);
  const notes = await svc.list(U1, { kind: "note", limit: 50 });
  check("过滤：kind=note 条数与 total 一致", notes.items.length === notes.total && notes.total === 22, notes.total);
  check("过滤：kind=note 只返回 note", notes.items.every((item) => item.kind === "note"));
  const hit = await svc.list(U1, { query: "宁波港" });
  check("过滤：query 命中 content（1 条）", hit.items.length === 1 && hit.items[0].id === "m2", hit.items.map((i) => i.id));
  const tagHit = await svc.list(U1, { query: "报价", limit: 50 });
  check("过滤：query 同时命中 title/content/tags", tagHit.items.length === 2 && tagHit.items.some((i) => i.id === "m1") && tagHit.items.some((i) => i.id === "m4"), tagHit.items.map((i) => i.id));
  const all = await svc.list(U1, { limit: 999 });
  check("limit：超上限钳到 50", all.items.length === 26 && all.nextCursor === null, all.items.length);
  const one = await svc.list(U1, { limit: 0 });
  check("limit：下限钳到 1", one.items.length === 1, one.items.length);
  const badKind = await thrown(() => svc.list(U1, { kind: "other" }));
  check("过滤：非法 kind 报 400 文案", !!badKind && badKind.message === "kind 只能是 note/fact/preference/lesson", badKind?.message);
}

// ── 4. stats ──
{
  const { prisma } = makePrisma(baseRows());
  const svc = rsvc(prisma);
  const stats = await svc.stats(U1);
  check("stats：total=26", stats.total === 26, stats.total);
  check("stats：byKind 四类齐全且计数正确", stats.byKind.note === 22 && stats.byKind.fact === 1 && stats.byKind.preference === 1 && stats.byKind.lesson === 2, stats.byKind);
  check("stats：last7d=25（排除 8 天前那条）", stats.last7d === 25, stats.last7d);
  check("stats：topTags 最多 8 个", stats.topTags.length === 8, stats.topTags.length);
  check("stats：topTags 首位是出现最多的标签", stats.topTags[0].tag === "填充" && stats.topTags[0].count === 20, stats.topTags[0]);
  check("stats：topTags 按次数降序", stats.topTags.every((item, i) => i === 0 || stats.topTags[i - 1].count >= item.count), stats.topTags.map((t) => [t.tag, t.count]));
}

// ── 5. delete：权限边界 ──
{
  const { prisma, list, state } = makePrisma(baseRows());
  const svc = rsvc(prisma);
  const ok = await svc.remove(U1, "m1");
  check("delete：删除自己的记忆返回 success/id", ok.success === true && ok.id === "m1", ok);
  check("delete：记录真的消失", !list.some((row) => row.id === "m1"));
  check("delete：只删了自己的目标", list.some((row) => row.id === "u2row") && state.deletes.length === 1, list.length);
  const other = await thrown(() => svc.remove(U1, "u2row"));
  check("delete：删他人记忆 404 + 契约文案", !!other && other.getStatus?.() === 404 && other.message === "记忆不存在或不属于你", other?.message);
  const missing = await thrown(() => svc.remove(U1, "nope"));
  check("delete：不存在 404", !!missing && missing.getStatus?.() === 404, missing?.message);
  const empty = await thrown(() => svc.remove(U1, ""));
  check("delete：空 id 400", !!empty && empty.getStatus?.() === 400, empty?.message);
}

// ── 6. merge：保留更早、拼接正文、标签并集、命中求和、事务 ──
function mergeRows() {
  return [
    { id: "older", userId: "u1", kind: "note", title: "赵姐报价", content: "旧正文：季度付", tags: "报价,客户", employeeSlug: null, sourceTaskId: null, hitCount: 2, createdAt: new Date(now - 10 * HOUR), updatedAt: new Date(now - 10 * HOUR) },
    { id: "newer", userId: "u1", kind: "note", title: "赵姐账期", content: "新正文：账期 60 天", tags: "客户,账期", employeeSlug: null, sourceTaskId: null, hitCount: 3, createdAt: new Date(now - 1 * HOUR), updatedAt: new Date(now - 1 * HOUR) },
    { id: "u2row", userId: "u2", kind: "note", title: "别人的", content: "不该合并", tags: "", employeeSlug: null, sourceTaskId: null, hitCount: 9, createdAt: new Date(now - 2 * HOUR), updatedAt: new Date(now - 2 * HOUR) },
  ];
}
{
  const { prisma, list, state } = makePrisma(mergeRows());
  const svc = rsvc(prisma);
  // 故意传反：keepId 传较晚的，也要保留较早那条
  const res = await svc.merge(U1, { keepId: "newer", dropId: "older" });
  check("merge：以 createdAt 更早的为准（返回 older）", res.id === "older", res.id);
  check("merge：正文退化为两者拼接并截断", res.content === "旧正文：季度付\n新正文：账期 60 天", res.content);
  check("merge：tags 并集去重", Array.isArray(res.tags) && res.tags.join(",") === "报价,客户,账期", res.tags);
  check("merge：hitCount 求和", res.hitCount === 5, res.hitCount);
  check("merge：mergedFrom 是被删除的 id", res.mergedFrom.length === 1 && res.mergedFrom[0] === "newer", res.mergedFrom);
  check("merge：未用 LLM 时 usedLlm=false", res.usedLlm === false, res.usedLlm);
  check("merge：落库 update keep + delete drop", list.some((row) => row.id === "older") && !list.some((row) => row.id === "newer"), list.map((r) => r.id));
  check("merge：保留条 title 取 keep", list.find((r) => r.id === "older")?.title === "赵姐报价", list.find((r) => r.id === "older")?.title);
  check("merge：两步在同一 $transaction", state.transactions === 1 && state.updates.length === 1 && state.deletes.length === 1 && state.updates[0].inTx === true && state.deletes[0].inTx === true, { tx: state.transactions, updates: state.updates.length, deletes: state.deletes.length, inTx: [state.updates[0]?.inTx, state.deletes[0]?.inTx] });
  check("merge：不碰他人数据", list.some((row) => row.id === "u2row"));
}
{
  const { prisma } = makePrisma(mergeRows());
  const svc = rsvc(prisma);
  const same = await thrown(() => svc.merge(U1, { keepId: "older", dropId: "older" }));
  check("merge：keepId=dropId 400 + 契约文案", !!same && same.getStatus?.() === 400 && same.message === "keepId 与 dropId 不能相同", same?.message);
  const cross = await thrown(() => svc.merge(U1, { keepId: "older", dropId: "u2row" }));
  check("merge：他人记忆 404", !!cross && cross.getStatus?.() === 404 && cross.message === "记忆不存在或不属于你", cross?.message);
  const missing = await thrown(() => svc.merge(U1, { keepId: "older", dropId: "nope" }));
  check("merge：不存在 404", !!missing && missing.getStatus?.() === 404, missing?.message);
  const noKeep = await thrown(() => svc.merge(U1, { dropId: "newer" }));
  check("merge：缺 keepId 400", !!noKeep && noKeep.getStatus?.() === 400, noKeep?.message);
}

// ── 7. merge：LLM 合并结果被采用 / title 回退 / 标签超长截断 ──
{
  const { prisma, list } = makePrisma(mergeRows());
  const providers = makeProviders('{"relation":"merge","id":"newer","merged":"赵姐：季度付、含税，账期 60 天"}');
  const svc = rsvc(prisma, providers);
  const res = await svc.merge(U1, { keepId: "older", dropId: "newer" });
  check("merge-LLM：relation=merge 且有 merged 时采用模型正文", res.usedLlm === true && res.content === "赵姐：季度付、含税，账期 60 天", { usedLlm: res.usedLlm, content: res.content });
  check("merge-LLM：判定输入是 keep.content + drop 候选", providers.prompts.length === 1 && providers.prompts[0].includes("旧正文：季度付") && providers.prompts[0].includes("新正文：账期 60 天") && providers.prompts[0].includes('"id":"newer"'), providers.prompts[0]?.slice(0, 60));
}
{
  const rows = mergeRows();
  rows[0].title = null;
  const { prisma, list } = makePrisma(rows);
  const svc = rsvc(prisma, makeProviders('{"relation":"merge","id":"newer","merged":""}'));
  const res = await svc.merge(U1, { keepId: "older", dropId: "newer" });
  check("merge：模型 relation=merge 但无 merged → usedLlm=false 且拼接", res.usedLlm === false && res.content.includes("旧正文") && res.content.includes("新正文"), { usedLlm: res.usedLlm, content: res.content });
  check("merge：keep.title 为空时回退 drop.title", list.find((r) => r.id === "older")?.title === "赵姐账期", list.find((r) => r.id === "older")?.title);
}
{
  const longA = "甲".repeat(300) + "," + "乙".repeat(100);
  const longB = "丙".repeat(300) + ",乙".repeat(20);
  const rows = [
    { id: "older", userId: "u1", kind: "note", title: "长标签", content: "A", tags: longA, employeeSlug: null, sourceTaskId: null, hitCount: 0, createdAt: new Date(now - 2 * HOUR), updatedAt: new Date(now - 2 * HOUR) },
    { id: "newer", userId: "u1", kind: "note", title: "长标签2", content: "B", tags: longB, employeeSlug: null, sourceTaskId: null, hitCount: 0, createdAt: new Date(now - HOUR), updatedAt: new Date(now - HOUR) },
  ];
  const { prisma } = makePrisma(rows);
  const svc = rsvc(prisma);
  const res = await svc.merge(U1, { keepId: "older", dropId: "newer" });
  check("merge：tags 并集总长 ≤512", res.tags.join(",").length <= 512 && res.tags.length >= 1, res.tags.join(",").length);
  check("merge：标签去重（乙 不重复）", res.tags.filter((t) => t === "乙".repeat(100)).length <= 1);
}

// ── 8. dedupe：委托参数与错误 ──
{
  const { prisma } = makePrisma(mergeRows());
  const caps = makeCapabilities({ mode: "apply", total: 0, scanned: 0, calls: 0, applied: 0, truncated: false, durationMs: 1, proposals: [] });
  const svc = rsvc(prisma, makeProviders(), caps);
  const data = await svc.dedupe(U1, {});
  check("dedupe：缺省 mode=apply / limit=30", caps.calls.length === 1 && caps.calls[0].name === "memory_dedupe" && caps.calls[0].params.mode === "apply" && caps.calls[0].params.limit === 30, caps.calls[0]?.params);
  check("dedupe：委托用户是当前用户", caps.calls[0].user.id === "u1" && !("phone" in caps.calls[0].user), caps.calls[0]?.user);
  check("dedupe：原样返回能力 data", !!(data && data.mode === "apply" && Array.isArray(data.proposals)), data);
  await svc.dedupe(U1, { mode: "report", limit: 5 });
  check("dedupe：显式 report/limit 透传", caps.calls[1].params.mode === "report" && caps.calls[1].params.limit === 5, caps.calls[1]?.params);
  await svc.dedupe(U1, { mode: "apply", limit: 999 });
  check("dedupe：limit 超上限钳到 60", caps.calls[2].params.limit === 60, caps.calls[2]?.params);
  const badMode = await thrown(() => svc.dedupe(U1, { mode: "wipe" }));
  check("dedupe：非法 mode 400", !!badMode && badMode.getStatus?.() === 400 && badMode.message === "mode 只能是 report 或 apply", badMode?.message);
  const badLimit = await thrown(() => svc.dedupe(U1, { limit: 0 }));
  check("dedupe：非法 limit 400", !!badLimit && badLimit.getStatus?.() === 400 && badLimit.message === "limit 必须是正整数", badLimit?.message);
  const capsFail = makeCapabilities({ __fail: true });
  const svcFail = rsvc(prisma, makeProviders(), capsFail);
  const err = await thrown(() => svcFail.dedupe(U1, {}));
  check("dedupe：能力失败转 400 并带后端文案", !!err && err.getStatus?.() === 400 && err.message.includes("记忆清理需要语义模型"), err?.message);
}

// ── 9. controller 路由委托 ──
{
  const seen = [];
  const fake = {
    list: async (...args) => { seen.push(["list", ...args]); return "LIST"; },
    stats: async (...args) => { seen.push(["stats", ...args]); return "STATS"; },
    remove: async (...args) => { seen.push(["remove", ...args]); return "REMOVE"; },
    merge: async (...args) => { seen.push(["merge", ...args]); return "MERGE"; },
    dedupe: async (...args) => { seen.push(["dedupe", ...args]); return "DEDUPE"; },
  };
  const ctrl = new MemoryController(fake);
  const req = { user: U1 };
  check("controller：list 传 req.user + query", (await ctrl.list(req, { limit: "5" })) === "LIST" && seen[0][1] === U1 && seen[0][2].limit === "5");
  check("controller：stats 传 req.user", (await ctrl.stats(req)) === "STATS" && seen[1][1] === U1);
  check("controller：delete 传 :id", (await ctrl.remove(req, "m1")) === "REMOVE" && seen[2][1] === U1 && seen[2][2] === "m1");
  check("controller：merge/dedupe 传 body", (await ctrl.merge(req, { keepId: "a", dropId: "b" })) === "MERGE" && (await ctrl.dedupe(req, { mode: "report" })) === "DEDUPE" && seen[3][2].keepId === "a" && seen[4][2].mode === "report");
}

console.log("");
if (fail) { console.log("P23 memory-api SMOKE FAILED (" + pass + " checks, " + fail + " failed)"); process.exit(1); }
console.log("P23 memory-api SMOKE OK (" + pass + " checks, 0 failed)");
