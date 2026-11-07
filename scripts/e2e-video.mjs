
const API = process.env.FCM_API || "http://127.0.0.1:3000/api";
const fs = await import("node:fs");
async function j(p, init = {}) { const r = await fetch(API + p, init); const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; } return { status: r.status, body: b }; }
const H = (tok) => ({ "content-type": "application/json", authorization: "Bearer " + tok });
const phone = "139" + String(Date.now()).slice(-8);
const s = await j("/auth/sms/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }) });
if (!s.body?.devCode) { console.log("sms failed", JSON.stringify(s.body)); process.exit(0); }
const l = await j("/auth/sms/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone, code: s.body.devCode }) });
const token = l.body.accessToken || l.body.token;
const userId = l.body.user?.id;
const al = await j("/auth/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }) });
const atok = al.body.accessToken || al.body.token;
await j("/admin/users/" + userId + "/credits", { method: "POST", headers: H(atok), body: JSON.stringify({ amount: 800 }) });
console.log("login", phone, userId);

const buf = fs.readFileSync("packages/server/uploads/media/2118385394257321986.jpg");
const up = await j("/media/files/upload", { method: "POST", headers: H(token), body: JSON.stringify({ fileName: "firstframe.jpg", mime: "image/jpeg", base64: buf.toString("base64") }) });
const ref = up.body?.fileName || up.body?.url;
console.log("upload", up.status, ref);
const vid = await j("/media/video/generations", { method: "POST", headers: H(token), body: JSON.stringify({ image: ref, prompt: "Time-lapse photography", seconds: 5, aspectRatio: "9:16", version: 2 }) });
console.log("video submit", vid.status, JSON.stringify(vid.body).slice(0, 300));
const vidTask = vid.body?.taskId;
let res = null;
for (let i = 0; i < 90 && vidTask; i++) {
  await new Promise((r) => setTimeout(r, 15000));
  const q = await j("/media/tasks/" + vidTask, { headers: H(token) });
  console.log("[video " + i + "]", q.body?.status, q.body?.resultUrl ? String(q.body.resultUrl).slice(0, 110) : "");
  if (q.body?.status === "SUCCESS" || q.body?.status === "FAILED") { res = q.body; break; }
}
console.log("VIDEO_RESULT " + JSON.stringify({ taskId: vidTask, status: res?.status, url: res?.resultUrl }));
