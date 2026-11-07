// 生产验收：员工任务是否带上 SKILL.md（T-36/T-37）
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
const run = await j("/employees/" + slug + "/run", { method: "POST", headers: auth, body: JSON.stringify({ executor: "cloud", title: "T-36 生产验收", input: { text: "围绕本地生活服务商家，给出 3 条本周可执行的获客选题，每条附目标人群与发布平台。" } }) });
if (!run.body?.id) { console.log("RUN_FAILED", run.status, JSON.stringify(run.body).slice(0, 300)); process.exit(1); }
console.log("task", run.body.id, run.body.status, run.body.executor);
const id = run.body.id;
let last = null;
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  const g = await j("/employee-tasks/" + id, { headers: auth });
  const st = g.body?.status;
  if (st !== last) { console.log("status", st); last = st; }
  if (["completed", "awaiting_approval", "failed", "cancelled"].includes(st)) {
    const meta = g.body.outputMeta || {};
    console.log("steps:", JSON.stringify(meta.steps || [], null, 1).slice(0, 1200));
    console.log("outputLen:", (g.body.outputText || "").length);
    console.log("outputHead:", (g.body.outputText || "").slice(0, 900));
    console.log("ERROR:", g.body.error || "");
    process.exit(st === "failed" ? 1 : 0);
  }
}
console.log("TIMEOUT"); process.exit(1);
