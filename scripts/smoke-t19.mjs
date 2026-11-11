// T-19 冒烟：桌面端任务执行契约（pull 认领 / 端上回写 / 失联重新排队 / 三次失败 / 验收）
import { createRequire } from "node:module";
import { loadServerEnv } from "./_env.mjs";
loadServerEnv();
const BASE = process.env.FCM_API || "http://127.0.0.1:3000/api";
const SERVER_DIR = process.env.FCM_SERVER_DIR || "C:\\Users\\30290\\Desktop\\fcmediaagent-replica\\packages\\server";
const require = createRequire(SERVER_DIR + "\\package.json");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const j = async (p, opts = {}) => {
  const r = await fetch(BASE + p, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, body: b };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function login(phone) {
  const send = await j("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone }) });
  const res = await j("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone, code: send.body.devCode }) });
  return { token: res.body.accessToken, id: res.body.user?.id };
}
const results = [];
const check = (name, cond, detail) => { results.push({ name, ok: !!cond }); console.log((cond ? "PASS " : "FAIL ") + name, detail === undefined ? "" : JSON.stringify(detail)); };

try {
  const phone = process.env.SMOKE_PHONE || "139" + String(Date.now()).slice(-8);
  const u = await login(phone);
  const auth = { authorization: "Bearer " + u.token };
  check("login", !!u.token);

  const slug = "boss-lead-radar";
  const install = await j("/employees/" + slug + "/install", { method: "POST", headers: auth, body: "{}" });
  check("install bundled employee", install.status === 201 || install.status === 200, install.status);

  // 1. 未鉴权
  const noAuth = await j("/employee-tasks/pull?limit=1");
  check("pull requires auth", noAuth.status === 401, noAuth.status);

  // 2. 创建桌面端任务并被 pull 认领
  const run = await j("/employees/" + slug + "/run", { method: "POST", headers: auth, body: JSON.stringify({ executor: "desktop", title: "T-19 冒烟任务", input: { text: "写一条测试" } }) });
  check("run queued desktop", run.status === 201 || run.status === 200, { status: run.body.status, executor: run.body.executor });
  const taskId = run.body.id;

  const pull = await j("/employee-tasks/pull?limit=1", { method: "GET", headers: auth });
  const claimed = pull.body.items?.[0];
  check("pull claims task", claimed?.id === taskId && claimed?.status === "running", { id: claimed?.id, status: claimed?.status });

  const again = await j("/employee-tasks/pull?limit=1", { method: "GET", headers: auth });
  check("pull does not re-claim running task", (again.body.items || []).length === 0, again.body.count);

  // 3. 端上回写 -> 待验收
  const patch = await j("/employee-tasks/" + taskId, { method: "PATCH", headers: auth, body: JSON.stringify({
    claimToken: claimed?.outputMeta?.claimToken,
    status: "awaiting_approval", outputKind: "text", outputText: "端上执行结果",
    outputMeta: { executor: "desktop", model: "smoke" },
    artifacts: [{ kind: "text", text: "端上执行结果" }, { kind: "file", path: "C:\\tmp\\smoke.md", mime: "text/markdown" }]
  }) });
  check("patch awaiting_approval", patch.body.status === "awaiting_approval" && (patch.body.artifacts || []).length === 2, { status: patch.body.status, artifacts: patch.body.artifacts?.length });

  const approve = await j("/employee-tasks/" + taskId + "/approve", { method: "POST", headers: auth, body: "{}" });
  check("approve -> succeeded", approve.body.status === "succeeded", approve.body.status);

  // 4. 失联兜底：running 超时首次 -> 重新排队
  const run2 = await j("/employees/" + slug + "/run", { method: "POST", headers: auth, body: JSON.stringify({ executor: "desktop", title: "T-19 失联重排", input: { text: "x" } }) });
  await j("/employee-tasks/pull?limit=1", { method: "GET", headers: auth });
  await prisma.employeeTask.update({ where: { id: run2.body.id }, data: { updatedAt: new Date(Date.now() - 60 * 60_000), outputMeta: {} } });
  const rec1 = await j("/employee-execution/recover", { method: "POST", headers: auth, body: "{}" });
  const after1 = await prisma.employeeTask.findUnique({ where: { id: run2.body.id } });
  check("stalled requeued once", rec1.body.requeued >= 1 && after1.status === "queued" && (after1.outputMeta || {}).requeued === 1, { requeued: rec1.body.requeued, status: after1.status });

  // 5. 第三次 -> 判失败
  await j("/employee-tasks/pull?limit=1", { method: "GET", headers: auth });
  await prisma.employeeTask.update({ where: { id: run2.body.id }, data: { updatedAt: new Date(Date.now() - 60 * 60_000), outputMeta: { requeued: 2 } } });
  const rec2 = await j("/employee-execution/recover", { method: "POST", headers: auth, body: "{}" });
  const after2 = await prisma.employeeTask.findUnique({ where: { id: run2.body.id } });
  check("stalled fails after 2 requeues", rec2.body.failed >= 1 && after2.status === "failed" && /失败/.test(after2.error || ""), { failed: rec2.body.failed, status: after2.status });

  // 6. 执行节点心跳与离线判定
  const hb = await j("/employee-execution/heartbeat", { method: "POST", headers: auth, body: JSON.stringify({ deviceId: "smoke-device", executor: "desktop", metadata: { platform: "smoke" } }) });
  check("node heartbeat", hb.status === 201 || hb.status === 200, hb.body.status);
  const nodes = await j("/employee-execution/nodes", { headers: auth });
  check("node online", (nodes.body || []).some((n) => n.deviceId === "smoke-device" && n.effectiveStatus === "online"), (nodes.body || []).length);

  // 清理
  await prisma.employeeExecutionNode.deleteMany({ where: { deviceId: "smoke-device" } });
  const myTasks = await prisma.employeeTask.findMany({ where: { userId: u.id }, select: { id: true } });
  await prisma.employeeTaskArtifact.deleteMany({ where: { taskId: { in: myTasks.map((t) => t.id) } } });
  await prisma.employeeTask.deleteMany({ where: { userId: u.id } });
  await prisma.aiEmployeeInstall.deleteMany({ where: { userId: u.id } });
} catch (e) {
  check("unexpected error", false, String(e && e.stack || e));
} finally {
  await prisma.$disconnect();
  const failed = results.filter((r) => !r.ok);
  console.log("\nT-19: " + (results.length - failed.length) + "/" + results.length + (failed.length ? " FAILED: " + failed.map((f) => f.name).join(", ") : " ALL PASS"));
  process.exit(failed.length ? 1 : 0);
}
