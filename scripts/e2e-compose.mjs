import { readFileSync, mkdirSync, writeFileSync } from "node:fs";

const API = "http://127.0.0.1:3000/api";
const phone = "139" + String(Date.now()).slice(-8);
const IMG = "C:\\Users\\30290\\Desktop\\部署文件\\_extract\\0.4.29\\app\\resources\\resources\\installer\\cards\\01_ceo.jpg";
const AUD = "C:\\Users\\30290\\Desktop\\部署文件\\_extract\\0.4.29\\app\\resources\\resources\\voice\\clone-female.wav";

async function j(path, init = {}) {
  const res = await fetch(API + path, init);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
const post = (p, token, obj) => j(p, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(obj) });

const sent = await post("/auth/sms/send", "", { phone });
console.log("sms/send", sent.status, JSON.stringify(sent.body));
if (!sent.body?.devCode) { console.log("NO DEVCODE — abort"); process.exit(2); }
const login = await post("/auth/sms/login", "", { phone, code: sent.body.devCode });
console.log("login", login.status, login.body?.user?.id);
const token = login.body?.accessToken || login.body?.token;
const userId = login.body?.user?.id;

const admin = await post("/auth/admin/login", "", { username: process.env.ADMIN_USERNAME || "admin", password: process.env.ADMIN_PASSWORD || "admin" });
const atoken = admin.body?.accessToken || admin.body?.token;
const credit = await post("/admin/users/" + userId + "/credits", atoken, { amount: 100, note: "e2e compose demo" });
console.log("topup", credit.status, JSON.stringify(credit.body));

const upImg = await post("/media/files/upload", token, { fileName: "ceo.jpg", mime: "image/jpeg", base64: readFileSync(IMG).toString("base64") });
console.log("upload image", upImg.status, JSON.stringify(upImg.body).slice(0, 200));
const upAud = await post("/media/files/upload", token, { fileName: "clone-female.wav", mime: "audio/wav", base64: readFileSync(AUD).toString("base64") });
console.log("upload audio", upAud.status, JSON.stringify(upAud.body).slice(0, 200));
const image = upImg.body?.fileName || upImg.body?.url;
const audio = upAud.body?.fileName || upAud.body?.url;
if (!image || !audio) { console.log("upload failed"); process.exit(2); }

const created = await post("/compose-videos", token, { composeType: "lipsync", videoUrl: image, sourceAudioUrl: audio, seconds: 3, resolution: 720, prompt: "角色面向镜头深情的说话，固定镜头。" });
console.log("compose create", created.status, JSON.stringify(created.body).slice(0, 300));
const id = created.body?.id;
if (!id) process.exit(2);

let last = "";
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 8000));
  const list = await j("/compose-videos?limit=20", { headers: { authorization: "Bearer " + token } });
  const rows = Array.isArray(list.body) ? list.body : (list.body?.items || []);
  const row = rows.find((x) => x.id === id);
  if (!row) { console.log("row gone"); break; }
  if (row.status !== last) { console.log("[" + (i * 8) + "s] status=" + row.status + " provider=" + (row.providerStatus || "-")); last = row.status; }
  if (row.status === "completed" || row.status === "failed") {
    console.log("FINAL", JSON.stringify(row).slice(0, 500));
    if (row.resultUrl) {
      const res = await fetch(row.resultUrl);
      const buf = Buffer.from(await res.arrayBuffer());
      mkdirSync("_demo", { recursive: true });
      const out = "_demo/lipsync-" + id + ".mp4";
      writeFileSync(out, buf);
      console.log("SAVED " + out + " " + buf.length + " bytes");
      writeFileSync("_demo/lipsync.json", JSON.stringify({ id, phone, resultUrl: row.resultUrl, providerStatus: row.providerStatus, resultMeta: row.resultMeta, out }, null, 2));
    }
    break;
  }
}
