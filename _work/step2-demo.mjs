// 第二步验收脚本：克隆音色 + 克隆人 + 工厂素材 → 时间线混剪（走 POST /api/timeline/*）
// 用法：node _work\step2-demo.mjs
import fs from "node:fs";
import path from "node:path";

const API = process.env.FCM_API || "http://127.0.0.1:3270/api";
const WORK = "C:/Users/30290/Desktop/fcmediaagent-replica/_work";
const OUT = path.join(WORK, "step2");
const FACTORY = "C:/Users/30290/Desktop/数字人/素材包/工厂素材";
const VOICE = path.join(WORK, "成片/第一步-克隆音色-117字.mp3");
const PERSON = path.join(WORK, "step1/person-full.mp4");
const SCRIPT = fs.readFileSync("C:/Users/30290/Desktop/数字人/第一阶段/口播稿.txt", "utf8").trim();
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = (tok) => ({ "content-type": "application/json", authorization: "Bearer " + tok });

async function j(p, init = {}) {
  const r = await fetch(API + p, init);
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, body: b };
}

// 1) 登录
const phone = "137" + String(Date.now()).slice(-8);
const s = await j("/auth/sms/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }) });
const l = await j("/auth/sms/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone, code: s.body.devCode, consent: { version: "2026-11-12", source: "api-test" } }) });
const token = l.body.accessToken || l.body.token;
if (!token) throw new Error("login failed " + JSON.stringify(l.body).slice(0, 200));
log("login ok", phone);

// 2) 上传素材（走新端点 POST /timeline/sources）—— 同一份文件第二次跑直接复用已上传地址
const CACHE_PATH = path.join(OUT, "sources-cache.json");
const cache = fs.existsSync(CACHE_PATH) ? JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) : {};
const saveCache = () => fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
async function upload(file, name, mime) {
  const st = fs.statSync(file);
  const key = `${name}|${st.size}|${st.mtimeMs}`;
  if (cache[key]?.url) return cache[key];
  const buf = fs.readFileSync(file);
  const r = await j("/timeline/sources", { method: "POST", headers: H(token), body: JSON.stringify({ fileName: name, mime, base64: buf.toString("base64") }) });
  if (r.status !== 201 || !r.body?.url) throw new Error("upload failed " + name + " " + JSON.stringify(r.body).slice(0, 300));
  cache[key] = r.body;
  saveCache();
  return r.body;
}

const voice = await upload(VOICE, "cloned-voice.mp3", "audio/mpeg");
const person = await upload(PERSON, "person-full.mp4", "video/mp4");
log("voice", voice.duration + "s", "person", person.width + "x" + person.height, person.duration + "s");

const files = fs.readdirSync(FACTORY).filter((f) => f.endsWith(".mp4")).sort();
const clips = [];
for (const f of files) {
  const info = await upload(path.join(FACTORY, f), f, "video/mp4");
  clips.push({ url: info.url, duration: info.duration, name: f });
  process.stdout.write(`\ruploaded ${clips.length}/${files.length}   `);
}
log("\nfactory clips", clips.length, "total", clips.reduce((s, c) => s + c.duration, 0).toFixed(1) + "s");

// 3) 字幕时间码：把口播稿按句切分，按字数比例铺满配音时长（软件没有 ASR，这一步是文字对齐）
const total = voice.duration;
const sentences = SCRIPT.split(/(?<=[？。！？])/).map((s) => s.trim()).filter(Boolean);
const chars = sentences.map((s) => s.replace(/[，。？、！；：""'']/g, "").length);
const sum = chars.reduce((a, b) => a + b, 0);
let acc = 0;
const cues = sentences.map((text, i) => {
  const start = (acc / sum) * total;
  acc += chars[i];
  const end = (acc / sum) * total;
  return { start: Number(start.toFixed(2)), end: Number(end.toFixed(2)), text, keyword: text.length > 10 ? text.slice(0, 4) : undefined };
});
log("cues", cues.length, cues[0]);

// 4) 创建剪辑任务
const body = {
  title: "第二步-克隆音色+克隆人+工厂素材",
  clips: clips.map((c) => c.url),
  voiceover: voice.url,
  person: person.url,
  cues,
  totalDuration: Number(total.toFixed(2)),
  style: {},
};
const created = await j("/timeline/jobs", { method: "POST", headers: H(token), body: JSON.stringify(body) });
log("job created", created.status, JSON.stringify(created.body).slice(0, 200));
if (!created.body?.id) throw new Error("create failed");
const id = created.body.id;
fs.writeFileSync(path.join(OUT, "job.json"), JSON.stringify({ id, token, phone, body }, null, 2));

// 5) 轮询
let last = "";
for (let i = 0; i < 240; i++) {
  await sleep(3000);
  const r = await j("/timeline/jobs/" + id, { headers: H(token) });
  const row = r.body || {};
  const line = `${row.status} ${row.progress}%`;
  if (line !== last) { log("poll", line, row.error ? String(row.error).slice(0, 200) : ""); last = line; }
  if (row.status === "completed" || row.status === "failed") {
    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(row, null, 2));
    if (row.status === "completed") {
      const res = await fetch("http://127.0.0.1:3270" + row.resultUrl);
      const buf = Buffer.from(await res.arrayBuffer());
      const target = path.join(OUT, "第二步-时间线混剪.mp4");
      fs.writeFileSync(target, buf);
      log("downloaded", target, (buf.length / 1048576).toFixed(2) + "MB");
    }
    log("done", row.status, row.resultUrl || row.error);
    break;
  }
}
