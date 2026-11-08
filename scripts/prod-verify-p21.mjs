#!/usr/bin/env node
/** 生产验收 P21：存量重复记忆清理（memory_dedupe）。 */
const BASE = process.env.FCM_API_BASE || "http://127.0.0.1:3000/api";
const PHONE = process.env.FCM_PHONE || "13900000002";
let token = "";
let pass = 0;
function ok(name, detail) { pass += 1; console.log("[PASS] " + name + (detail ? " :: " + detail : "")); }
function bad(name, detail) { console.log("[FAIL] " + name + " :: " + detail); process.exitCode = 1; }
function assert(name, cond, detail) { if (cond) ok(name, detail); else bad(name, detail); }
async function call(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { ...options, headers });
  const text = await res.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}
for (let attempt = 0; attempt < 3; attempt += 1) {
  const sent = await call("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone: PHONE }) });
  const code = sent.body && (sent.body.devCode || (sent.body.data && sent.body.data.devCode));
  if (code) {
    const res = await call("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone: PHONE, code }) });
    const access = res.body && (res.body.accessToken || res.body.token || (res.body.data && res.body.data.accessToken));
    if (access) { token = access; break; }
  }
  console.log("等待短信频控窗口 62s 后重试…");
  await new Promise((r) => setTimeout(r, 62000));
}
if (!token) throw new Error("登录失败");
console.log("登录成功");

async function run(name, params) {
  const started = Date.now();
  const res = await call("/capabilities/run", { method: "POST", body: JSON.stringify({ name, params }) });
  const ms = Date.now() - started;
  return { ok: !!(res.body && res.body.success), data: res.body && res.body.data, error: res.body && res.body.error, status: res.status, ms };
}

const MARK = "P21验收-" + Date.now();
const NAME = "赵姐" + String(Date.now()).slice(-4);
const created = {};

// 1) 用 dedupe=off 造 3 条「P20 之前那种写重的历史记忆」+ 1 条无关记忆
const seed = [
  { key: "a", content: MARK + "：客户" + NAME + "只接受季度付，报价必须含税，报关走宁波港。", title: MARK + " " + NAME + "报价", tags: "报价,客户" },
  { key: "b", content: MARK + "：" + NAME + "报价只收季度付，必须含税，出口报关口岸宁波港。", title: "", tags: "报价" },
  { key: "c", content: MARK + "：" + NAME + "那边从 12 月起账期改为 60 天，付款方式还是季度付、含税。", title: MARK + " " + NAME + "账期变更", tags: "账期,客户" },
  { key: "d", content: MARK + "：下周三全员例会改到下午四点，会议室 A。", title: MARK + " 例会", tags: "" },
];
for (const item of seed) {
  const res = await run("memory_save", { content: item.content, title: item.title || undefined, tags: item.tags || undefined, dedupe: "off" });
  created[item.key] = res.data && res.data.id;
  assert("造存量记忆 " + item.key + "（dedupe=off）", res.ok && !!created[item.key], "id=" + created[item.key]);
}
const ids = new Set(Object.values(created));

// 2) report 模式：给出合并建议、不动数据
const report = await run("memory_dedupe", { mode: "report", limit: 30 });
const proposals = (report.data && report.data.proposals) || [];
const ours = proposals.filter((p) => ids.has(p.keepId) || ids.has(p.dropId));
assert("report 出报告（成功调用）", report.ok, "calls=" + (report.data && report.data.calls) + " " + report.ms + "ms");
assert("report 找出这批写重的记忆", ours.length >= 1, JSON.stringify(ours.slice(0, 3)));
assert("report 建议里保留的是较早那条", ours.every((p) => new Date(p.keepCreatedAt).getTime() <= new Date(p.dropCreatedAt).getTime()), JSON.stringify(ours.map((p) => [p.keepCreatedAt, p.dropCreatedAt])));
assert("report 报告不改数据（4 条都还在）", (await run("memory_list", { limit: 50 })).data.items.filter((i) => ids.has(i.id)).length === 4, "count=" + (await run("memory_list", { limit: 50 })).data.items.filter((i) => ids.has(i.id)).length);

// 3) apply 模式：执行合并/删除
const apply = await run("memory_dedupe", { mode: "apply", limit: 30 });
assert("apply 执行了清理", apply.ok && apply.data.applied >= 1, "applied=" + (apply.data && apply.data.applied) + " " + apply.ms + "ms");

const after = (await run("memory_list", { limit: 50 })).data.items.filter((i) => ids.has(i.id));
assert("apply 后这批记忆变少了", after.length < 4, "before=4 after=" + after.length);
assert("无关记忆原样保留", after.some((i) => i.id === created.d), "kept=" + after.map((i) => i.id).join(","));
const merged = after.find((i) => i.id !== created.d);
assert("保留条正文含新旧事实（季度付 + 60 天）", !!merged && /季度/.test(merged.content) && /(60|六十)\s*天/.test(merged.content), merged ? merged.content.slice(0, 160) : "没有保留条");

// 4) 参数校验
const badMode = await run("memory_dedupe", { mode: "wipe" });
assert("非法 mode 被拒绝", !badMode.ok && String(badMode.error).includes("mode 只能是 report 或 apply"), badMode.error);

// 5) 清理测试数据
let removed = 0;
for (const item of after) {
  const res = await run("memory_delete", { id: item.id });
  if (res.ok) removed += 1;
}
assert("清理测试记忆", removed === after.length, "removed=" + removed);

console.log("");
if (pass && !process.exitCode) console.log("P21 PROD VERIFY GREEN (" + pass + " checks)");
else console.log("P21 PROD VERIFY FAILED (" + pass + " passed)");
