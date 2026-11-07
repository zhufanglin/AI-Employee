import { readFileSync } from "node:fs";
const base = "http://127.0.0.1:3000/api";
const send = await fetch(base + "/auth/sms/send", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phone:"13900000002"})}).then(r=>r.json());
if (!send.devCode) { console.log("send:", JSON.stringify(send).slice(0,150)); process.exit(1); }
const login = await fetch(base + "/auth/sms/login", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phone:"13900000002",code:send.devCode})}).then(r=>r.json());
const t = login.accessToken;
const b64 = p => readFileSync(p).toString("base64");
const up = (fileName, mime, data) => fetch(base + "/media/files/upload", {method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+t},body:JSON.stringify({fileName,mime,base64:data})}).then(r=>r.json());
const img = await up("128x128.png","image/png",b64("/tmp/128x128.png"));
const aud = await up("clone-female.wav","audio/wav",b64("/tmp/clone-female.wav"));
console.log("img:", img.url ? "ok" : JSON.stringify(img).slice(0,120), "aud:", aud.url ? "ok" : JSON.stringify(aud).slice(0,120));
const sub = await fetch(base + "/media/apps/lipsync/submit", {method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+t},body:JSON.stringify({image:img.url,audio:aud.url,seconds:3,resolution:720})}).then(r=>r.json());
console.log("submit:", JSON.stringify({taskId:sub.taskId,status:sub.status,estimatedAmount:sub.estimatedAmount}));
if (!sub.taskId) process.exit(1);
for (let i = 0; i < 24; i++) {
  await new Promise(r=>setTimeout(r,10000));
  const q = await fetch(base + "/media/tasks/" + sub.taskId, {headers:{authorization:"Bearer "+t}}).then(r=>r.json());
  if (q.status === "SUCCESS" || q.status === "FAILED") {
    console.log("final:", JSON.stringify({status:q.status,resultUrl:q.resultUrl,archivedBytes:q.resultMeta&&q.resultMeta.archivedBytes,source:(q.resultMeta&&q.resultMeta.sourceUrl||"").slice(0,90)}));
    if (q.resultUrl) { const h = await fetch(q.resultUrl, {method:"HEAD"}); console.log("HEAD:", h.status, h.headers.get("content-type"), h.headers.get("content-length")); }
    process.exit(0);
  }
}
console.log("still running after 240s");