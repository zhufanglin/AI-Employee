#!/usr/bin/env node
/** 生产验收 P18：长期记忆 save / search / list / delete。 */
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
async function login() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sent = await call("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone: PHONE }) });
    const code = sent.body && (sent.body.devCode || (sent.body.data && sent.body.data.devCode));
    if (code) {
      const res = await call("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone: PHONE, code }) });
      const access = res.body && (res.body.accessToken || res.body.token || (res.body.data && res.body.data.accessToken));
      if (access) { token = access; return; }
    }
    console.log("等待短信频控窗口 62s 后重试…");
    await new Promise((r) => setTimeout(r, 62000));
  }
  throw new Error("登录失败");
}
async function run(name, params) {
  const res = await call("/capabilities/run", { method: "POST", body: JSON.stringify({ name, params }) });
  return { status: res.status, data: res.body && res.body.data, body: res.body, ok: !!(res.body && res.body.success) };
}

await login();
console.log("登录成功，开始 P18 生产验收");

const MARK = "P18验收-" + Date.now();
const saved = await run("memory_save", { content: MARK + "：客户王女士偏好微信语音沟通，报价按季度给，不接受年付。", title: MARK + " 客户偏好", tags: "客户,偏好", kind: "preference" });
const memId = saved.data && saved.data.id;
assert("memory_save 成功", saved.ok && !!memId, "status=" + saved.status + " id=" + memId + " " + JSON.stringify(saved.body).slice(0, 200));

const searched = await run("memory_search", { query: MARK + " 客户" });
assert("memory_search 命中", searched.ok && searched.data && searched.data.total >= 1, "total=" + (searched.data && searched.data.total));
assert("命中内容是刚写的", !!(searched.data && searched.data.items.some((i) => i.content.includes(MARK))), JSON.stringify(searched.data && searched.data.items.map((i) => i.title)).slice(0, 200));
assert("命中带打分", !!(searched.data && typeof searched.data.items[0].score === "number"), String(searched.data && searched.data.items[0] && searched.data.items[0].score));

const listed = await run("memory_list", { limit: 20 });
assert("memory_list 含新记忆", listed.ok && listed.data && listed.data.items.some((i) => i.id === memId), "total=" + (listed.data && listed.data.total));

const miss = await run("memory_search", { query: "根本不存在的关键词xyzzy" + MARK });
assert("无命中返回 0", miss.ok && miss.data && miss.data.total === 0, "total=" + (miss.data && miss.data.total));

const del = await run("memory_delete", { id: memId });
assert("memory_delete 成功", del.ok && del.data && del.data.deleted === true, JSON.stringify(del.body).slice(0, 160));
const afterDel = await run("memory_search", { query: MARK });
assert("删除后搜不到", afterDel.ok && afterDel.data && afterDel.data.total === 0, "total=" + (afterDel.data && afterDel.data.total));

const empty = await run("memory_save", {});
assert("content 缺失被拒", !empty.ok && /content/.test(String(empty.body && empty.body.error)), "error=" + (empty.body && empty.body.error));

console.log((process.exitCode ? "P18 PROD VERIFY FAILED" : "P18 PROD VERIFY GREEN") + " (" + pass + " checks)");
