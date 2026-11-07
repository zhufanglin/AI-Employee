#!/usr/bin/env node
/** 生产验收：配置 TAVILY_API_KEY 后 web_search 是否真的返回结果。 */
const BASE = process.env.FCM_API_BASE || "http://127.0.0.1:3000/api";
const PHONE = process.env.FCM_PHONE || "13900000002";
let token = ""; let pass = 0;
function ok(n, d) { pass += 1; console.log("[PASS] " + n + (d ? " :: " + d : "")); }
function bad(n, d) { console.log("[FAIL] " + n + " :: " + d); process.exitCode = 1; }
function assert(n, c, d) { if (c) ok(n, d); else bad(n, d); }
async function call(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { ...options, headers });
  const text = await res.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}
async function login() {
  for (let i = 0; i < 3; i += 1) {
    const sent = await call("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone: PHONE }) });
    const code = sent.body && (sent.body.devCode || (sent.body.data && sent.body.data.devCode));
    if (code) {
      const res = await call("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone: PHONE, code }) });
      const access = res.body && (res.body.accessToken || res.body.token || (res.body.data && res.body.data.accessToken));
      if (access) { token = access; return; }
    }
    console.log("等待短信频控 65s …");
    await new Promise((r) => setTimeout(r, 65000));
  }
  throw new Error("登录失败");
}
await login();
console.log("登录成功");

const t0 = Date.now();
const res = await call("/capabilities/run", { method: "POST", body: JSON.stringify({ name: "web_search", params: { query: "2026年社区团购行业趋势", maxResults: 3 } }) });
const ms = Date.now() - t0;
const body = res.body || {};
assert("web_search 返回 success", body.success === true, "status=" + res.status + " ms=" + ms);
const data = body.data || {};
assert("provider 为 tavily", data.provider === "tavily", String(data.provider));
const results = data.results || data.items || [];
assert("返回至少 1 条结果", Array.isArray(results) && results.length > 0, "count=" + results.length);
if (Array.isArray(results) && results.length) {
  const first = results[0];
  console.log("首条：", JSON.stringify(first).slice(0, 300));
  assert("首条含 title 与 url", !!first.title && !!first.url, first.title);
  assert("摘要非空", !!(first.snippet || first.content), String((first.snippet || first.content || "")).slice(0, 60));
}

const bad2 = await call("/capabilities/run", { method: "POST", body: JSON.stringify({ name: "web_search", params: { query: "" } }) });
assert("空 query 被拒", bad2.body && bad2.body.success === false, JSON.stringify(bad2.body).slice(0, 120));

console.log("PROD TAVILY SEARCH VERIFY OK (" + pass + " checks)");