#!/usr/bin/env node
/** 生产验收 P16：web_batch / doc_write(xlsx+docx) / media_info+trim+thumbnail / file_delete。 */
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
    }
    console.log("等待短信频控窗口 62s 后重试…");
    await new Promise((r) => setTimeout(r, 62000));
  }
  throw new Error("登录失败");
}

async function run(name, params) {
  const res = await call("/capabilities/run", { method: "POST", body: JSON.stringify({ name, params }) });
  return { status: res.status, data: res.body && res.body.data, body: res.body };
}

await login();
console.log("登录成功，开始 P16 生产验收");

// 1) web_batch
const batch = await run("web_batch", { urls: "https://example.com,https://www.runninghub.cn", maxChars: 1200 });
assert("web_batch 调用成功", batch.status === 200 || batch.status === 201, "status=" + batch.status);
assert("web_batch 抓到至少 1 条", !!batch.data && batch.data.ok >= 1, "ok=" + (batch.data && batch.data.ok));
assert("web_batch 返回标题", !!batch.data && batch.data.items.some((i) => i.title), JSON.stringify(batch.data && batch.data.items.map((i) => i.title)));

// 2) doc_write xlsx
const xlsx = await run("doc_write", { format: "xlsx", name: "P16验收-排期表", title: "排期", sheets: [{ name: "本周排期", rows: [["日期", "内容", "负责人"], ["11-08", "选题会", "张三"], ["11-09", "拍摄", "李四"]] }] });
assert("doc_write xlsx 成功", (xlsx.status === 200 || xlsx.status === 201) && !!xlsx.data, "status=" + xlsx.status + " " + JSON.stringify(xlsx.body).slice(0, 160));
assert("xlsx 落盘字节数 > 0", !!xlsx.data && xlsx.data.bytes > 1000, "bytes=" + (xlsx.data && xlsx.data.bytes));
assert("xlsx 返回下载链接", !!xlsx.data && typeof xlsx.data.url === "string" && xlsx.data.url.startsWith("http"), xlsx.data && xlsx.data.url);
if (xlsx.data && xlsx.data.url) {
  const dl = await fetch(xlsx.data.url);
  assert("xlsx 公链可下载", dl.status === 200, "status=" + dl.status);
}

// 3) doc_write docx
const docx = await run("doc_write", { format: "docx", name: "P16验收-方案", title: "活动方案", content: "# 活动方案\n\n## 一、目标\n- 拉新 200 人\n- 复购率提升 10%\n\n## 二、预算\n\n| 项目 | 金额 |\n| --- | --- |\n| 达人 | 5000 |\n| 投放 | 8000 |" });
assert("doc_write docx 成功", (docx.status === 200 || docx.status === 201) && !!docx.data, "status=" + docx.status + " " + JSON.stringify(docx.body).slice(0, 160));
assert("docx 落盘字节数 > 0", !!docx.data && docx.data.bytes > 3000, "bytes=" + (docx.data && docx.data.bytes));
assert("docx 段落数 >= 5", !!docx.data && docx.data.paragraphs >= 5, "paragraphs=" + (docx.data && docx.data.paragraphs));

// 4) media：上传 2 秒 mp4 → media_info → trim → thumbnail
const { execFileSync } = await import("node:child_process");
const fs = await import("node:fs");
const tmp = "/tmp/p16-verify.mp4";
execFileSync("/usr/bin/ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", tmp], { stdio: "ignore" });
const mp4 = fs.readFileSync(tmp);
const up = await call("/workspace/upload", { method: "POST", body: JSON.stringify({ name: "P16验收-素材.mp4", base64: mp4.toString("base64") }) });
assert("上传 mp4 成功", up.status === 200 || up.status === 201, "status=" + up.status + " size=" + mp4.length);

const info = await run("media_info", { source: "P16验收-素材.mp4" });
assert("media_info 成功", (info.status === 200 || info.status === 201) && !!info.data, "status=" + info.status + " " + JSON.stringify(info.body).slice(0, 160));
assert("media_info 读到时长为 2 秒", !!info.data && Math.abs((info.data.durationSec || 0) - 2) < 0.6, "duration=" + (info.data && info.data.durationSec));
assert("media_info 读到 320x240", !!info.data && info.data.video && info.data.video.width === 320 && info.data.video.height === 240, JSON.stringify(info.data && info.data.video));

const trim = await run("media_process", { op: "trim", source: "P16验收-素材.mp4", start: 0, duration: 1 });
assert("media_process trim 成功", (trim.status === 200 || trim.status === 201) && !!trim.data, "status=" + trim.status + " " + JSON.stringify(trim.body).slice(0, 160));
const thumb = await run("media_process", { op: "thumbnail", source: "P16验收-素材.mp4", time: 1 });
assert("media_process thumbnail 成功", (thumb.status === 200 || thumb.status === 201) && !!thumb.data, "status=" + thumb.status + " " + JSON.stringify(thumb.body).slice(0, 160));

// 5) file_delete
const before = await call("/workspace/files?limit=50");
const beforeNames = (before.body && before.body.items || []).map((i) => i.name);
assert("删除前列表含素材", beforeNames.includes("P16验收-素材.mp4"), beforeNames.slice(0, 4).join(","));
const del = await run("file_delete", { name: "P16验收-素材.mp4" });
assert("file_delete 成功", (del.status === 200 || del.status === 201) && !!del.data, "status=" + del.status + " " + JSON.stringify(del.body).slice(0, 160));
const after = await call("/workspace/files?limit=50");
const afterNames = (after.body && after.body.items || []).map((i) => i.name);
assert("删除后列表不含素材", !afterNames.includes("P16验收-素材.mp4"), afterNames.slice(0, 4).join(","));

console.log("");
console.log("P16 PROD VERIFY " + (process.exitCode ? "RED" : "GREEN") + " (" + pass + " checks)");
