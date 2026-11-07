import { readFileSync } from "node:fs";
const API = process.env.FCM_API || "https://ai.fcmediaagent.com/api";
const phone = process.env.FCM_PHONE || "13900000002";
const IMG = "C:\\Users\\30290\\Desktop\\部署文件\\_extract\\0.4.29\\app\\resources\\resources\\installer\\cards\\01_ceo.jpg";
const AUD = "C:\\Users\\30290\\Desktop\\部署文件\\_extract\\0.4.29\\app\\resources\\resources\\voice\\clone-female.wav";

async function j(path, init = {}) {
  const res = await fetch(API + path, init);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
const post = (p, token, obj) => j(p, { method: "POST", headers: { "content-type": "application/json", authorization: token ? "Bearer " + token : "" }, body: JSON.stringify(obj) });

const sent = await post("/auth/sms/send", "", { phone });
console.log("sms", sent.status, JSON.stringify(sent.body));
if (!sent.body?.devCode) { console.log("NO DEVCODE; need allowlisted phone"); process.exit(2); }
const login = await post("/auth/sms/login", "", { phone, code: sent.body.devCode });
const token = login.body?.accessToken || login.body?.token;
console.log("login", login.status, "user", login.body?.user?.id, "credits", login.body?.user?.credits);
if (!token) process.exit(2);

const bal = await j("/credits/balance", { headers: { authorization: "Bearer " + token } });
console.log("balance", JSON.stringify(bal.body));

const upImg = await post("/media/files/upload", token, { fileName: "ceo.jpg", mime: "image/jpeg", base64: readFileSync(IMG).toString("base64") });
const upAud = await post("/media/files/upload", token, { fileName: "clone-female.wav", mime: "audio/wav", base64: readFileSync(AUD).toString("base64") });
console.log("upload", upImg.status, upAud.status);
const image = upImg.body?.fileName, audio = upAud.body?.fileName;
if (!image || !audio) { console.log("upload fail", JSON.stringify(upImg.body), JSON.stringify(upAud.body)); process.exit(2); }

const created = await post("/compose-videos", token, { composeType: "lipsync", videoUrl: image, sourceAudioUrl: audio, seconds: 3, resolution: 720, prompt: "角色面向镜头深情的说话，固定镜头。" });
console.log("create", created.status, JSON.stringify(created.body).slice(0, 260));
const id = created.body?.id;
if (!id) process.exit(2);

let last = "";
for (let i = 0; i < 50; i++) {
  await new Promise((r) => setTimeout(r, 8000));
  const list = await j("/compose-videos?limit=20", { headers: { authorization: "Bearer " + token } });
  const rows = Array.isArray(list.body) ? list.body : (list.body?.items || []);
  const row = rows.find((x) => x.id === id);
  if (!row) { console.log("row gone"); break; }
  if (row.status !== last) { console.log("[" + i * 8 + "s] " + row.status + " provider=" + (row.providerStatus || "-")); last = row.status; }
  if (row.status === "completed" || row.status === "failed") {
    console.log("RESULT_URL=" + row.resultUrl);
    console.log("META=" + JSON.stringify(row.resultMeta).slice(0, 300));
    const res = await fetch(row.resultUrl.startsWith("http") ? row.resultUrl : "https://ai.fcmediaagent.com" + row.resultUrl);
    console.log("download=" + res.status + " bytes=" + (res.headers.get("content-length") || "?"));
    const head = await res.arrayBuffer();
    console.log("downloaded_bytes=" + head.byteLength);
    break;
  }
}
