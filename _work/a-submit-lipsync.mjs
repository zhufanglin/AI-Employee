// A 线配套：用软件「数字人对口型」把 58.7s 口播渲染成人物口播素材（576，整段）
import fs from "node:fs";

const API = process.env.FCM_API || "http://127.0.0.1:3000/api";
const IMG = "C:/Users/30290/Desktop/数字人/第一阶段/人物参考_重截.png";
const AUD = "C:/Users/30290/Desktop/数字人/素材包/音频/新录音 17.m4a";

async function j(p, init = {}) {
  const r = await fetch(API + p, init);
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, body: b };
}
const H = (tok) => ({ "content-type": "application/json", authorization: "Bearer " + tok });

const phone = "139" + String(Date.now()).slice(-8);
const s = await j("/auth/sms/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }) });
const l = await j("/auth/sms/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone, code: s.body.devCode }) });
const token = l.body.accessToken || l.body.token;
const userId = l.body.user?.id;
const al = await j("/auth/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }) });
const atok = al.body.accessToken || al.body.token;
await j("/admin/users/" + userId + "/credits", { method: "POST", headers: H(atok), body: JSON.stringify({ amount: 3000 }) });
console.log("login", phone, userId);

async function up(path, name, mime) {
  const buf = fs.readFileSync(path);
  const r = await j("/media/files/upload", { method: "POST", headers: H(token), body: JSON.stringify({ fileName: name, mime, base64: buf.toString("base64") }) });
  const ref = r.body.fileName || r.body.openapiFileName;
  console.log("upload", name, r.status, ref);
  if (!ref) throw new Error("upload failed " + JSON.stringify(r.body).slice(0, 200));
  return ref;
}
const imgRef = await up(IMG, "person-ref.png", "image/png");
const audRef = await up(AUD, "voice-17.m4a", "audio/mp4");

const c = await j("/compose-videos", {
  method: "POST", headers: H(token),
  body: JSON.stringify({
    composeType: "lipsync",
    videoUrl: imgRef,
    sourceAudioUrl: audRef,
    seconds: 59,
    resolution: "576",
    fps: 25,
    prompt: "人物面对镜头自然说话，表情平和，口型与音频同步，保持人物相貌，镜头固定。",
    title: "精密模塑口播-数字人58s",
  }),
});
console.log("lipsync submit", c.status, JSON.stringify(c.body).slice(0, 400));
fs.writeFileSync("C:/Users/30290/Desktop/fcmediaagent-replica/_work/a-task.json", JSON.stringify({ token, userId, phone, id: c.body?.id, at: Date.now() }, null, 2));
