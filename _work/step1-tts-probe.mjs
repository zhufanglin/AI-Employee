// 探针：验证 indextts 单次合成是否有时长上限（短文本 → 看时长比例）
import fs from "node:fs";
import path from "node:path";

const API = process.env.FCM_API || "http://127.0.0.1:3100/api";
const ORIGIN = new URL(API).origin;
const OUT = "C:/Users/30290/Desktop/fcmediaagent-replica/_work/step1";
const TEXT = process.env.TEXT || "模具和注塑，为什么要从一开始就一起考虑？";
const task = JSON.parse(fs.readFileSync(path.join(OUT, "step1-task.json"), "utf8"));
const H = { "content-type": "application/json", authorization: "Bearer " + task.token };
const j = async (p, init = {}) => { const r = await fetch(API + p, init); const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; } return { status: r.status, body: b }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const c = await j("/clone-records", { method: "POST", headers: H, body: JSON.stringify({ type: "voice", sourceUrl: task.audRef, text: TEXT }) });
console.log("submit", c.status, c.body?.id, c.body?.taskId, "chars=", TEXT.length);
let row = c.body;
for (let i = 0; i < 40; i++) {
  await sleep(5000);
  const list = await j("/clone-records", { headers: H });
  row = (Array.isArray(list.body) ? list.body : []).find((r) => r.id === c.body.id) || row;
  if (row.status === "completed" || row.status === "failed") break;
}
console.log("status", row.status, row.resultUrl);
if (row.resultUrl) {
  const url = row.resultUrl.startsWith("http") ? row.resultUrl : ORIGIN + row.resultUrl;
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const f = path.join(OUT, "probe.mp3");
  fs.writeFileSync(f, buf);
  console.log("saved", f, buf.length);
}
