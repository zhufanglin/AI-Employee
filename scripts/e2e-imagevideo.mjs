
const API = process.env.FCM_API || "http://127.0.0.1:3000/api";
const fs = await import("node:fs");
async function j(p, init = {}) { const r = await fetch(API + p, init); const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; } return { status: r.status, body: b }; }
const H = (tok) => ({ "content-type": "application/json", authorization: "Bearer " + tok });
const phone = "139" + String(Date.now()).slice(-8);
const s = await j("/auth/sms/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }) });
const l = await j("/auth/sms/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone, code: s.body.devCode }) });
const token = l.body.accessToken || l.body.token;
const userId = l.body.user?.id;
console.log("login", phone, userId);
const al = await j("/auth/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }) });
const atok = al.body.accessToken || al.body.token;
const credit = await j("/admin/users/" + userId + "/credits", { method: "POST", headers: H(atok), body: JSON.stringify({ amount: 800 }) });
console.log("credits", credit.status);

// 1) 文生图
const img = await j("/media/images/generations", { method: "POST", headers: H(token), body: JSON.stringify({ prompt: "A stylish woman in a leather jacket standing on a neon-lit cyberpunk street at night, cinematic lighting, ultra detailed", size: 7 }) });
console.log("image submit", img.status, JSON.stringify(img.body).slice(0, 300));
const imgTask = img.body?.taskId;

async function pollTask(taskId, maxRounds, label) {
  for (let i = 0; i < maxRounds; i++) {
    await new Promise((r) => setTimeout(r, 15000));
    const q = await j("/media/tasks/" + taskId, { headers: H(token) });
    const st = q.body?.status;
    const url = q.body?.resultUrl;
    console.log("[" + label + " " + i + "]", st, url ? String(url).slice(0, 120) : "");
    if (st === "SUCCESS" || st === "FAILED") return q.body;
  }
  return null;
}
let imgRes = null;
if (imgTask) imgRes = await pollTask(imgTask, 40, "image");
console.log("IMAGE_RESULT " + JSON.stringify({ taskId: imgTask, status: imgRes?.status, url: imgRes?.resultUrl }));

// 2) 图生视频
const buf = fs.readFileSync("C:/Users/30290/Desktop/fcmediaagent-replica/_demo/02_secretary.jpg");
const up = await j("/media/files/upload", { method: "POST", headers: H(token), body: JSON.stringify({ fileName: "02_secretary.jpg", mime: "image/jpeg", base64: buf.toString("base64") }) });
const ref = up.body?.fileName || up.body?.url;
console.log("upload", up.status, ref);
const vid = await j("/media/video/generations", { method: "POST", headers: H(token), body: JSON.stringify({ image: ref, prompt: "Time-lapse photography", seconds: 5, aspectRatio: "9:16", version: 2 }) });
console.log("video submit", vid.status, JSON.stringify(vid.body).slice(0, 300));
const vidTask = vid.body?.taskId;
let vidRes = null;
if (vidTask) vidRes = await pollTask(vidTask, 80, "video");
console.log("VIDEO_RESULT " + JSON.stringify({ taskId: vidTask, status: vidRes?.status, url: vidRes?.resultUrl }));
console.log("E2E DONE");
