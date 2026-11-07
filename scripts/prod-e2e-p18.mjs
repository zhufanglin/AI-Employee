#!/usr/bin/env node
/** 生产端到端 P18：先让员工记一条客户偏好，再换任务问它，确认 memory_save / memory_search 被真实调用。 */
const BASE = process.env.FCM_API_BASE || "http://127.0.0.1:3000/api";
const PHONE = process.env.FCM_PHONE || "13900000002";
const SLUG = process.env.FCM_SLUG || "boss-lead-radar";
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

async function runTask(prompt, label) {
  const created = await call("/employees/" + SLUG + "/run", { method: "POST", body: JSON.stringify({ input: prompt }) });
  const task = created.body && (created.body.task || created.body.data || created.body);
  const id = task && (task.id || task.taskId);
  console.log("[" + label + "] 创建任务", created.status, id);
  if (!id) { console.log(JSON.stringify(created.body).slice(0, 400)); return null; }
  const started = Date.now();
  let last = "";
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setTimeout(r, 6000));
    const got = await call("/employee-tasks/" + id);
    const t = got.body && (got.body.task || got.body.data || got.body);
    const status = t && t.status;
    const step = JSON.stringify((t && (t.steps || t.events)) || "").slice(0, 300);
    if (status + step !== last) { console.log("[" + label + " " + Math.round((Date.now() - started) / 1000) + "s] " + status + " " + step); last = status + step; }
    if (["completed", "failed", "awaiting_approval", "needs_input", "cancelled"].includes(status)) {
      const text = t.outputText || "";
      console.log("[" + label + "] 最终状态:", status, "秒:", Math.round((Date.now() - started) / 1000));
      console.log("[" + label + "] 产出:", text.slice(0, 500));
      console.log("[" + label + "] 全量含 memory_ ?", JSON.stringify(t).includes("memory_"));
      return { status, text, raw: t };
    }
  }
  console.log("[" + label + "] TIMEOUT");
  return null;
}

const TAG = "客户李阿姨" + Date.now().toString().slice(-4);
const first = await runTask("请把这个客户偏好记到长期记忆里：客户名 " + TAG + "，喜欢微信语音沟通，报价只接受季度付，家里两个孩子分别上小学三年级和初一。记完回我一句确认。", "记住");
const second = await runTask("我上次让你记的 " + TAG + " 这个客户的沟通偏好和家庭情况是什么？请从长期记忆里查，原样告诉我。", "回忆");
const okSave = !!first && JSON.stringify(first.raw).includes("memory_save");
const okSearch = !!second && JSON.stringify(second.raw).includes("memory_search") && !!second.text && second.text.includes("季度");
console.log("memory_save 被调用:", okSave, " memory_search 被调用:", okSearch);
console.log(okSave && okSearch ? "P18 E2E GREEN" : "P18 E2E RED");
process.exit(okSave && okSearch ? 0 : 1);
