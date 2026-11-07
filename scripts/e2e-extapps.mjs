
const API = process.env.FCM_API || "http://127.0.0.1:3000/api";
const fs = await import("node:fs");
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
console.log("login", phone, userId);

// admin 充值
const al = await j("/auth/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }) });
const atok = al.body.accessToken || al.body.token;
const credit = await j("/admin/users/" + userId + "/credits", { method: "POST", headers: H(atok), body: JSON.stringify({ amount: 800 }) });
console.log("credits", credit.status, JSON.stringify(credit.body).slice(0, 120));

async function upload(path, fileName, mime) {
  const buf = fs.readFileSync(path);
  const r = await j("/media/files/upload", { method: "POST", headers: H(token), body: JSON.stringify({ fileName, mime, base64: buf.toString("base64") }) });
  if (r.status >= 300) throw new Error("upload failed " + r.status + " " + JSON.stringify(r.body).slice(0, 200));
  return r.body.fileName || r.body.url;
}

const audioPath = "C:/Users/30290/Desktop/部署文件/_extract/0.4.29/app/resources/resources/voice/clone-female.wav";
const imagePath = "C:/Users/30290/Desktop/fcmediaagent-replica/_demo/01_ceo.jpg";
let audioRef, imageRef;
try { audioRef = await upload(audioPath, "clone-female.wav", "audio/wav"); console.log("audioRef", audioRef); } catch (e) { console.log("audio upload ERR", e.message); }
try { imageRef = await upload(imagePath, "01_ceo.jpg", "image/jpeg"); console.log("imageRef", imageRef); } catch (e) { console.log("image upload ERR", e.message); }

if (audioRef) {
  const c = await j("/clone-records", { method: "POST", headers: H(token), body: JSON.stringify({ type: "voice", sourceUrl: audioRef, text: "你好，我是你的 AI 数字员工，今天也要一起把客户签下来。" }) });
  console.log("clone submit", c.status, JSON.stringify(c.body).slice(0, 300));
}
if (imageRef) {
  const m = await j("/compose-videos", { method: "POST", headers: H(token), body: JSON.stringify({ composeType: "mixcut", image: imageRef, prompt: "制作15秒高冲击人物卡点混剪，15个分镜，参考图中可识别的脸型、五官比例、发型轮廓、服装设计、配饰和标志性配色，主标题为“The Dream Girl”", seconds: 15 }) });
  console.log("mixcut submit", m.status, JSON.stringify(m.body).slice(0, 300));
}

// 轮询
for (let i = 0; i < 80; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  const cl = await j("/clone-records", { headers: H(token) });
  const cv = await j("/compose-videos", { headers: H(token) });
  const clRows = (cl.body.rows || cl.body || []).slice(0, 2);
  const cvRows = (cv.body.rows || cv.body || []).slice(0, 2);
  console.log("[poll " + i + "]", JSON.stringify(clRows.map((r) => ({ s: r.status, u: r.resultUrl || r.resultAudioUrl || r.sourceUrl }))), JSON.stringify(cvRows.map((r) => ({ s: r.status, u: r.videoUrl || r.resultUrl }))));
  const doneCl = clRows.every((r) => r.status && !["polling", "processing", "pending"].includes(r.status));
  const doneCv = cvRows.every((r) => r.status && !["composing", "cloning_audio", "pending"].includes(r.status));
  if (clRows.length && cvRows.length && doneCl && doneCv) break;
}
console.log("DONE");
