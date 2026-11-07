#!/usr/bin/env node
/** 生产端到端 P16：让真实员工跑一条需要 xlsx 交付的任务，确认模型自主调用 doc_write。 */
const BASE = process.env.FCM_API_BASE || "http://127.0.0.1:3000/api";
const PHONE = process.env.FCM_PHONE || "13900000002";
const SLUG = process.env.FCM_SLUG || "boss-lead-radar";
const PROMPT = process.env.FCM_PROMPT || "把下周三场直播的排期整理成一张 Excel 表（列：日期、时间、主题、负责人），用 doc_write 生成 .xlsx 交付，最后告诉我文件名和下载链接。";
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
for (let attempt = 0; attempt < 3; attempt += 1) {
  const sent = await call("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone: PHONE }) });
  const code = sent.body && (sent.body.devCode || (sent.body.data && sent.body.data.devCode));
  if (code) {
    const res = await call("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone: PHONE, code }) });
    const access = res.body && (res.body.accessToken || res.body.token || (res.body.data && res.body.data.accessToken));
    if (access) { token = access; break; }
  }
  console.log("等 62s 重试登录…");
  await new Promise((r) => setTimeout(r, 62000));
}
if (!token) throw new Error("登录失败");
console.log("登录成功");

const created = await call("/employees/" + SLUG + "/run", { method: "POST", body: JSON.stringify({ input: PROMPT }) });
const task = created.body && (created.body.task || created.body.data || created.body);
const id = task && (task.id || task.taskId);
console.log("创建任务", created.status, id);
if (!id) { console.log(JSON.stringify(created.body).slice(0, 400)); process.exit(1); }

const started = Date.now();
let last = "";
for (let i = 0; i < 100; i += 1) {
  await new Promise((r) => setTimeout(r, 6000));
  const got = await call("/employee-tasks/" + id);
  const t = got.body && (got.body.task || got.body.data || got.body);
  const status = t && t.status;
  const step = JSON.stringify(t && (t.steps || t.events) || "").slice(0, 260);
  if (status + step !== last) {
    console.log("[" + Math.round((Date.now() - started) / 1000) + "s] " + status + " " + step);
    last = status + step;
  }
  if (["completed", "failed", "awaiting_approval", "needs_input", "cancelled"].includes(status)) {
    const text = t.outputText || "";
    const artifacts = t.artifacts || [];
    console.log("最终状态:", status, "秒:", Math.round((Date.now() - started) / 1000));
    console.log("产出文字:", text.slice(0, 600));
    console.log("附件:", JSON.stringify(artifacts).slice(0, 600));
    const usedDocWrite = JSON.stringify(t).includes("doc_write") || JSON.stringify(artifacts).includes(".xlsx") || text.includes(".xlsx");
    console.log(usedDocWrite ? "P16 E2E GREEN（doc_write 被真实调用）" : "P16 E2E RED（未见 doc_write 痕迹）");
    process.exit(usedDocWrite ? 0 : 1);
  }
}
console.log("P16 E2E TIMEOUT");
process.exit(1);
