#!/usr/bin/env node
/**
 * P42 冒烟：战略表 + 人设表
 * 静态部分：worker 注入函数 / 17 份 SKILL.md needs / 服务端模块与工作区落点 / 执行器接线 / 桌面页与 IPC
 * 在线部分：GET|PUT /strategy、GET /strategy/iterations、/personas 增删、工作区可见 企业战略.md
 * 用法：node scripts/smoke-p42-strategy.mjs   （需要本地 API 在 FCM_API_BASE，默认 http://127.0.0.1:3000/api）
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.FCM_API_BASE || "http://127.0.0.1:3000/api";
const PHONE = process.env.FCM_PHONE || "13900000002";
let pass = 0;
let token = "";

function ok(name, detail) { pass += 1; console.log("[PASS] " + name + (detail ? " :: " + detail : "")); }
function bad(name, detail) { console.log("[FAIL] " + name + " :: " + detail); process.exitCode = 1; }
function check(name, cond, detail) { if (cond) ok(name, detail); else bad(name, detail); }
function read(rel) { return readFileSync(join(ROOT, rel), "utf8"); }
function readBin(rel) { return readFileSync(rel); }

console.log("=== 静态：worker 注入链 ===");
const loop = read("packages/worker/tool-loop.mjs");
check("worker 导出 needsSection", /export function needsSection\s*\(/.test(loop));
check("worker 导出 strategySection", /export function strategySection\s*\(/.test(loop));
check("worker 导出 personaSection", /export function personaSection\s*\(/.test(loop));
check("战略预算 6000 字", /STRATEGY_BUDGET\s*=\s*6000/.test(loop));
check("人设预算 1500 字", /PERSONA_BUDGET\s*=\s*1500/.test(loop));
const fnStart = loop.indexOf("export async function runToolLoop");
const fnBody = loop.slice(fnStart);
const iNeeds = fnBody.indexOf("needsSection(needs)");
const iSkill = fnBody.indexOf("skillSection(skill)");
const iStrategy = fnBody.indexOf("strategySection(strategy");
const iPersona = fnBody.indexOf("personaSection(persona");
check("注入顺序 needs → skill → strategy → persona",
  fnStart > 0 && iNeeds > 0 && iSkill > iNeeds && iStrategy > iSkill && iPersona > iStrategy,
  "idx " + [iNeeds, iSkill, iStrategy, iPersona].join("/"));
check("runToolLoop 接受 strategy/persona/needs", /runToolLoop\(\{[^}]*strategy[^}]*persona[^}]*needs/s.test(loop) || (/strategy,[\s\S]{0,200}persona,[\s\S]{0,200}needs,/.test(loop)));
check("战略超长有截断标记", loop.includes("战略文档已截断"));
check("人设超长有截断标记", loop.includes("人设资料已截断"));

console.log("=== 静态：17 份 SKILL.md needs ===");
const skillsDir = join(ROOT, "packages/desktop/resources/skills");
const slugs = readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const withSkill = slugs.filter((slug) => existsSync(join(skillsDir, slug, "SKILL.md")));
check("员工技能目录 17 个", withSkill.length === 17, "count=" + withSkill.length);
let needsOk = 0;
let personaOk = 0;
let sizeOk = 0;
const problems = [];
for (const slug of withSkill) {
  const raw = readFileSync(join(skillsDir, slug, "SKILL.md"), "utf8");
  const bytes = readBin(join(skillsDir, slug, "SKILL.md")).length;
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const needsLine = fm && (fm[1].match(/^needs\s*:\s*(.*)$/m) || [])[1];
  if (!needsLine) { problems.push(slug + " 缺 needs"); continue; }
  const items = needsLine.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!items.length) { problems.push(slug + " needs 为空"); continue; }
  if (!items.some((it) => it.startsWith("strategy.sections:") || it === "strategy")) { problems.push(slug + " 没有战略授权"); continue; }
  needsOk += 1;
  if (items.includes("persona")) personaOk += 1;
  if (bytes <= 7500) sizeOk += 1; else problems.push(slug + " 超过 7500B");
}
check("17 份都有 needs 且含战略", needsOk === 17, needsOk + "/17 " + (problems.slice(0, 3).join("; ") || ""));
check("人设只给内容/流量类岗位（≥6 且 ≤7）", personaOk >= 6 && personaOk <= 7, "persona=" + personaOk);
check("技能体量都在 7500B 内", sizeOk === 17, sizeOk + "/17");

console.log("=== 静态：服务端 ===");
const svc = read("packages/server/src/strategy/strategy.service.ts");
check("导出企业战略文件名", svc.includes('STRATEGY_FILE = "企业战略.md"'));
check("战略 6000 字上限", /STRATEGY_MAX_CHARS\s*=\s*6000/.test(svc));
check("人设 1500 字上限", /PERSONA_MAX_CHARS\s*=\s*1500/.test(svc));
check("战略落到能力层工作区（userDir + userId）", svc.includes("userDir(await this.workspaceKeyOf") || svc.includes("userDir(key)"));
check("resolveForEmployee 带 userId", /resolveForEmployee\(userId: string, phone: string, needs: string\[\]\)/.test(svc));
check("按 needs 切片板块", svc.includes("strategy.sections:"));
check("返回战略版本元数据", svc.includes("strategyVersion") && svc.includes("strategyUpdatedAt"));
const schema = read("packages/server/prisma/schema.prisma");
check("Prisma 有 StrategyDoc", /^model StrategyDoc \{/m.test(schema));
check("Prisma 有 StrategyIteration", /^model StrategyIteration \{/m.test(schema));
check("Prisma 有 PersonaProfile", /^model PersonaProfile \{/m.test(schema));

console.log("=== 静态：执行器接线 ===");
const cloud = read("packages/worker/cloud-executor.mjs");
check("云端执行器读 strategyText", cloud.includes("task.strategyText"));
check("云端执行器读 personaText", cloud.includes("task.personaText"));
check("云端执行器读 employeeNeeds", cloud.includes("task.employeeNeeds"));
check("云端执行器传 strategyMeta", cloud.includes("strategyMeta"));
const deskExec = read("packages/desktop/src/main/executor.ts");
check("桌面执行器读 strategyText", deskExec.includes("strategyText"));
check("桌面执行器读 employeeNeeds", deskExec.includes("employeeNeeds"));
check("桌面执行器传 strategyMeta", deskExec.includes("strategyMeta"));
const pullSvc = read("packages/server/src/employee/employee.service.ts");
const claimSvc = read("packages/server/src/employee/employee-execution.service.ts");
check("桌面 pull 下发战略/人设", pullSvc.includes("strategyText") && pullSvc.includes("resolveForEmployee(userId, phone"));
check("云端 claim 下发战略/人设", claimSvc.includes("strategyText") && claimSvc.includes("resolveForEmployee(userId, phone"));

console.log("=== 静态：桌面端 ===");
const ops = read("packages/desktop/src/main/strategy-ops.ts");
for (const ch of ["strategy:get", "strategy:save", "strategy:iterations", "persona:list", "persona:save", "persona:remove"]) {
  check("IPC " + ch, ops.includes(ch));
}
const preload = read("packages/desktop/src/preload/index.ts");
check("preload 暴露 strategy", /strategy:\s*\{/.test(preload));
const page = read("packages/desktop/src/renderer/src/pages/Strategy.tsx");
check("战略页两 tab", page.includes("公司战略") && page.includes("账号人设"));
check("战略页有插入板块", page.includes("插入板块"));
check("战略页显示版本", page.includes("当前版本"));
const shell = read("packages/desktop/src/renderer/src/pages/Shell.tsx");
check("侧栏有战略与人设", shell.includes("战略与人设"));

console.log("=== 在线：REST 与工作区 ===");
async function call(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { ...options, headers });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

async function login() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sent = await call("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone: PHONE }) });
    const code = sent.body && (sent.body.devCode || (sent.body.data && sent.body.data.devCode));
    if (code) {
      const res = await call("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone: PHONE, code }) });
      const access = res.body && (res.body.accessToken || res.body.token || (res.body.data && res.body.data.accessToken));
      if (access) { token = access; return true; }
    }
    console.log("登录被频控或未拿到 devCode，等 62s 重试…");
    await new Promise((r) => setTimeout(r, 62000));
  }
  return false;
}

if (!(await login())) {
  bad("登录", "拿不到 devCode 或 token（本地需 DEV_RETURN_SMS_CODE=true）");
} else {
  ok("登录成功");
  const got = await call("/strategy");
  const doc = got.body && (got.body.data || got.body);
  check("GET /strategy 返回模板", got.status === 200 && typeof doc.content === "string" && doc.content.length > 200, "status=" + got.status + " chars=" + (doc && doc.content ? doc.content.length : 0));
  check("模板含 10 个板块", (doc.content || "").split(/^## /m).length - 1 >= 10, "sections=" + ((doc.content || "").split(/^## /m).length - 1));
  const v0 = doc.version || "V1.0";

  const edited = (doc.content || "") + "\n\n## 本季度目标\n- P42 冒烟写入的目标：把战略表接通到员工任务。\n";
  const saved = await call("/strategy", { method: "PUT", body: JSON.stringify({ content: edited, summary: "P42 冒烟保存" }) });
  const savedBody = saved.body && (saved.body.data || saved.body);
  check("PUT /strategy 保存成功", saved.status === 200, "status=" + saved.status + " " + JSON.stringify(saved.body).slice(0, 160));
  const v1 = savedBody && savedBody.version;
  check("版本号递增", !!v1 && v1 !== v0, v0 + " → " + v1);

  const its = await call("/strategy/iterations");
  const list = (its.body && (its.body.items || its.body.data || its.body)) || [];
  check("迭代记录已追加", Array.isArray(list) && list.length >= 1, "count=" + (Array.isArray(list) ? list.length : "n/a"));

  const files = await call("/workspace/files");
  const fileList = (files.body && (files.body.items || files.body.data || files.body)) || [];
  const names = Array.isArray(fileList) ? fileList.map((f) => f.name) : [];
  check("工作区可见 企业战略.md（员工 file_read 能读到）", names.includes("企业战略.md"), names.slice(0, 8).join(","));

  const personaName = "P42冒烟人设";
  const ps = await call("/personas", { method: "POST", body: JSON.stringify({ name: personaName, positioning: "自动化测试账号", plan: "专业、直接、不夸张", followers: "1.2万" }) });
  check("POST /personas 保存成功", ps.status === 200, "status=" + ps.status + " " + JSON.stringify(ps.body).slice(0, 160));
  const pl = await call("/personas");
  const personas = (pl.body && (pl.body.items || pl.body.data || pl.body)) || [];
  const mine = Array.isArray(personas) ? personas.find((p) => p.name === personaName) : null;
  check("GET /personas 能查到", !!mine, "count=" + (Array.isArray(personas) ? personas.length : "n/a"));
  const del = await call("/personas/" + (mine && mine.id), { method: "DELETE" });
  check("DELETE /personas 成功", del.status === 200, "status=" + del.status);
}

console.log("\nP42 STRATEGY RESULT: " + (process.exitCode ? "FAILED" : "ALL PASS") + " (" + pass + " checks)");
