#!/usr/bin/env node
/** 探测：生产上游模型是否支持图片输入（image_url）。 */
const BASE = process.env.FCM_API_BASE || "http://127.0.0.1:3000/api";
const PHONE = process.env.FCM_PHONE || "13900000002";
let token = "";
async function call(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { ...options, headers });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}
for (let i = 0; i < 3; i += 1) {
  const sent = await call("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone: PHONE }) });
  const code = sent.body && (sent.body.devCode || (sent.body.data && sent.body.data.devCode));
  if (code) {
    const res = await call("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone: PHONE, code }) });
    const access = res.body && (res.body.accessToken || res.body.token || (res.body.data && res.body.data.accessToken));
    if (access) { token = access; break; }
  }
  await new Promise((r) => setTimeout(r, 62000));
}
if (!token) throw new Error("登录失败");

const { execFileSync } = await import("node:child_process");
const fs = await import("node:fs");
execFileSync("/usr/bin/ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=red:s=200x120:d=1", "-frames:v", "1", "/tmp/vision-probe.jpg"], { stdio: "ignore" });
const jpg = fs.readFileSync("/tmp/vision-probe.jpg");
const up = await call("/workspace/upload", { method: "POST", body: JSON.stringify({ name: "vision-probe.jpg", base64: jpg.toString("base64") }) });
const url = up.body && up.body.url;
console.log("上传:", up.status, url);
if (!url) process.exit(1);

const models = ["doubao-seed-2.0-pro", "doubao-seed-2.0-lite"];
for (const model of models) {
  const res = await call("/compute/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: [{ type: "text", text: "这张图是什么颜色？只回答颜色。" }, { type: "image_url", image_url: { url } }] }],
    }),
  });
  const text = res.body && res.body.choices && res.body.choices[0] && res.body.choices[0].message && res.body.choices[0].message.content;
  console.log(model, "status=" + res.status, "->", String(text || JSON.stringify(res.body)).slice(0, 200));
}
