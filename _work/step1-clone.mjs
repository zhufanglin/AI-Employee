// 第一步：克隆人 + 声音克隆
// 输入：一张照片 + 一段音频样本 + 一段文稿
// 输出：克隆音色口播（indextts）→ 克隆人数字人口型视频（lipsync）
import fs from "node:fs";
import path from "node:path";

const API = process.env.FCM_API || "http://127.0.0.1:3000/api";
const OUT = "C:/Users/30290/Desktop/fcmediaagent-replica/_work/step1";
fs.mkdirSync(OUT, { recursive: true });

const IMG = process.env.IMG || "C:/Users/30290/Desktop/数字人/第一阶段/人物参考_重截.png";
const AUD = process.env.AUD || "C:/Users/30290/Desktop/数字人/素材包/音频/新录音 17.m4a";
const SCRIPT = fs.readFileSync(
  process.env.SCRIPT || "C:/Users/30290/Desktop/数字人/第一阶段/口播稿.txt",
  "utf8",
).trim();
const PREVIEW_SECONDS = Number(process.env.PREVIEW_SECONDS || 22);
const RES = process.env.RES || "1080";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(p, init = {}) {
  const r = await fetch(API + p, init);
  const t = await r.text();
  let b;
  try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, body: b };
}
const H = (tok) => ({ "content-type": "application/json", authorization: "Bearer " + tok });

// ---- 1. 登录 + 充值 ----
const phone = "139" + String(Date.now()).slice(-8);
const s = await j("/auth/sms/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }) });
const l = await j("/auth/sms/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone, code: s.body.devCode }) });
const token = l.body.accessToken || l.body.token;
const userId = l.body.user?.id;
const al = await j("/auth/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }) });
const atok = al.body.accessToken || al.body.token;
await j("/admin/users/" + userId + "/credits", { method: "POST", headers: H(atok), body: JSON.stringify({ amount: 3000 }) });
log("login", phone, userId);

async function up(file, name, mime) {
  const buf = fs.readFileSync(file);
  const r = await j("/media/files/upload", { method: "POST", headers: H(token), body: JSON.stringify({ fileName: name, mime, base64: buf.toString("base64") }) });
  const ref = r.body.fileName || r.body.openapiFileName;
  log("upload", name, r.status, ref);
  if (!ref) throw new Error("upload failed " + JSON.stringify(r.body).slice(0, 200));
  return ref;
}
const imgRef = await up(IMG, "step1-person.png", "image/png");
const audRef = await up(AUD, "step1-voice-sample.m4a", "audio/mp4");
fs.writeFileSync(path.join(OUT, "step1-task.json"), JSON.stringify({ token, userId, phone, imgRef, audRef, script: SCRIPT }, null, 2));

// ---- 2. 声音克隆（indextts）：音频样本 + 文稿 → 克隆音色口播 ----
log("clone voice submit...");
const c = await j("/clone-records", { method: "POST", headers: H(token), body: JSON.stringify({ type: "voice", sourceUrl: audRef, text: SCRIPT }) });
log("clone submit", c.status, c.body?.id, c.body?.taskId);
if (!c.body?.id) throw new Error("clone submit failed " + JSON.stringify(c.body).slice(0, 300));

let cloneRow = c.body;
for (let i = 0; i < 60; i++) {
  await sleep(5000);
  const list = await j("/clone-records", { headers: H(token) });
  const rows = Array.isArray(list.body) ? list.body : list.body?.items || [];
  cloneRow = rows.find((r) => r.id === c.body.id) || cloneRow;
  log("clone poll", i, cloneRow.status, cloneRow.resultUrl || "");
  if (cloneRow.status === "completed" || cloneRow.status === "failed") break;
}
fs.writeFileSync(path.join(OUT, "clone-record.json"), JSON.stringify(cloneRow, null, 2));
if (cloneRow.status !== "completed" || !cloneRow.resultUrl) throw new Error("voice clone not completed: " + JSON.stringify(cloneRow).slice(0, 300));

const voiceRes = await fetch(cloneRow.resultUrl);
const voiceBuf = Buffer.from(await voiceRes.arrayBuffer());
const voiceFile = path.join(OUT, "cloned-voice.mp3");
fs.writeFileSync(voiceFile, voiceBuf);
log("voice saved", voiceFile, voiceBuf.length, "bytes");

// ---- 3. 克隆人：照片 + 克隆音色 → 口型视频 ----
log("lipsync submit, seconds=", PREVIEW_SECONDS, "res=", RES);
const v = await j("/compose-videos", {
  method: "POST", headers: H(token),
  body: JSON.stringify({
    composeType: "lipsync",
    videoUrl: imgRef,
    sourceAudioUrl: cloneRow.resultUrl,
    seconds: PREVIEW_SECONDS,
    resolution: RES,
    fps: 25,
    prompt: "人物面对镜头自然说话，表情平和，口型与音频严格同步，保持人物相貌与服饰，镜头固定，室内自然光。",
    title: "第一步-克隆人x克隆音色-" + PREVIEW_SECONDS + "s",
  }),
});
log("lipsync submit", v.status, v.body?.id, v.body?.musetalkTaskId);
if (!v.body?.id) throw new Error("lipsync submit failed " + JSON.stringify(v.body).slice(0, 300));

let compose;
for (let i = 0; i < 120; i++) {
  await sleep(10000);
  const list = await j("/compose-videos?pageSize=50", { headers: H(token) });
  const rows = Array.isArray(list.body) ? list.body : list.body?.items || list.body?.list || [];
  compose = rows.find((r) => r.id === v.body.id) || compose;
  log("video poll", i, compose?.status, compose?.videoUrl || "");
  if (compose && ["completed", "success", "failed"].includes(String(compose.status))) break;
}
fs.writeFileSync(path.join(OUT, "compose.json"), JSON.stringify(compose, null, 2));
log("done", compose?.status, compose?.videoUrl);
