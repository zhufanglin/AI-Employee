// 生产验收：用用户真实需求（本地少儿英语培训招生）走一遍云任务，确认不再因上游抖动秒失败
const BASE = process.env.FCM_API_BASE || "http://127.0.0.1:3000/api";
const j = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { "content-type": "application/json", ...(o.headers || {}) } });
  const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, body: b };
};
const phone = process.env.FCM_PHONE || "13900000002";
let token = null, uid = null;
for (let i = 0; i < 3 && !token; i++) {
  const s = await j("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone }) });
  if (s.body?.devCode) {
    const l = await j("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone, code: s.body.devCode }) });
    token = l.body?.accessToken; uid = l.body?.user?.id;
  } else { console.log("send status", s.status, JSON.stringify(s.body).slice(0, 120)); await new Promise((r) => setTimeout(r, 70000)); }
}
if (!token) { console.log("LOGIN_FAILED"); process.exit(1); }
console.log("login ok", uid);
const auth = { authorization: "Bearer " + token };
const slug = "boss-lead-radar";
await j("/employees/" + slug + "/install", { method: "POST", headers: auth, body: "{}" });
const text = "你好，我是做本地少儿英语培训的，校区在番禺，现在暑假班招不满。帮我看看最近家长最关心什么、附近同行都在怎么招生，给一份这周就能用的招生方案，要包含朋友圈文案和目标家长画像。";
const run = await j("/employees/" + slug + "/run", { method: "POST", headers: auth, body: JSON.stringify({ executor: "cloud", title: "真实需求验收-少儿英语招生", input: { text } }) });
if (!run.body?.id) { console.log("RUN_FAILED", run.status, JSON.stringify(run.body).slice(0, 300)); process.exit(1); }
const id = run.body.id;
console.log("task", id, run.body.status, run.body.executor);
let last = null;
for (let i = 0; i < 78; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  const g = await j("/employee-tasks/" + id, { headers: auth });
  const st = g.body?.status;
  if (st !== last) { console.log("status", st, "elapsed", (i + 1) * 10 + "s"); last = st; }
  if (["completed", "awaiting_approval", "failed", "cancelled"].includes(st)) {
    const steps = (g.body.outputMeta || {}).steps || [];
    console.log("steps:", JSON.stringify(steps.map((s) => ({ c: s.capability || s.name || s.tool, ok: s.ok !== false }))).slice(0, 800));
    console.log("outputLen:", (g.body.outputText || "").length);
    console.log("outputHead:", (g.body.outputText || "").slice(0, 700));
    console.log("ERROR:", g.body.error || "");
    console.log(st === "failed" ? "REAL DEMAND TASK FAILED" : "REAL DEMAND TASK OK");
    process.exit(st === "failed" ? 1 : 0);
  }
}
console.log("TIMEOUT"); process.exit(1);
