#!/usr/bin/env node
/**
 * P46 团队编排冒烟：校验 team_run 能力已注册、参数校验与「不能给自己派活」。
 * 通过 HTTP 打本地服务；POST /capabilities/run 出错也返回 201，成败一律看 body.success。
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 从 packages/server/.env 补齐 DATABASE_URL 等（Prisma 需要）
const ENV_PATH = fileURLToPath(new URL("../packages/server/.env", import.meta.url));
try {
  for (const line of readFileSync(ENV_PATH, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const val = m[2].trim().replace(/^"(.*)"$/, "$1");
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
} catch {
  /* 没有 .env 时交给调用方环境变量 */
}

const require2 = createRequire(fileURLToPath(new URL("../packages/server/package.json", import.meta.url)));
const { PrismaClient } = require2("@prisma/client");
const prisma = new PrismaClient();

const API = process.env.FCM_API || "http://127.0.0.1:3000/api";
const phone = "139" + String(Date.now()).slice(-8);
let pass = 0;
let fail = 0;

function check(name, ok, extra) {
  if (ok) {
    pass += 1;
    console.log("PASS " + name + (extra ? " " + JSON.stringify(extra) : ""));
  } else {
    fail += 1;
    console.log("FAIL " + name + " " + JSON.stringify(extra));
  }
}

async function j(path, init = {}) {
  const headers = { ...(init.headers || {}), connection: "close" };
  const res = await fetch(API + path, { ...init, headers });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const post = (path, token, obj) =>
  j(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: token ? "Bearer " + token : "",
      connection: "close",
    },
    body: JSON.stringify(obj),
  });

const sent = await post("/auth/sms/send", "", { phone });
let code = sent.body?.devCode;
if (!code) {
  // 本地/生产环境未回传 devCode（DEV_SMS_ALLOWLIST 之外的号码走真实下发）时，从库里取验证码
  const row = await prisma.verificationCode.findFirst({ where: { phone }, orderBy: { createdAt: "desc" } });
  code = row?.code;
}
const login = await post("/auth/sms/login", "", {
  phone,
  code,
  consent: { version: "2026-11-12", crossBorder: true, source: "smoke" },
});
const token = login.body?.accessToken || login.body?.token;
check("登录成功", !!token, { phone });

const list = await j("/capabilities", { headers: { authorization: "Bearer " + token } });
const descriptor = (list.body?.items || []).find((item) => item.name === "team_run");
check("能力清单包含 team_run", list.status === 200 && !!descriptor, {
  total: list.body?.total,
  title: descriptor?.title,
  category: descriptor?.category,
});
check(
  "team_run 描述符字段完整",
  !!descriptor &&
    descriptor.category === "employee" &&
    descriptor.title === "团队协作编排" &&
    typeof descriptor.params?.jobs === "string" &&
    typeof descriptor.params?.maxWaitSeconds === "string" &&
    typeof descriptor.params?.aggregate === "string",
  { params: descriptor?.params },
);

const empty = await post("/capabilities/run", token, { name: "team_run", params: { jobs: [] } });
check(
  "jobs 为空被拒绝且返回中文错误",
  empty.body?.success === false && /jobs|1-5|任务/.test(String(empty.body?.error || "")),
  { success: empty.body?.success, error: empty.body?.error },
);

const missing = await post("/capabilities/run", token, {
  name: "team_run",
  params: { jobs: [{ employeeSlug: "no-such-employee-p46", input: "调研一下行业动态" }] },
});
check(
  "不存在的员工 slug 被拒绝",
  missing.body?.success === false && /员工不存在|已下架/.test(String(missing.body?.error || "")),
  { success: missing.body?.success, error: missing.body?.error },
);

const employee = await prisma.aiEmployee.findFirst({ where: { isActive: true }, select: { slug: true } });
if (!employee) {
  check("传自己（无法测试）", false, { reason: "数据库中没有任何上架员工" });
} else {
  const self = await post("/capabilities/run", token, {
    name: "team_run",
    params: {
      jobs: [{ employeeSlug: employee.slug, input: "整理本周复盘" }],
      parentEmployeeSlug: employee.slug,
    },
  });
  check(
    "传自己（parentEmployeeSlug 与目标相同）被拒绝",
    self.body?.success === false && /不能给自己派活/.test(String(self.body?.error || "")),
    { slug: employee.slug, success: self.body?.success, error: self.body?.error },
  );
}

await prisma.$disconnect();
console.log("P46 TEAM RESULT: " + (fail === 0 ? "ALL PASS" : fail + " FAILED") + " (" + (pass + fail) + " checks)");
process.exitCode = fail === 0 ? 0 : 1;
