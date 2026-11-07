// T-36 冒烟：员工技能原文（SKILL.md）落库、按需下发
// 覆盖：catalog 不含 skillMd（体积保护）/ detail 含 skillMd / 桌面拉取任务带 employeeSkillMd / 内容来自 SKILL.md
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
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
async function login(phone) {
  const send = await j("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone }) });
  const res = await j("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone, code: send.body.devCode }) });
  return { token: res.body.accessToken, id: res.body.user?.id };
}
const results = [];
const check = (name, cond, detail) => { results.push({ name, ok: !!cond }); console.log((cond ? "PASS " : "FAIL ") + name, detail === undefined ? "" : JSON.stringify(detail)); };

const slug = "boss-lead-radar";
try {
  // 1. 库里 17 个员工都带 skillMd，且长度合理
  const rows = await prisma.aiEmployee.findMany({ select: { slug: true, skillMd: true } });
  const withSkill = rows.filter((r) => typeof r.skillMd === "string" && r.skillMd.length >= 500);
  check("db: 17 employees carry skillMd", rows.length === 17 && withSkill.length === 17, { total: rows.length, withSkill: withSkill.length });

  const target = rows.find((r) => r.slug === slug);
  const src = readFileSync("packages/desktop/resources/skills/" + slug + "/SKILL.md", "utf8");
  check("db: skillMd byte-equal to SKILL.md", target?.skillMd === src, { db: target?.skillMd?.length, file: src.length });

  const u = await login(process.env.SMOKE_PHONE || "139" + String(Date.now()).slice(-8));
  const auth = { authorization: "Bearer " + u.token };
  check("login", !!u.token);

  // 2. catalog 不返回 skillMd（体积保护）
  const catalog = await j("/employees/catalog", { headers: auth });
  const items = catalog.body.items || catalog.body.data || [];
  check("catalog: no skillMd field", items.length > 0 && items.every((it) => it.skillMd === undefined), { count: items.length });

  // 3. detail 返回 skillMd
  const detail = await j("/employees/" + slug, { headers: auth });
  check("detail: skillMd present", typeof detail.body.skillMd === "string" && detail.body.skillMd.length > 500, detail.body.skillMd?.length);

  // 4. 桌面任务 pull 时随任务下发 employeeSkillMd（执行器注入 system prompt 用）
  await j("/employees/" + slug + "/install", { method: "POST", headers: auth, body: "{}" });
  const run = await j("/employees/" + slug + "/run", { method: "POST", headers: auth, body: JSON.stringify({ executor: "desktop", title: "T-36 冒烟任务", input: { text: "产出选题" } }) });
  check("run queued desktop", run.status === 201 || run.status === 200, run.status);
  const pull = await j("/employee-tasks/pull?limit=1", { method: "GET", headers: auth });
  const task = (pull.body.items || [])[0];
  check("pull: employeeSkillMd attached", typeof task?.employeeSkillMd === "string" && task.employeeSkillMd.length > 500, task?.employeeSkillMd?.length);
  check("pull: employeeSkillMd matches employee", task?.employeeSkillMd === src.slice(0, task?.employeeSkillMd?.length), { pulled: task?.employeeSkillMd?.length, src: src.length });

  // 云端领取是独立接口，也必须携带同一员工技能。
  const cloudRun = await j("/employees/" + slug + "/run", { method: "POST", headers: auth, body: JSON.stringify({ executor: "cloud", title: "T-36 云技能冒烟", input: { text: "产出选题" } }) });
  const cloudPull = await j("/employee-execution/pull?limit=1", { method: "POST", headers: auth, body: "{}" });
  const cloudTask = (cloudPull.body.items || []).find(item => item.id === cloudRun.body.id);
  check("cloud pull: employeeSkillMd attached and matches", cloudTask?.employeeSkillMd === src, { length: cloudTask?.employeeSkillMd?.length });
  if (cloudTask?.id) await j("/employee-tasks/" + cloudTask.id, { method: "PATCH", headers: auth, body: JSON.stringify({ status: "failed", claimToken: cloudTask.outputMeta?.claimToken, error: "smoke-t36 cleanup" }) });

  // 清理：把冒烟任务收尾，避免后续 mock 执行器误跑
  if (task?.id) await j("/employee-tasks/" + task.id, { method: "PATCH", headers: auth, body: JSON.stringify({ status: "failed", error: "smoke-t36 cleanup" }) });
} catch (e) {
  check("no exception", false, String(e && e.message || e));
} finally {
  await prisma.$disconnect();
}
const failed = results.filter((r) => !r.ok);
console.log("\nT-36 smoke: " + (results.length - failed.length) + "/" + results.length + " passed");
if (failed.length) { console.log("FAILED: " + failed.map((r) => r.name).join(", ")); process.exit(1); }
