#!/usr/bin/env node
/** 验证 P13 决定：OSS 产出文件恢复公网直链（file_write / upload 都返回可匿名访问的 URL）。 */
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
    console.log("等待短信频控 62s …");
    await new Promise((r) => setTimeout(r, 62000));
  }
  throw new Error("登录失败");
}
const stamp = new Date().toISOString();
await login();
console.log("登录成功");

const wrote = await call("/capabilities/run", { method: "POST", body: JSON.stringify({ name: "file_write", params: { name: "p13-public-url.md", content: "# P13 公网直链自测 " + stamp + "\n" } }) });
const w = wrote.body && wrote.body.data;
assert("file_write 成功", wrote.body && wrote.body.success === true, "status=" + wrote.status);
assert("file_write 返回 OSS 公网 URL", typeof (w && w.url) === "string" && w.url.startsWith("https://"), String(w && w.url));
if (w && w.url) {
  const anon = await fetch(w.url);
  const text = await anon.text();
  assert("匿名匿名访问 OSS 直链 200", anon.status === 200, "status=" + anon.status);
  assert("直链内容包含本次标记", text.includes("P13 公网直链自测"), text.slice(0, 60));
}

const listed = await call("/capabilities/run", { method: "POST", body: JSON.stringify({ name: "file_list", params: { limit: 5 } }) });
const items = (listed.body && listed.body.data && listed.body.data.items) || [];
const hit = items.find((i) => i.name === "p13-public-url.md");
assert("file_list 里该文件也带公网 url", !!hit && typeof hit.url === "string" && hit.url.startsWith("https://"), String(hit && hit.url));

const up = await call("/workspace/upload", { method: "POST", body: JSON.stringify({ name: "p13-upload.txt", base64: Buffer.from("P13 upload " + stamp).toString("base64") }) });
const u = up.body || {};
assert("上传接口返回 url", typeof u.url === "string" && u.url.startsWith("https://"), String(u.url));
if (u.url) {
  const anon2 = await fetch(u.url);
  assert("上传文件匿名可读", anon2.status === 200, "status=" + anon2.status);
}

console.log("PROD P13 PUBLIC URL VERIFY OK (" + pass + " checks)");