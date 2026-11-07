
const H = { authorization: "Bearer 706fefd65d21907a14cc8ed0200f0866" };
const T = "http://127.0.0.1:8600";
const g = async (p) => { const r = await fetch(T + p, { headers: H }); const t = await r.text(); return [r.status, t.slice(0, 600)]; };
console.log("status", ...await g("/api/v1/bot/status"));
try {
  const [s, b] = await g("/api/v1/chat/messages?chat_name=" + encodeURIComponent("朱方林"));
  console.log("messages", s, b.slice(0, 500));
} catch (e) { console.log("messages ERR", e.message); }
