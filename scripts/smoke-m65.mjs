// M6.5 员工域冒烟：目录 -> 安装 -> 我的 -> 运行 -> 端上拉取 -> 回写 -> 验收
const BASE = process.env.FCM_API || "http://127.0.0.1:3000/api";
const phone = "139" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
const j = async (path, opts = {}) => {
  const r = await fetch(BASE + path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, body: b };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function health() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + "/health"); if (r.ok) return true; } catch {}
    await wait(1000);
  }
  return false;
}
const out = {};
if (!(await health())) { console.log("SERVER NOT UP"); process.exit(1); }
const send = await j("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone }) });
const code = send.body.devCode;
const login = await j("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone, code }) });
const token = login.body.accessToken;
out.login = { status: login.status, user: login.body.user?.phone };
const auth = { authorization: "Bearer " + token };

const cat = await j("/employees/catalog", { headers: auth });
out.catalog = { status: cat.status, total: cat.body.total, categories: cat.body.categories, first: cat.body.items?.[0]?.slug };

const detail = await j("/employees/boss-video-auto-editor", { headers: auth });
out.detail = { status: detail.status, name: detail.body.name, skills: detail.body.skillSlugs, crons: detail.body.cronPresets };

const inst = await j("/employees/boss-video-auto-editor/install", { method: "POST", headers: auth, body: JSON.stringify({ days: 30 }) });
out.install = { status: inst.status, enabled: inst.body.install?.enabled, expiresAt: inst.body.install?.expiresAt };

const mine = await j("/employees/mine", { headers: auth });
out.mine = { status: mine.status, total: mine.body.total, installedCount: mine.body.installedCount };

const run = await j("/employees/boss-video-auto-editor/run", { method: "POST", headers: auth, body: JSON.stringify({ title: "冒烟任务", input: { file: "demo.mp4" } }) });
out.run = { status: run.status, id: run.body.id, executor: run.body.executor, taskStatus: run.body.status };

const pull = await j("/employee-tasks/pull?limit=2", { headers: auth });
out.pull = { status: pull.status, count: pull.body.count, ids: pull.body.items?.map((t) => t.id) };

const patch = await j("/employee-tasks/" + run.body.id, { method: "PATCH", headers: auth, body: JSON.stringify({ status: "awaiting_approval", outputKind: "video", outputPath: "C:/tmp/out.mp4", artifacts: [{ kind: "video", path: "C:/tmp/out.mp4" }] }) });
out.patch = { status: patch.status, taskStatus: patch.body.status, artifacts: patch.body.artifacts?.length };

const approve = await j("/employee-tasks/" + run.body.id + "/approve", { method: "POST", headers: auth, body: "{}" });
out.approve = { status: approve.status, taskStatus: approve.body.status };

const list = await j("/employee-tasks?limit=5", { headers: auth });
out.list = { status: list.status, total: list.body.total, first: list.body.items?.[0]?.status };

const uninst = await j("/employees/boss-video-auto-editor/install", { method: "DELETE", headers: auth });
out.uninstall = { status: uninst.status, removed: uninst.body.removed };

const bad = await j("/employee-tasks/not-exist-id/patch", { method: "PATCH", headers: auth, body: "{}" });
out.notFound = { status: bad.status };

console.log(JSON.stringify(out, null, 1));
