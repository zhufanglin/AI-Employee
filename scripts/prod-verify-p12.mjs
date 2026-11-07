#!/usr/bin/env node
/** 生产验收 P12：上传 xlsx → workspace/files → doc_read 解析；file_write → file_list → file_read 往返。 */
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
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
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
      console.log("login response:", JSON.stringify(res.body).slice(0, 200));
    }
    console.log("等待短信频控窗口 62s 后重试…");
    await new Promise((r) => setTimeout(r, 62000));
  }
  throw new Error("登录失败：拿不到 devCode/accessToken");
}

async function makeXlsx() {
  const XLSX = await import("/opt/fcmediaagent/app/node_modules/xlsx/xlsx.mjs");
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([["客户", "手机号", "意向"], ["张三", "13800000000", "高"], ["李四", "13900000000", "中"]]);
  XLSX.utils.book_append_sheet(book, sheet, "客户线索");
  return Buffer.from(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
}

const NAME = "P12验收-客户线索.xlsx";

await login();
console.log("登录成功，开始验收");

// 1) 上传资料
const upload = await call("/workspace/upload", { method: "POST", body: JSON.stringify({ name: NAME, base64: (await makeXlsx()).toString("base64") }) });
assert("上传 xlsx 成功", upload.status === 201 || upload.status === 200, "status=" + upload.status);
const key = upload.body && upload.body.key;
assert("上传返回工作区 key", typeof key === "string" && key.startsWith("workspace/"), String(key));

// 2) 列表能看到
const listed = await call("/workspace/files?limit=50");
const names = (listed.body && listed.body.items || []).map((i) => i.name);
assert("资料列表包含上传文件", names.includes(NAME), names.slice(0, 5).join(","));

// 3) doc_read 解析 Excel
const parsed = await call("/capabilities/run", { method: "POST", body: JSON.stringify({ name: "doc_read", params: { name: NAME } }) });
const parsedData = parsed.body && parsed.body.data;
const parsedText = parsedData && parsedData.text || "";
assert("doc_read 成功", parsed.status === 201 || parsed.status === 200, "status=" + parsed.status);
assert("doc_read 读到工作表内容", parsedText.includes("客户线索") && parsedText.includes("张三"), parsedText.slice(0, 60));

// 4) file_write → file_list → file_read
const written = await call("/capabilities/run", { method: "POST", body: JSON.stringify({ name: "file_write", params: { name: "P12验收-交付.md", content: "# 交付\n- 结论 A\n- 结论 B" } }) });
const wdata = written.body && written.body.data;
assert("file_write 成功", !!(wdata && wdata.key), JSON.stringify(written.body).slice(0, 120));
const relist = await call("/workspace/files?limit=50");
const rnames = (relist.body && relist.body.items || []).map((i) => i.name);
assert("file_list 包含新交付物", rnames.includes("P12验收-交付.md"), rnames.slice(0, 6).join(","));
const readBack = await call("/capabilities/run", { method: "POST", body: JSON.stringify({ name: "file_read", params: { name: "P12验收-交付.md" } }) });
const rtext = (readBack.body && readBack.body.data && readBack.body.data.text) || "";
assert("file_read 按 name 读回内容", rtext.includes("结论 B"), rtext.slice(0, 60));

// 5) 清理
await call("/workspace/delete", { method: "POST", body: JSON.stringify({ name: NAME }) });
await call("/workspace/delete", { method: "POST", body: JSON.stringify({ name: "P12验收-交付.md" }) });
const after = await call("/workspace/files?limit=1");
ok("清理完成", "剩余文件数=" + ((after.body && after.body.total) ?? "?"));

if (process.exitCode) console.log("PROD P12 VERIFY FAILED (" + pass + " checks passed)");
else console.log("PROD P12 VERIFY OK (" + pass + " checks)");