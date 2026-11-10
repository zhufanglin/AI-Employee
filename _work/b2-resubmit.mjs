// B 线重提交：智能混剪，可指定 aspectRatio（上游 ResolutionSelector 的 select 选项名）
import fs from "node:fs";
const API = process.env.FCM_API || "http://127.0.0.1:3000/api";
const ASPECT = process.env.ASPECT || "9:16 (Portrait Widescreen)";
const t = JSON.parse(fs.readFileSync("C:/Users/30290/Desktop/fcmediaagent-replica/_work/b-task.json", "utf8"));
const H = { "content-type": "application/json", authorization: "Bearer " + t.token };
const png = fs.readFileSync("C:/Users/30290/Desktop/数字人/素材包/人物/runninghub-first-frame.png");
const up = await fetch(API + "/media/files/upload", {
  method: "POST", headers: H,
  body: JSON.stringify({ fileName: "first-frame.png", mime: "image/png", base64: png.toString("base64") }),
});
const upb = await up.json();
const imageRef = upb.fileName || upb.openapiFileName;
console.log("upload", up.status, imageRef);
const r = await fetch(API + "/compose-videos", {
  method: "POST", headers: H,
  body: JSON.stringify({
    composeType: "mixcut",
    image: imageRef,
    prompt: "制作15秒高冲击企业宣传卡点混剪：精密模具与注塑一体化工厂，CNC加工、注塑成型、产线装配、质检、产品陈列，节奏明快、电影感运镜、暖白工业光。主标题「精密模塑 一体化」，副标题「从模具到注塑 一站式」。",
    seconds: 15,
    aspectRatio: ASPECT,
    megapixels: 0.9,
    title: "精密模塑一体化-混剪15s-" + ASPECT,
  }),
});
const b = await r.json();
console.log("submit", r.status, ASPECT, JSON.stringify(b).slice(0, 300));
if (b.smartClipTaskId) {
  const prev = JSON.parse(fs.readFileSync("C:/Users/30290/Desktop/fcmediaagent-replica/_work/b-task.json", "utf8"));
  fs.writeFileSync("C:/Users/30290/Desktop/fcmediaagent-replica/_work/b-task.json", JSON.stringify({ ...prev, id2: b.id, smartClipTaskId2: b.smartClipTaskId, aspect: ASPECT }, null, 2));
}
