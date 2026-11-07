const stamp = new Date().toISOString().slice(11,19);
const body = JSON.stringify({ name: "朱方林", msg: "[链路自测 " + stamp + "Z] 如果你在手机微信里看到这条消息，说明结果回推通道是通的。" });
const r = await fetch("http://127.0.0.1:8600/api/v1/chat/send", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer 706fefd65d21907a14cc8ed0200f0866" }, body });
console.log(r.status, (await r.text()).slice(0, 400));