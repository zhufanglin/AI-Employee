// T-14 管理端扩展路由冒烟：配置/定价/兑换码/用户/员工/用量/统计
import { loadServerEnv } from "./_env.mjs";

loadServerEnv();
const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:3000/api";
const ADMIN_USER = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASS = process.env.ADMIN_PASSWORD || "admin";

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra) {
  if (cond) { pass++; results.push(["PASS", name]); }
  else { fail++; results.push(["FAIL", name, extra === undefined ? "" : JSON.stringify(extra)]); }
}
async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json };
}

const login = await api("POST", "/auth/admin/login", { body: { username: ADMIN_USER, password: ADMIN_PASS } });
ok("admin login", login.status === 201 || login.status === 200, login);
const token = login.json?.accessToken || login.json?.token;
ok("admin token", Boolean(token), login.json);

// ---------- 站点配置 ----------
const site = await api("GET", "/admin/site-config", { token });
ok("GET site-config", site.status === 200 && site.json?.siteName, site.json);
const siteSave = await api("PUT", "/admin/site-config", { token, body: { siteName: site.json.siteName, freeMonthlyQuota: site.json.freeMonthlyQuota } });
ok("PUT site-config", siteSave.status === 200 && siteSave.json?.message, siteSave.json);

const ai = await api("GET", "/admin/ai-api-config", { token });
ok("GET ai-api-config masked", ai.status === 200 && typeof ai.json?.aiApiToken === "string" && (ai.json.aiApiToken === "" || ai.json.aiApiToken.includes("****")), ai.json);

const sms = await api("GET", "/admin/sms-config", { token });
ok("GET sms-config", sms.status === 200, sms.json);
const smsTest = await api("POST", "/admin/sms-test", { token, body: { phone: "13900001111" } });
ok("POST sms-test", smsTest.status === 200 || smsTest.status === 201, smsTest.json);

const oss = await api("GET", "/admin/oss-config", { token });
ok("GET oss-config", oss.status === 200, oss.json);
const payCfg = await api("GET", "/admin/wechat-pay-config", { token });
ok("GET wechat-pay-config", payCfg.status === 200, payCfg.json);
const sysInfo = await api("GET", "/admin/system-info", { token });
ok("GET system-info", sysInfo.status === 200 && sysInfo.json?.piracyContactWechat !== undefined, sysInfo.json);
const piracy = await api("GET", "/admin/system-info/piracy-warning", { token });
ok("GET piracy-warning", piracy.status === 200 && piracy.json?.warning !== undefined, piracy.json);

// ---------- 模型定价 ----------
const mp = await api("GET", "/admin/model-pricing", { token });
ok("GET model-pricing list", mp.status === 200 && Array.isArray(mp.json) && mp.json.length >= 11, mp.json?.length);
const created = await api("POST", "/admin/model-pricing", { token, body: { modelId: "smoke-t14-model", modelName: "冒烟模型", pricePerRequest: 3 } });
ok("POST model-pricing", created.status === 201 || created.status === 200, created.json);
const upd = await api("PUT", "/admin/model-pricing/" + (created.json?.id ?? "x"), { token, body: { pricePerRequest: 5, isActive: false } });
ok("PUT model-pricing", upd.status === 200 && upd.json?.pricePerRequest === 5, upd.json);
const dup = await api("POST", "/admin/model-pricing", { token, body: { modelId: "smoke-t14-model", modelName: "重复" } });
ok("POST model-pricing duplicate rejected", dup.status === 400, dup.json);
const del = await api("DELETE", "/admin/model-pricing/" + (created.json?.id ?? "x"), { token });
ok("DELETE model-pricing", del.status === 200 && del.json?.success, del.json);

// ---------- 媒体定价 ----------
const media = await api("GET", "/admin/media-pricing", { token });
ok("GET media-pricing list", media.status === 200 && Array.isArray(media.json) && media.json.length >= 6, media.json?.length);
const mCreated = await api("POST", "/admin/media-pricing", { token, body: { taskType: "smoke_t14_task", taskName: "冒烟任务", pricePerRequest: 7 } });
ok("POST media-pricing", mCreated.status === 201 || mCreated.status === 200, mCreated.json);
const mDel = await api("DELETE", "/admin/media-pricing/" + (mCreated.json?.id ?? "x"), { token });
ok("DELETE media-pricing", mDel.status === 200, mDel.json);

// ---------- 兑换码 ----------
const codes = await api("GET", "/admin/redemption-codes?limit=5", { token });
ok("GET redemption-codes", codes.status === 200 && Array.isArray(codes.json?.items), codes.json);
const codeUpd = codes.json?.items?.[0]
  ? await api("PUT", "/admin/redemption-codes/" + codes.json.items[0].id, { token, body: { note: "smoke-t14" } })
  : { status: 200, json: { ok: true } };
ok("PUT redemption-codes", codeUpd.status === 200, codeUpd.json);

// ---------- 用户 ----------
const phone = "137" + String(Date.now()).slice(-8);
const cu = await api("POST", "/admin/users", { token, body: { phone, nickname: "冒烟用户", password: "smoke1234", credits: 5 } });
ok("POST admin/users", (cu.status === 201 || cu.status === 200) && cu.json?.id, cu.json);
const cuDup = await api("POST", "/admin/users", { token, body: { phone, nickname: "重复" } });
ok("POST admin/users duplicate rejected", cuDup.status === 400, cuDup.json);
const st = await api("PUT", "/admin/users/" + (cu.json?.id ?? "x") + "/status", { token, body: { status: "disabled" } });
ok("PUT users/:id/status", st.status === 200 && st.json?.status === "disabled" && st.json?.passwordHash === undefined, st.json);
const stBad = await api("PUT", "/admin/users/" + (cu.json?.id ?? "x") + "/status", { token, body: { status: "bad" } });
ok("PUT users/:id/status invalid rejected", stBad.status === 400, stBad.json);
const pw = await api("PUT", "/admin/users/" + (cu.json?.id ?? "x") + "/password", { token, body: { password: "123" } });
ok("PUT users/:id/password too short rejected", pw.status === 400, pw.json);
const pwOk = await api("PUT", "/admin/users/" + (cu.json?.id ?? "x") + "/password", { token, body: { password: "newpass123" } });
ok("PUT users/:id/password ok", pwOk.status === 200, pwOk.json);

// ---------- 员工 ----------
const emps = await api("GET", "/admin/employees", { token });
ok("GET admin/employees", emps.status === 200 && Array.isArray(emps.json) && emps.json.length >= 17, emps.json?.length);
const firstEmp = emps.json?.[0];
const empDetail = await api("GET", "/admin/employees/" + (firstEmp?.slug ?? "x"), { token });
ok("GET employees/:slug", empDetail.status === 200 && empDetail.json?.slug === firstEmp?.slug, empDetail.json?.slug);
const toggle = await api("PUT", "/admin/employees/" + (firstEmp?.id ?? "x") + "/toggle", { token });
ok("PUT employees/:id/toggle", toggle.status === 200 && typeof toggle.json?.isActive === "boolean", toggle.json?.isActive);
await api("PUT", "/admin/employees/" + (firstEmp?.id ?? "x") + "/toggle", { token });
const sortRes = await api("PUT", "/admin/employees/sort", { token, body: { items: emps.json.slice(0, 3).map((e, i) => ({ id: e.id, sortOrder: i + 1 })) } });
ok("PUT employees/sort", sortRes.status === 200 && sortRes.json?.success, sortRes.json);
const empNew = await api("POST", "/admin/employees", { token, body: { slug: "smoke-t14-emp", name: "冒烟员工", price: 0 } });
ok("POST employees", (empNew.status === 201 || empNew.status === 200) && empNew.json?.slug === "smoke-t14-emp", empNew.json);
const empUpd = await api("PUT", "/admin/employees/smoke-t14-emp", { token, body: { description: "冒烟" } });
ok("PUT employees/:id", empUpd.status === 200 && empUpd.json?.description === "冒烟", empUpd.json?.description);
const empDel = await api("DELETE", "/admin/employees/smoke-t14-emp", { token });
ok("DELETE employees/:id", empDel.status === 200 && empDel.json?.success, empDel.json);
const purchases = await api("GET", "/admin/employee-purchases?limit=5", { token });
ok("GET employee-purchases", purchases.status === 200 && Array.isArray(purchases.json?.items), purchases.json);

// ---------- 用量与统计 ----------
const ur = await api("GET", "/admin/ai-usage-records?limit=5", { token });
ok("GET ai-usage-records", ur.status === 200 && Array.isArray(ur.json?.items), ur.json);
const us = await api("GET", "/admin/ai-usage-stats", { token });
ok("GET ai-usage-stats", us.status === 200 && typeof us.json?.totalRequests === "number" && Array.isArray(us.json?.modelBreakdown), us.json);
const uDaily = await api("GET", "/admin/usage/daily?days=7", { token });
ok("GET usage/daily", uDaily.status === 200 && Array.isArray(uDaily.json), uDaily.json);
const uByModel = await api("GET", "/admin/usage/by-model", { token });
ok("GET usage/by-model", uByModel.status === 200 && Array.isArray(uByModel.json), uByModel.json);
const uByUser = await api("GET", "/admin/usage/by-user", { token });
ok("GET usage/by-user", uByUser.status === 200 && Array.isArray(uByUser.json), uByUser.json);
const uSummary = await api("GET", "/admin/usage/summary", { token });
ok("GET usage/summary", uSummary.status === 200 && typeof uSummary.json?.totalRequests === "number", uSummary.json);
const ov = await api("GET", "/admin/statistics/overview", { token });
ok("GET statistics/overview", ov.status === 200 && ov.json?.users !== undefined, ov.json);
const rev = await api("GET", "/admin/statistics/revenue?days=7", { token });
ok("GET statistics/revenue", rev.status === 200 && Array.isArray(rev.json), rev.json);
const su = await api("GET", "/admin/statistics/users?days=7", { token });
ok("GET statistics/users", su.status === 200 && Array.isArray(su.json), su.json);
const sc = await api("GET", "/admin/statistics/credits", { token });
ok("GET statistics/credits", sc.status === 200 && Array.isArray(sc.json?.byType), sc.json);
const stTeam = await api("GET", "/admin/statistics/team", { token });
ok("GET statistics/team", stTeam.status === 200 && Array.isArray(stTeam.json?.packages), stTeam.json);

// ---------- 别名与补齐路由 ----------
const aliasLogin = await api("POST", "/admin/login", { body: { username: ADMIN_USER, password: ADMIN_PASS } });
ok("POST /admin/login alias", Boolean(aliasLogin.json?.accessToken), aliasLogin.status);
const putCredits = await api("PUT", "/admin/users/" + (cu.json?.id ?? "x") + "/credits", { token, body: { amount: 3, reason: "smoke-t14" } });
ok("PUT users/:id/credits", putCredits.status === 200, putCredits.json);
const batch = await api("POST", "/admin/redemption-codes", { token, body: { packageId: "traffic", count: 2, validDays: 15, note: "smoke-t14" } });
ok("POST redemption-codes batch", (batch.status === 201 || batch.status === 200) && (batch.json?.codes?.length >= 2 || batch.json?.count >= 2), batch.json);

// 1x1 PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const upQr = await api("POST", "/admin/upload-customer-service-qr", { token, body: { filename: "qr.png", data: PNG } });
ok("POST upload-customer-service-qr", (upQr.status === 201 || upQr.status === 200) && String(upQr.json?.url || "").includes("/uploads/customer-service-qr/"), upQr.json);
if (upQr.json?.url) {
  const pathOnly = String(upQr.json.url).replace(/^https?:\/\/[^/]+/, "");
  const fetched = await fetch(String(upQr.json.url));
  ok("uploaded file reachable", fetched.status === 200, pathOnly + " -> " + fetched.status);
}
const upAvatar = await api("POST", "/admin/employees/upload-avatar", { token, body: { slug: "smoke-t14-emp2", filename: "a.png", data: PNG } });
ok("POST employees/upload-avatar unknown employee -> 404", upAvatar.status === 404, upAvatar.status);
const emp2 = await api("POST", "/admin/employees", { token, body: { slug: "smoke-t14-emp2", name: "冒烟员工2" } });
const upAvatar2 = await api("POST", "/admin/employees/upload-avatar", { token, body: { slug: "smoke-t14-emp2", filename: "a.png", data: PNG } });
ok("POST employees/upload-avatar", (upAvatar2.status === 201 || upAvatar2.status === 200) && upAvatar2.json?.url, upAvatar2.json);
await api("DELETE", "/admin/employees/smoke-t14-emp2", { token });
void emp2;
const noData = await api("POST", "/admin/upload-win-client", { token, body: {} });
ok("POST upload-win-client without data -> 400", noData.status === 400, noData.json);
const detectIp = await api("POST", "/admin/system-info/detect-ip", { token });
ok("POST system-info/detect-ip", (detectIp.status === 201 || detectIp.status === 200) && detectIp.json?.ip !== undefined, detectIp.json);
const verifySys = await api("POST", "/admin/system-info/verify", { token });
ok("POST system-info/verify", (verifySys.status === 201 || verifySys.status === 200) && verifySys.json?.isAuthorized === true, verifySys.json);

// ---------- 鉴权 ----------
const noAuth = await api("GET", "/admin/site-config");
ok("GET site-config without token -> 401", noAuth.status === 401, noAuth.status);
const normalPhone = process.env.SMOKE_PHONE || "138" + String(Date.now()).slice(-8);
const userTok = await api("POST", "/auth/sms/send", { body: { phone: normalPhone } });
const userLogin = await api("POST", "/auth/sms/login", { body: { phone: normalPhone, code: userTok.json?.devCode } });
const userDenied = await api("GET", "/admin/site-config", { token: userLogin.json?.accessToken });
ok("GET site-config as normal user -> 403", userDenied.status === 403, userDenied.status);

for (const r of results) console.log(r.join(" ") + (r[2] ? "  " + r[2] : ""));
console.log(`\nT-14 SMOKE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 1 * 0 : 1);
