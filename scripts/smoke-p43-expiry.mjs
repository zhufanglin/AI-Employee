#!/usr/bin/env node
/**
 * P43 P1 冒烟：员工授权到期自动扫描（对齐原版 employee-expiry.scheduler.js）
 *
 * 静态：服务存在、启动即扫一次、按时长自排程、unref、幂等复用 orders.expireEmployees、
 *       注册进 EmployeeModule、admin 两个入口（GET status / POST run 必须 @HttpCode(200)）。
 * 在线：管理员登录 → GET /admin/employee-expiry（enabled=true、intervalMin=10、lastRun 非空）
 *       → POST /admin/employee-expiry/run（reason=管理员手动、字段齐全）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = process.env.FCM_API_BASE || "http://127.0.0.1:3000/api";
let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) {
    pass += 1;
    console.log("  [PASS] " + name);
  } else {
    fail += 1;
    failures.push(name + (extra ? " :: " + extra : ""));
    console.log("  [FAIL] " + name + (extra ? " :: " + extra : ""));
  }
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const service = read("packages/server/src/employee/employee-expiry.service.ts");
const moduleSrc = read("packages/server/src/employee/employee.module.ts");
const adminSrc = read("packages/server/src/admin/admin-extra.controller.ts");

console.log("[1] 服务实现");
check("服务类存在", /export class EmployeeExpiryService/.test(service));
check("启动即扫一次（补停机期间的过期）", /runOnce\("启动时扫描"\)/.test(service));
check("按时长自排程", /this\.intervalMin \* 60000/.test(service));
check("unref 不阻止进程退出", /\.unref\?\.\(\)/.test(service));
check("定时器清理 onApplicationShutdown", /onApplicationShutdown\(\)[\s\S]{0,200}clearTimeout/.test(service));
check("复用 orders.expireEmployees（幂等）", /this\.orders\.expireEmployees\(\)/.test(service));
check("env 开关 EMPLOYEE_EXPIRY_ENABLED", /EMPLOYEE_EXPIRY_ENABLED/.test(service));
check("env 周期 EMPLOYEE_EXPIRY_INTERVAL_MIN 默认 10", /EMPLOYEE_EXPIRY_INTERVAL_MIN", 10/.test(service));
check("status() 暴露 enabled/intervalMin/nextAt/lastRun", /enabled: this\.enabled[\s\S]{0,120}intervalMin: this\.intervalMin[\s\S]{0,200}lastRun/.test(service));

console.log("[2] 注册与入口");
check("EmployeeModule 注册 provider", /EmployeeExpiryService,/.test(moduleSrc) && /providers: \[/.test(moduleSrc));
check("EmployeeModule 导出", /exports: \[[^\]]*EmployeeExpiryService/.test(moduleSrc));
check("admin GET employee-expiry", /@Get\("employee-expiry"\)/.test(adminSrc));
check("admin POST employee-expiry/run", /@Post\("employee-expiry\/run"\)/.test(adminSrc));
check("POST run 带 @HttpCode(HttpStatus.OK)", /@Post\("employee-expiry\/run"\)\s*\n\s*@HttpCode\(HttpStatus\.OK\)/.test(adminSrc));

async function fetchJson(url, init, retries = 4) {
  let lastError;
  for (let i = 0; i < retries; i += 1) {
    try {
      const res = await fetch(url, init);
      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      return { status: res.status, body };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw lastError;
}

console.log("[3] 在线（本地 API）");
const login = await fetchJson(API + "/admin/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: process.env.ADMIN_USERNAME || "admin", password: process.env.ADMIN_PASSWORD || "admin" }),
});
check("管理员登录 200/201", login.status === 200 || login.status === 201, "status=" + login.status + " body=" + JSON.stringify(login.body).slice(0, 160));
const token = login.body?.accessToken || login.body?.token || login.body?.access_token;
check("拿到管理员 token", !!token);

const headers = { authorization: "Bearer " + token };
const status = await fetchJson(API + "/admin/employee-expiry", { headers });
check("GET /admin/employee-expiry 200", status.status === 200, "status=" + status.status);
const body = status.body || {};
check("enabled=true", body.enabled === true);
check("intervalMin=10（默认）", body.intervalMin === 10);
check("lastRun 有启动扫描记录", !!body.lastRun && body.lastRun.reason === "启动时扫描", JSON.stringify(body.lastRun));
check("lastRun 字段齐全", !!body.lastRun && Number.isFinite(body.lastRun.expiredPurchases) && Number.isFinite(body.lastRun.closedOrders));

const run = await fetchJson(API + "/admin/employee-expiry/run", { method: "POST", headers });
check("POST /admin/employee-expiry/run 200", run.status === 200, "status=" + run.status);
check("手动扫描 reason=管理员手动", run.body?.reason === "管理员手动", JSON.stringify(run.body));

console.log("");
if (fail === 0) {
  console.log("P43 EMPLOYEE EXPIRY SMOKE OK (" + pass + " checks)");
  process.exit(0);
}
console.log("P43 EMPLOYEE EXPIRY SMOKE FAILED (" + pass + "/" + (pass + fail) + ")");
for (const item of failures) console.log("  - " + item);
process.exit(1);
