
const API = process.env.FCM_API || "http://127.0.0.1:3000/api";
const fs = await import("node:fs");
async function j(p, init = {}) { const r = await fetch(API + p, init); const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; } return { status: r.status, body: b }; }
const H = (tok) => ({ "content-type": "application/json", authorization: "Bearer " + tok });
const phone = "139" + String(Date.now()).slice(-8);
const s = await j("/auth/sms/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }) });
const l = await j("/auth/sms/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone, code: s.body.devCode }) });
const token = l.body.accessToken || l.body.token;
const userId = l.body.user?.id;
const al = await j("/auth/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }) });
const atok = al.body.accessToken || al.body.token;
await j("/admin/users/" + userId + "/credits", { method: "POST", headers: H(atok), body: JSON.stringify({ amount: 2000 }) });
console.log("login", phone, userId);
const p = "C:/Users/30290/Desktop/部署文件/_extract/0.4.29/app/resources/resources/installer/cards/02_secretary.jpg";
const buf = fs.readFileSync(p);
const up = await j("/media/files/upload", { method: "POST", headers: H(token), body: JSON.stringify({ fileName: "02_secretary.jpg", mime: "image/jpeg", base64: buf.toString("base64") }) });
console.log("upload", up.status, JSON.stringify(up.body).slice(0, 160));
const imageRef = up.body.fileName;
const m = await j("/compose-videos", { method: "POST", headers: H(token), body: JSON.stringify({ composeType: "mixcut", image: imageRef, prompt: "制作15秒高冲击人物卡点混剪，15个分镜，参考图中可识别的脸型、五官比例、发型轮廓、服装设计、配饰和标志性配色，主标题为“The Dream Girl”", seconds: 15 }) });
console.log("mixcut submit", m.status, JSON.stringify(m.body).slice(0, 400));
const id = m.body?.id;
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  const cv = await j("/compose-videos", { headers: H(token) });
  const rows = (cv.body.rows || cv.body || []).filter((r) => r.id === id);
  const row = rows[0];
  console.log("[poll " + i + "]", row ? JSON.stringify({ s: row.status, v: row.videoUrl }) : "none");
  if (row && !["composing", "cloning_audio", "pending"].includes(row.status)) { console.log("FINAL " + JSON.stringify(row).slice(0, 600)); break; }
}
console.log("DONE");
