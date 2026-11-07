// 生产验收：登录 → 充值 → 对话 → 能力层 → 文生图 → 图生视频
import fs from "node:fs";

const BASE = process.env.FCM_API || "https://ai.fcmediaagent.com/api";
const PHONE = process.env.FCM_PHONE || "13900139000";
const ADMIN_USER = process.env.FCM_ADMIN_USER || "admin";
const ADMIN_PASS = process.env.FCM_ADMIN_PASS || "";
const OUT = process.env.FCM_OUT || "docs/handoff/acceptance-prod.json";
const report = { at: new Date().toISOString(), base: BASE, steps: [] };
const log = (k, v) => { report.steps.push({ step: k, at: new Date().toISOString(), ...v }); console.log("[" + k + "]", JSON.stringify(v).slice(0, 400)); };

async function call(path, init = {}) {
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
const jpost = (path, data, token) => call(path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(data) });
const jget = (path, token) => call(path, { headers: token ? { authorization: "Bearer " + token } : {} });

async function waitTask(taskId, token, label, maxMs = 900000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await new Promise(r => setTimeout(r, 15000));
    const r = await jget("/media/tasks/" + taskId, token);
    const s = r.body?.status;
    console.log("  " + label + " poll", s, Math.round((Date.now() - t0) / 1000) + "s");
    if (s === "SUCCESS" || s === "FAILED") return { status: s, task: r.body, seconds: Math.round((Date.now() - t0) / 1000) };
  }
  return { status: "TIMEOUT", seconds: Math.round((Date.now() - t0) / 1000) };
}

try {
  // 1) 登录（生产 allowlist 手机号会返回 devCode）
  const sent = await jpost("/auth/sms/send", { phone: PHONE });
  log("sms-send", { status: sent.status, devCode: sent.body?.devCode ? "yes" : "no" });
  const code = sent.body?.devCode;
  if (!code) throw new Error("生产未返回 devCode（该手机号不在 DEV_SMS_ALLOWLIST）");
  const login = await jpost("/auth/sms/login", { phone: PHONE, code });
  const token = login.body?.accessToken || login.body?.token;
  if (!token) throw new Error("登录失败：" + JSON.stringify(login.body).slice(0, 200));
  log("login", { status: login.status, user: login.body?.user?.phone, credits: login.body?.user?.credits });

  // 2) 管理员登录 + 给该账号充值（验收用）
  if (ADMIN_PASS) {
    const a = await jpost("/auth/admin/login", { username: ADMIN_USER, password: ADMIN_PASS });
    const atoken = a.body?.accessToken || a.body?.token;
    if (!atoken) throw new Error("管理员登录失败：" + JSON.stringify(a.body).slice(0, 200));
    const users = await jget("/admin/users?keyword=" + encodeURIComponent(PHONE) + "&limit=5", atoken);
    const list = users.body?.items || users.body?.data || users.body;
    const me = Array.isArray(list) ? list.find(u => u.phone === PHONE) : null;
    if (!me) throw new Error("管理端找不到该用户");
    const bal0 = await jget("/credits/balance", token);
    const need = Math.max(0, 400 - (bal0.body?.balance || 0));
    if (need > 0) {
      const g = await jpost("/admin/users/" + me.id + "/credits", { amount: need }, atoken);
      log("admin-grant", { status: g.status, amount: need });
    }
    log("admin", { found: me.phone, before: bal0.body?.balance });
  } else {
    log("admin", { skipped: "no admin password" });
  }

  // 3) 对话
  const t0 = Date.now();
  const chat = await jpost("/compute/chat/completions", { model: "doubao-seed-2.0-lite", messages: [{ role: "user", content: "用一句话说明你是做什么的。" }], stream: false }, token);
  log("chat", { status: chat.status, ms: Date.now() - t0, text: (chat.body?.choices?.[0]?.message?.content || "").slice(0, 120), usage: chat.body?.usage?.total_tokens });

  // 4) 能力层
  const cap = await jpost("/capabilities/run", { name: "web_extract", params: { url: "https://example.com", maxChars: 400 } }, token);
  log("capability", { status: cap.status, ok: cap.body?.success, len: (cap.body?.data?.text || "").length });

  // 5) 文生图
  const img = await jpost("/media/images/generations", { prompt: "极简商务风：深色背景上的金色几何标志，产品发布会主视觉", size: 7 }, token);
  const imgTask = img.body?.taskId;
  if (!imgTask) throw new Error("文生图提交失败：" + JSON.stringify(img.body).slice(0, 300));
  log("image-submit", { status: img.status, taskId: imgTask, estimatedAmount: img.body?.estimatedAmount });
  const imgDone = await waitTask(imgTask, token, "image");
  log("image-done", { status: imgDone.status, seconds: imgDone.seconds, resultUrl: imgDone.task?.resultUrl, coins: imgDone.task?.resultMeta?.usage?.consumeCoins });
  report.image = { taskId: imgTask, url: imgDone.task?.resultUrl, seconds: imgDone.seconds, status: imgDone.status };

  // 6) 图生视频（用刚生成的图当首帧）
  if (imgDone.status === "SUCCESS" && imgDone.task?.resultUrl) {
    const bin = await fetch(imgDone.task.resultUrl);
    const buf = Buffer.from(await bin.arrayBuffer());
    const up = await jpost("/media/files/upload", { fileName: "acceptance-seed.jpg", mime: "image/jpeg", base64: buf.toString("base64") }, token);
    const fileName = up.body?.fileName || up.body?.data?.fileName;
    log("image-upload", { status: up.status, fileName, size: buf.length });
    const vid = await jpost("/media/video/generations", { image: fileName, prompt: "Slow cinematic zoom on the logo, subtle golden light", seconds: 5, aspectRatio: "9:16" }, token);
    const vidTask = vid.body?.taskId;
    if (!vidTask) throw new Error("图生视频提交失败：" + JSON.stringify(vid.body).slice(0, 300));
    log("video-submit", { status: vid.status, taskId: vidTask, estimatedAmount: vid.body?.estimatedAmount });
    const vidDone = await waitTask(vidTask, token, "video");
    log("video-done", { status: vidDone.status, seconds: vidDone.seconds, resultUrl: vidDone.task?.resultUrl, coins: vidDone.task?.resultMeta?.usage?.consumeCoins });
    report.video = { taskId: vidTask, url: vidDone.task?.resultUrl, seconds: vidDone.seconds, status: vidDone.status };
  }

  const bal = await jget("/credits/balance", token);
  log("balance", bal.body);
  report.ok = report.steps.every(s => !["FAILED", "TIMEOUT"].includes(s.status));
} catch (e) {
  report.ok = false;
  report.error = String(e?.message || e);
  console.log("ERROR:", report.error);
}
fs.mkdirSync("docs/handoff", { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
console.log("RESULT " + (report.ok ? "PASS" : "FAIL") + " → " + OUT);
process.exit(report.ok ? 0 : 1);
