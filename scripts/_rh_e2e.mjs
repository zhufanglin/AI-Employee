const API = "http://127.0.0.1:3000/api";
const PHONE = "13900000002";
async function j(path, init) {
  const r = await fetch(API + path, init);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; }
}
(async () => {
  const send = await j("/auth/sms/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: PHONE }) });
  const code = send.body.devCode;
  const login = await j("/auth/sms/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: PHONE, code }) });
  console.log("send:", JSON.stringify(send.body).slice(0,120));
  console.log("login:", JSON.stringify(login.body).slice(0,140));
  const token = login.body.accessToken;
  const H = { "content-type": "application/json", authorization: "Bearer " + token };
  const fs = await import("node:fs");
  const img = fs.readFileSync("/tmp/test_face.png").toString("base64");
  const aud = fs.readFileSync("/tmp/test_voice.wav").toString("base64");
  const upImg = await j("/media/files/upload", { method: "POST", headers: H, body: JSON.stringify({ fileName: "face.png", mime: "image/png", base64: img }) });
  console.log("upload image:", JSON.stringify(upImg.body).slice(0, 200));
  const upAud = await j("/media/files/upload", { method: "POST", headers: H, body: JSON.stringify({ fileName: "voice.wav", mime: "audio/wav", base64: aud }) });
  console.log("upload audio:", JSON.stringify(upAud.body).slice(0, 200));
  const imageName = upImg.body.fileName, audioName = upAud.body.fileName;
  if (!imageName || !audioName) { console.log("upload failed, abort"); return; }
  const submit = await j("/media/apps/lipsync/submit", { method: "POST", headers: H, body: JSON.stringify({ image: imageName, audio: audioName, seconds: 3, resolution: 720, prompt: "角色面向镜头深情的说话，固定镜头。" }) });
  console.log("submit:", JSON.stringify(submit.body).slice(0, 400));
  const taskId = submit.body.taskId;
  if (!taskId) return;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const t = await j("/media/tasks/" + encodeURIComponent(taskId), { headers: { authorization: "Bearer " + token } });
    const st = t.body.status || (t.body.upstream && t.body.upstream.status);
    console.log(i, "status:", st, "url:", (t.body.resultUrl || "").slice(0, 90));
    if (st === "SUCCESS" || st === "FAILED") { console.log("final:", JSON.stringify(t.body).slice(0, 600)); break; }
  }
})();