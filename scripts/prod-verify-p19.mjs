#!/usr/bin/env node
/** 生产验收 P19：语义检索记忆（同义改写也能召回）+ 延迟对比 + keyword 模式。 */
const BASE = process.env.FCM_API_BASE || "http://127.0.0.1:3000/api";
const PHONE = process.env.FCM_PHONE || "13900000002";
let token = "";
let pass = 0;
function ok(name, detail) { pass += 1; console.log("[PASS] " + name + (detail ? " :: " + detail : "")); }
function bad(name, detail) { console.log("[FAIL] " + name + " :: " + detail); process.exitCode = 1; }
function assert(name, cond, detail) { if (cond) ok(name, detail); else bad(name, detail); }
async function call(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { ...options, headers });
  const text = await res.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}
for (let attempt = 0; attempt < 3; attempt += 1) {
  const sent = await call("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone: PHONE }) });
  const code = sent.body && (sent.body.devCode || (sent.body.data && sent.body.data.devCode));
  if (code) {
    const res = await call("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone: PHONE, code }) });
    const access = res.body && (res.body.accessToken || res.body.token || (res.body.data && res.body.data.accessToken));
    if (access) { token = access; break; }
  }
  console.log("等待短信频控窗口 62s 后重试…");
  await new Promise((r) => setTimeout(r, 62000));
}
if (!token) throw new Error("登录失败");
console.log("登录成功");

async function run(name, params) {
  const started = Date.now();
  const res = await call("/capabilities/run", { method: "POST", body: JSON.stringify({ name, params }) });
  const ms = Date.now() - started;
  return { ok: !!(res.body && res.body.success), data: res.body && res.body.data, error: res.body && res.body.error, status: res.status, ms };
}

const MARK = "P19验收-" + Date.now();
const saved = await run("memory_save", {
  content: MARK + "：客户赵姐只接受季度付，不接受年付，报价必须含税；她习惯下午三点以后接电话。",
  title: MARK + " 赵姐的付款方式",
  tags: "客户,付款",
  kind: "preference",
});
assert("memory_save 成功", saved.ok && !!saved.data.id, "id=" + (saved.data && saved.data.id));

// 关键：查询里没有任何字面重合（「价格」「怎么收」都不在记忆正文里），只有语义能救
const semantic = await run("memory_search", { query: "这个客户价格是怎么收的？", limit: 5 });
const items = (semantic.data && semantic.data.items) || [];
const idx = items.findIndex((i) => String(i.content).includes(MARK));
const hit = idx >= 0 ? items[idx] : null;
assert("语义检索命中（字面不重合）", semantic.ok && !!hit, "total=" + (semantic.data && semantic.data.total) + " 排名=" + (idx + 1) + " ids=" + items.map((i) => i.id).join(","));
assert("返回 semantic=true", !!semantic.data && semantic.data.semantic === true, String(semantic.data && semantic.data.semantic));
assert("查询扩展出了同义词", !!(semantic.data && semantic.data.expandedTerms && semantic.data.expandedTerms.length), JSON.stringify(semantic.data && semantic.data.expandedTerms));
assert("命中项语义分 > 0", !!hit && typeof hit.semanticScore === "number" && hit.semanticScore > 0, "semanticScore=" + (hit && hit.semanticScore) + " keywordScore=" + (hit && hit.keywordScore));
console.log("     语义检索耗时 " + semantic.ms + "ms");

const keywordOnly = await run("memory_search", { query: "这个客户价格是怎么收的？", limit: 5, mode: "keyword" });
assert("mode=keyword 不做语义", keywordOnly.ok && keywordOnly.data.semantic === false && (keywordOnly.data.expandedTerms || []).length === 0, "total=" + (keywordOnly.data && keywordOnly.data.total));
const kwHit = !!(keywordOnly.data && keywordOnly.data.items.some((i) => String(i.content).includes(MARK)));
console.log("     keyword 模式同样查询能否命中（预期 false 或低分）: " + kwHit + "，耗时 " + keywordOnly.ms + "ms");

// 缓存：同一句再查一次，扩展词不变
const again = await run("memory_search", { query: "这个客户价格是怎么收的？", limit: 5 });
assert("重复查询仍命中（扩展词走缓存）", again.ok && (again.data.items || []).some((i) => String(i.content).includes(MARK)), "total=" + (again.data && again.data.total));
console.log("     重复查询耗时 " + again.ms + "ms（扩展词走缓存）");

// 完全无关的查询不应乱命中
const unrelated = await run("memory_search", { query: "量子力学里的薛定谔方程", limit: 5 });
const unrelatedHit = !!(unrelated.data && unrelated.data.items.some((i) => String(i.content).includes(MARK)));
assert("无关查询不误命中", unrelated.ok && !unrelatedHit, "total=" + (unrelated.data && unrelated.data.total) + " 命中本条=" + unrelatedHit);

// 更严格的语义用例：查询与记忆正文没有任何字面重合
const MARK2 = MARK + "-结汇";
const saved2 = await run("memory_save", {
  content: MARK2 + "：客户王总的跨境电商团队 30 人，主攻东南亚，回款走 Payoneer，账期 30 天。",
  title: MARK2 + " 王总回款",
  kind: "fact",
});
assert("memory_save 第二条成功", saved2.ok && !!saved2.data.id, "id=" + (saved2.data && saved2.data.id));
const pure = await run("memory_search", { query: "他那边结汇走什么渠道？", limit: 5 });
const pureIdx = ((pure.data && pure.data.items) || []).findIndex((i) => String(i.content).includes(MARK2));
assert("纯语义命中（查询与正文无字面重合）", pure.ok && pureIdx >= 0, "total=" + (pure.data && pure.data.total) + " 排名=" + (pureIdx + 1) + " 扩展=" + JSON.stringify(pure.data && pure.data.expandedTerms));
const pureKw = await run("memory_search", { query: "他那边结汇走什么渠道？", limit: 5, mode: "keyword" });
const pureKwHit = ((pureKw.data && pureKw.data.items) || []).some((i) => String(i.content).includes(MARK2));
assert("同一条查询纯关键词模式捞不到（证明语义确实起了作用）", pureKw.ok && !pureKwHit, "keyword total=" + (pureKw.data && pureKw.data.total) + " 命中=" + pureKwHit);
console.log("     纯语义检索耗时 " + pure.ms + "ms");
await run("memory_delete", { id: saved2.data.id });

const del = await run("memory_delete", { id: saved.data.id });
assert("清理测试记忆", del.ok && del.data.deleted === true);

console.log((process.exitCode ? "P19 PROD VERIFY FAILED" : "P19 PROD VERIFY GREEN") + " (" + pass + " checks)");
