#!/usr/bin/env node
/** 生产验收 P48：source_check（来源核对）—— 真实联网 + 入口校验 + claims/text 两种入参。 */
const BASE = process.env.FCM_API_BASE || "http://127.0.0.1:3000/api";
const PHONE = process.env.FCM_PHONE || "13900000002";
let token = "";
let pass = 0;
function ok(name, detail) { pass += 1; console.log("[PASS] " + name + (detail ? " :: " + detail : "")); }
function bad(name, detail) { console.log("[FAIL] " + name + " :: " + detail); process.exitCode = 1; }
function assert(name, cond, detail) { if (cond) ok(name, detail); else bad(name, detail); }

async function call(path, options = {}) {
  const headers = { "content-type": "application/json", connection: "close", ...(options.headers || {}) };
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
      const res = await call("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone: PHONE, code, consent: { version: "2026-11-12", crossBorder: true, source: "prod-verify-p48" } }) });
      const access = res.body && (res.body.accessToken || res.body.token || (res.body.data && res.body.data.accessToken));
      if (access) { token = access; return; }
      console.log("登录返回：" + JSON.stringify(res.body).slice(0, 200));
    }
    console.log("等待短信频控窗口 62s 后重试…");
    await new Promise((r) => setTimeout(r, 62000));
  }
  throw new Error("登录失败");
}

async function run(params) {
  const res = await call("/capabilities/run", { method: "POST", body: JSON.stringify({ name: "source_check", params }) });
  const data = res.body && (res.body.data || res.body.result);
  return { status: res.status, success: !!(res.body && res.body.success), data, body: res.body };
}

await login();
console.log("登录成功，开始 P48 生产验收");

// 1) 能力清单里有 source_check
const caps = await call("/capabilities");
const list = (caps.body && (caps.body.data || caps.body.items || caps.body)) || [];
const names = Array.isArray(list) ? list.map((x) => x && x.name) : [];
assert("能力清单含 source_check", names.includes("source_check"), "total=" + names.length);

// 2) 真实页面 + 页面里真实存在的原句 -> verified
const good = await run({ claims: [{ url: "https://example.com", quote: "Example Domain" }] });
const g = good.data && good.data.items && good.data.items[0];
assert("真实网页核对调用成功（HTTP 2xx）", good.status === 200 || good.status === 201, "status=" + good.status + " " + JSON.stringify(good.body).slice(0, 200));
assert("页面里存在的原句判 verified", !!g && g.verdict === "verified", g && (g.verdict + " mode=" + g.matchMode + " chars=" + g.chars));
assert("返回链接标题与字数", !!g && !!g.title && g.chars > 0, g && (g.title + " " + g.chars));
assert("汇总里 verified=1", !!good.data && good.data.verified === 1, good.data && good.data.summary);

// 3) 同一页面 + 页面里不存在的原句 -> quote-not-found（这是最关键的「不编造」能力）
const miss = await run({ claims: [{ url: "https://example.com", quote: "本页面根据艾瑞咨询 2026 年白皮书显示家装线索转化率为 12.8%" }] });
const mm = miss.data && miss.data.items && miss.data.items[0];
assert("页面里没有的原句判 quote-not-found", !!mm && mm.verdict === "quote-not-found", mm && (mm.verdict + " mode=" + mm.matchMode + " ratio=" + mm.matchRatio));
assert("汇总里 quoteNotFound=1", !!miss.data && miss.data.quoteNotFound === 1, miss.data && miss.data.summary);

// 4) 打不开的域名 -> unreachable
const dead = await run({ urls: ["https://no-such-host-p48-accept.invalid/news"] });
const dd = dead.data && dead.data.items && dead.data.items[0];
assert("打不开的域名判 unreachable", !!dd && dd.verdict === "unreachable", dd && dd.verdict);

// 5) 内网地址被守卫拒绝（不因核对能力变成 SSRF 通道）
const inner = await run({ urls: ["http://127.0.0.1:3000/api/health"] });
const ii = inner.data && inner.data.items && inner.data.items[0];
assert("内网地址不判 verified", !!ii && ii.verdict === "unreachable", ii && ii.verdict);
assert("内网地址提示禁止访问内网", !!ii && String(ii.message).includes("内网"), ii && ii.message);

// 6) text 入参自动抽链接
const auto = await run({ text: "参考 https://example.com 的说明，以及 https://example.com 重复一次", quote: "Example Domain" });
assert("text 入参自动抽链接且去重", !!auto.data && auto.data.total === 1, auto.data && auto.data.summary);
assert("text 入参也能判 verified", !!auto.data && auto.data.verified === 1, auto.data && auto.data.summary);

// 7) 入口校验：超过 8 条 / 非 http 网址 -> 中文报错（success=false）
const tooMany = await run({ urls: Array.from({ length: 9 }, (_, i) => "https://example.com/?i=" + i) });
const tmErr = JSON.stringify(tooMany.body || "");
assert("超过 8 条被拒且提示中文", tooMany.success === false && tmErr.includes("8"), tmErr.slice(0, 160));
const ftp = await run({ urls: ["ftp://example.com/a"] });
assert("非 http 网址被拒且提示中文", ftp.success === false && JSON.stringify(ftp.body).includes("http"), JSON.stringify(ftp.body).slice(0, 160));

// 8) strict 模式：有未通过的就直接报错
const strict = await run({ claims: [{ url: "https://example.com", quote: "完全不存在的一句话 p48" }], strict: true });
assert("strict 模式下有未通过即报错", strict.success === false, JSON.stringify(strict.body).slice(0, 200));

console.log("");
console.log("P48 PROD VERIFY " + (process.exitCode === 1 ? "FAILED" : "OK") + " (" + pass + " checks passed)");
