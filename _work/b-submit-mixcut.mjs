// B 线：走本地复刻服务「智能混剪」= RunningHub smart_clip（9:16，15 秒）
import fs from "node:fs";

const API = process.env.FCM_API || "http://127.0.0.1:3000/api";
const IMG = "C:/Users/30290/Desktop/数字人/素材包/人物/runninghub-first-frame.png";

async function j(p, init = {}) {
  const r = await fetch(API + p, init);
  const t = await r.text();
  let b;
  try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, body: b };
}
const H = (tok) => ({ "content-type": "application/json", authorization: "Bearer " + tok });

const phone = "139" + String(Date.now()).slice(-8);
const s = await j("/auth/sms/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }) });
const l = await j("/auth/sms/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone, code: s.body.devCode }) });
const token = l.body.accessToken || l.body.token;
const userId = l.body.user?.id;
console.log("login", phone, "user", userId);
if (!token) { console.log("LOGIN FAIL", JSON.stringify(s.body), JSON.stringify(l.body)); process.exit(1); }

const al = await j("/auth/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }) });
const atok = al.body.accessToken || al.body.token;
if (atok && userId) {
  const g = await j("/admin/users/" + userId + "/credits", { method: "POST", headers: H(atok), body: JSON.stringify({ amount: 2000 }) });
  console.log("grant credits", g.status);
}

const buf = fs.readFileSync(IMG);
const up = await j("/media/files/upload", { method: "POST", headers: H(token), body: JSON.stringify({ fileName: "runninghub-first-frame.png", mime: "image/png", base64: buf.toString("base64") }) });
console.log("upload", up.status, JSON.stringify(up.body).slice(0, 200));
const imageRef = up.body.fileName || up.body.openapiFileName || up.body.name;
if (!imageRef) process.exit(1);

const prompt = [
  "制作15秒高冲击企业宣传卡点混剪，15个分镜。",
  "严格参考图中人物的脸型、五官比例、发型轮廓、服装设计与标志性配色，人物贯穿全片。",
  "内容：精密模具与注塑一体化工厂——注塑机自动换模、CNC精密加工、三坐标检测、精密模架与成品特写、工程师沟通、客户验厂。",
  "画面风格：真实工厂纪实 + 高端企业宣传片，冷白工业光，快速卡点转场，浅景深特写。",
  "主标题「精密模塑 一体化」，副标题「从设计到量产 一次做对」。",
].join("");

const m = await j("/compose-videos", {
  method: "POST",
  headers: H(token),
  body: JSON.stringify({ composeType: "mixcut", image: imageRef, prompt, seconds: 15, aspectRatio: "9:16 (Portrait)", megapixels: 0.9, title: "精密模塑一体化-混剪15s" }),
});
console.log("mixcut submit", m.status, JSON.stringify(m.body).slice(0, 500));
fs.writeFileSync("C:/Users/30290/Desktop/fcmediaagent-replica/_work/b-task.json", JSON.stringify({ token, userId, phone, id: m.body?.id, status: m.status, submittedAt: Date.now() }, null, 2));
