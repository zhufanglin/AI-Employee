#!/usr/bin/env node
/**
 * T-29 运营后台 Web 控制台冒烟
 * 断言：静态资源可达 + 未登录访问页面正常 + 管理 API 未授权 401 + 管理员登录可拿 token
 */
import { loadServerEnv } from "./_env.mjs";

loadServerEnv();

const BASE = process.env.FCM_API || "http://127.0.0.1:3000";
let pass = 0;
let fail = 0;
const results = [];

function ok(name, cond, extra = "") {
  if (cond) { pass++; results.push("PASS " + name); }
  else { fail++; results.push("FAIL " + name + (extra ? " -> " + extra : "")); }
}

async function get(path, init) {
  const r = await fetch(BASE + path, init);
  const text = await r.text();
  return { status: r.status, text, headers: r.headers };
}

// 1) 首页
const home = await get("/admin/");
ok("GET /admin/ 200", home.status === 200, home.status);
ok("首页标题含「运营后台」", home.text.includes("运营后台"));
ok("首页引用 app.js", home.text.includes("./app.js"));

// 2) 静态资源
const js = await get("/admin/app.js");
ok("GET /admin/app.js 200", js.status === 200, js.status);
ok("app.js 含 token 存储键", js.text.includes("fcm_admin_token"));
ok("app.js 含 admin 接口路径", js.text.includes("/admin/overview"));
const css = await get("/admin/styles.css");
ok("GET /admin/styles.css 200", css.status === 200, css.status);
ok("styles.css 含布局类", css.text.includes(".layout") && css.text.includes(".panel"));

// 3) /admin 重定向到 /admin/
const bare = await get("/admin", { redirect: "manual" });
ok("GET /admin 重定向或 200", bare.status === 301 || bare.status === 302 || bare.status === 200, bare.status);

// 4) 未登录保护
const unauth = await get("/api/admin/overview");
ok("未带令牌访问 /api/admin/overview 401", unauth.status === 401, unauth.status);

// 5) 管理员登录（后台前端用的同一入口）
const loginRes = await fetch(BASE + "/api/auth/admin/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    username: process.env.ADMIN_USERNAME || "admin",
    password: process.env.ADMIN_PASSWORD || "admin",
  }),
});
const loginBody = await loginRes.json().catch(() => ({}));
ok("管理员登录 201", loginRes.status === 201, loginRes.status);
ok("管理员登录返回 accessToken", typeof loginBody.accessToken === "string" && loginBody.accessToken.length > 20);

// 6) 带令牌访问后台首屏数据
if (loginBody.accessToken) {
  const auth = { headers: { authorization: "Bearer " + loginBody.accessToken } };
  const overview = await get("/api/admin/overview", auth);
  ok("带令牌 GET /api/admin/overview 200", overview.status === 200, overview.status);
  const body = JSON.parse(overview.text || "{}");
  ok("overview 含 users 字段", typeof body.users === "number", JSON.stringify(body).slice(0, 120));
  const site = await get("/api/admin/site-config", auth);
  ok("带令牌 GET /api/admin/site-config 200", site.status === 200, site.status);
}

console.log(results.join("\n"));
console.log("");
console.log(fail === 0 ? `ALL PASS (${pass})` : `${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
