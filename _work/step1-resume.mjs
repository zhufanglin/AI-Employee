// 第一步续跑：克隆音色已生成 → 取回 → 数字人口型
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const API = process.env.FCM_API || "http://127.0.0.1:3100/api";
const ORIGIN = new URL(API).origin;
const OUT = "C:/Users/30290/Desktop/fcmediaagent-replica/_work/step1";
const PREVIEW_SECONDS = Number(process.env.PREVIEW_SECONDS || 22);
const RES = process.env.RES || "1080";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(p, init = {}) {
  const r = await fetch(API + p, init);
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, body: b };
}
const H = (tok) => ({ "content-type": "application/json", authorization: "Bearer " + tok });

const task = JSON.parse(fs.readFileSync(path.join(OUT, "step1-task.json"), "utf8"));
const clone = JSON.parse(fs.readFileSync(path.join(OUT, "clone-record.json"), "utf8"));
const token = task.token;
const imgRef = task.imgRef;

const voiceUrl = clone.resultUrl.startsWith("http") ? clone.resultUrl : ORIGIN + clone.resultUrl;
const buf = Buffer.from(await (await fetch(voiceUrl)).arrayBuffer());
const voiceFile = path.join(OUT, "cloned-voice.mp3");
fs.writeFileSync(voiceFile, buf);
const dur = Number(process.env.VOICE_DUR || 0) || 27.18;
log("voice", voiceFile, buf.length, "bytes", dur.toFixed(2), "s");

// 克隆出来的音频要再上到 RunningHub，lipsync 才能读到
const up = await j("/media/files/upload", { method: "POST", headers: H(token), body: JSON.stringify({ fileName: "cloned-voice.mp3", mime: "audio/mpeg", base64: buf.toString("base64") }) });
const voiceRef = up.body.fileName || up.body.openapiFileName;
log("voice upload", up.status, voiceRef);
if (!voiceRef) throw new Error("voice upload failed " + JSON.stringify(up.body).slice(0, 200));

const seconds = Math.max(1, Math.min(PREVIEW_SECONDS, Math.floor(dur)));
log("lipsync submit seconds=", seconds, "res=", RES);
const v = await j("/compose-videos", {
  method: "POST", headers: H(token),
  body: JSON.stringify({
    composeType: "lipsync",
    videoUrl: imgRef,
    sourceAudioUrl: voiceRef,
    seconds,
    resolution: RES,
    fps: 25,
    prompt: "人物面对镜头自然说话，表情平和，口型与音频严格同步，保持人物相貌与服饰，镜头固定，室内自然光。",
    title: "第一步-克隆人x克隆音色-" + seconds + "s",
  }),
});
log("lipsync submit", v.status, JSON.stringify(v.body).slice(0, 200));
if (!v.body?.id) throw new Error("lipsync submit failed " + JSON.stringify(v.body).slice(0, 300));
fs.writeFileSync(path.join(OUT, "compose-submit.json"), JSON.stringify({ ...v.body, seconds, res: RES, voiceRef, voiceDur: dur }, null, 2));

let compose;
for (let i = 0; i < 150; i++) {
  await sleep(10000);
  const list = await j("/compose-videos?pageSize=50", { headers: H(token) });
  const rows = Array.isArray(list.body) ? list.body : list.body?.items || list.body?.list || [];
  compose = rows.find((r) => r.id === v.body.id) || compose;
  log("video poll", i, compose?.status, compose?.videoUrl || "");
  if (compose && ["completed", "success", "failed"].includes(String(compose.status))) break;
}
fs.writeFileSync(path.join(OUT, "compose.json"), JSON.stringify(compose, null, 2));
log("done", compose?.status, compose?.videoUrl);
