#!/usr/bin/env node
/** 生产验收 P20：记忆自动去重/合并 + 多轮追问改写。 */
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

const MARK = "P20验收-" + Date.now();
const NAME = "客户龙哥" + String(Date.now()).slice(-4);

// 1) 第一条记忆
const first = await run("memory_save", {
  content: MARK + "：客户" + NAME + "只接受半年付，不接受月付；报关走宁波港，账期 45 天。",
  title: MARK + " " + NAME + "的合作条件",
  tags: "客户,付款",
  kind: "preference",
});
const id1 = first.data && first.data.id;
assert("memory_save 新增成功", first.ok && !!id1 && first.data.action === "created", "id=" + id1 + " action=" + (first.data && first.data.action) + " " + first.ms + "ms");

// 2) 同义重写再存一次：应判为重复，不新增
const dup = await run("memory_save", {
  content: NAME + "那边结账只做半年一付，月付他不接受；出口报关口岸是宁波港，账期四十五天。",
  tags: "付款",
  kind: "preference",
});
// 完全同义时模型可能判 duplicate、也可能判 merge（把两段措辞合成一段），产品要求是「不要写第二条」，两者都算通过
assert("同义重复不新增（duplicate/merged）", dup.ok && (dup.data.action === "duplicate" || dup.data.action === "merged"), "action=" + (dup.data && dup.data.action) + " id=" + (dup.data && dup.data.id) + " " + dup.ms + "ms");
assert("重复记忆复用原 id", dup.ok && dup.data.id === id1, "dupId=" + (dup.data && dup.data.id) + " firstId=" + id1);

// 3) 同一客户补充新事实：应合并进原记忆
const merge = await run("memory_save", {
  content: MARK + "：补充——" + NAME + "从 12 月起把账期改为 60 天，其他条件不变。",
  title: MARK + " " + NAME + "账期变更",
  kind: "fact",
});
assert("同主题新事实被合并", merge.ok && merge.data.action === "merged", "action=" + (merge.data && merge.data.action) + " " + merge.ms + "ms");
assert("合并后仍是原记忆 id", merge.ok && merge.data.id === id1, "mergeId=" + (merge.data && merge.data.id) + " firstId=" + id1);

const afterMerge = await run("memory_search", { query: NAME + "的付款和账期条件", limit: 5 });
const mergedItem = ((afterMerge.data && afterMerge.data.items) || []).find((i) => i.id === id1);
assert("合并后一条记忆里同时有旧事实与新事实", !!mergedItem && mergedItem.content.includes("半年付") && /60\s*天/.test(mergedItem.content), mergedItem ? mergedItem.content.slice(0, 120) : "未命中");

// 4) 完全不同的记忆照常新增
const other = await run("memory_save", { content: MARK + "：下周三全员例会改到下午四点，会议室 A。", title: MARK + " 例会", kind: "note" });
assert("无关记忆正常新增", other.ok && other.data.action === "created" && !!other.data.id, "action=" + (other.data && other.data.action));

// 5) dedupe=off 不查重（允许手工重复写入）
const offId = (await run("memory_save", {
  content: NAME + "只接受半年付，报关走宁波港，账期 45 天。",
  dedupe: "off",
})).data.id;
const offRow = await run("memory_list", { limit: 20 });
const offCount = ((offRow.data && offRow.data.items) || []).filter((i) => String(i.content).includes(NAME + "只接受半年付")).length;
assert("dedupe=off 允许重复新增", !!offId && offId !== id1 && offCount >= 1, "offId=" + offId + " count=" + offCount);

// 6) 多轮追问改写：查询只有代词，靠 context 才能检索
const rewritten = await run("memory_search", {
  query: "那她那边账期怎么改的？",
  context: "用户：" + NAME + "这个客户现在怎么结算？\n助手：" + NAME + "是半年付，报关走宁波港。",
  limit: 5,
});
const rwItems = (rewritten.data && rewritten.data.items) || [];
assert("追问被改写（rewritten 非空）", rewritten.ok && typeof rewritten.data.rewritten === "string" && rewritten.data.rewritten.length > 0, "rewritten=" + (rewritten.data && rewritten.data.rewritten));
assert("effectiveQuery 与原文不同", !!rewritten.data && rewritten.data.effectiveQuery !== rewritten.data.query, "effective=" + (rewritten.data && rewritten.data.effectiveQuery));
assert("改写后仍能查到该客户记忆", rwItems.some((i) => i.id === id1 || String(i.content).includes(NAME)), "total=" + (rewritten.data && rewritten.data.total) + " " + rewritten.ms + "ms");

// 7) 不带 context 的追问不做改写（保持 P19 行为，也不会把代词当查询乱查）
const noCtx = await run("memory_search", { query: "那她呢", limit: 3 });
assert("无 context 不改写", noCtx.ok && noCtx.data.rewritten === null, "rewritten=" + (noCtx.data && noCtx.data.rewritten));

// 8) 清理
const cleanup = [];
for (const id of [id1, other.data && other.data.id, offId]) {
  if (!id) continue;
  const del = await run("memory_delete", { id });
  cleanup.push(!!(del.ok && del.data.deleted));
}
assert("清理测试记忆", cleanup.every(Boolean), cleanup.join(","));

console.log((process.exitCode ? "P20 PROD VERIFY FAILED" : "P20 PROD VERIFY GREEN") + " (" + pass + " checks)");
