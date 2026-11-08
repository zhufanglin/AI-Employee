#!/usr/bin/env node
/**
 * 生产验收 P23：记忆管理 REST（/api/memory/list|stats|merge|dedupe + DELETE /api/memory/:id）。
 *
 * 流程：短信登录 13900000002 → 用 memory_save(dedupe=off) 造两条记忆 → list 命中 → stats
 *      → merge（故意传反，验证保留较早那条）→ list 只剩一条 → 删除 → 再删 404。
 *
 * 用法：
 *   FCM_API_BASE=http://127.0.0.1:3000 node scripts/prod-verify-p23.mjs
 *   FCM_API_BASE=https://api.fcmediaagent.com/api node scripts/prod-verify-p23.mjs
 * 生产有 60 秒短信频控：拿不到 devCode 时自动 sleep 62s 重试，最多 3 次。
 */
const RAW = (process.env.FCM_API_BASE || "http://127.0.0.1:3000").replace(/\/+$/, "");
const BASE = RAW.endsWith("/api") ? RAW : RAW + "/api";
const PHONE = process.env.FCM_PHONE || "13900000002";
let token = "";
let pass = 0;
function ok(name, detail) { pass += 1; console.log("[PASS] " + name + (detail !== undefined ? " :: " + JSON.stringify(detail) : "")); }
function bad(name, detail) { console.log("[FAIL] " + name + " :: " + String(detail)); process.exitCode = 1; }
function assert(name, cond, detail) { if (cond) ok(name, detail); else bad(name, detail); }
async function call(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { ...options, headers });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}
function dataOf(body) { return body && typeof body === "object" && body.data !== undefined ? body.data : body; }

// 1) 未登录不可访问
const anon = await call("/memory/list");
assert("未登录被拒（401）", anon.status === 401, "status=" + anon.status);

// 2) 短信登录（带 60s 频控重试）
for (let attempt = 0; attempt < 3 && !token; attempt += 1) {
  const sent = await call("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone: PHONE }) });
  const code = sent.body && (sent.body.devCode || (sent.body.data && sent.body.data.devCode));
  if (code) {
    const res = await call("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone: PHONE, code }) });
    const access = res.body && (res.body.accessToken || res.body.token || (res.body.data && res.body.data.accessToken));
    if (access) { token = access; break; }
  }
  if (attempt < 2) {
    console.log("等待短信频控窗口 62s 后重试…");
    await new Promise((r) => setTimeout(r, 62000));
  }
}
assert("短信登录成功", !!token, token ? "token 已获取" : "登录失败");
if (!token) { console.log("ABORT: 无法登录，请用 FCM_PHONE 覆盖手机号"); process.exit(1); }
console.log("BASE = " + BASE);

const MARK = "P23验收-" + Date.now();
const created = [];
async function saveMemory(content, title, tags) {
  const res = await call("/capabilities/run", {
    method: "POST",
    body: JSON.stringify({ name: "memory_save", params: { content, title, tags, dedupe: "off" } }),
  });
  const d = dataOf(res.body);
  return { status: res.status, ok: !!(res.body && res.body.success), id: d && d.id, body: res.body };
}
async function removeMemory(id) {
  return call("/memory/" + encodeURIComponent(id), { method: "DELETE" });
}

try {
  // 3) 造两条记忆（较早：报价口径；较晚：账期）
  const older = await saveMemory(MARK + "：赵姐只接受季度付，报价必须含税，报关走宁波港。", MARK + " 报价口径", "验收,报价");
  assert("造记忆 older（memory_save dedupe=off）", older.ok && !!older.id, "id=" + older.id);
  if (older.id) created.push(older.id);
  await new Promise((r) => setTimeout(r, 60));
  const newer = await saveMemory(MARK + "：赵姐从 12 月起账期改为 60 天，付款仍按季度。", MARK + " 账期", "验收,账期");
  assert("造记忆 newer（memory_save dedupe=off）", newer.ok && !!newer.id && newer.id !== older.id, "id=" + newer.id);
  if (newer.id) created.push(newer.id);
  if (!older.id || !newer.id) throw new Error("造数据失败，无法继续");

  // 4) list：命中两条、tags 是数组、按时间倒序
  const listed = await call("/memory/list?query=" + encodeURIComponent(MARK) + "&limit=20");
  const ld = dataOf(listed.body);
  const items = (ld && ld.items) || [];
  assert("list 返回 200", listed.status === 200, "status=" + listed.status);
  assert("list 命中刚造的两条", ld && ld.total === 2 && items.length === 2, { total: ld && ld.total, items: items.length });
  assert("list 排序为 createdAt 倒序（newer 在前）", items[0] && items[0].id === newer.id && items[1].id === older.id, items.map((i) => i.id));
  assert("list tags 返回数组", items.every((i) => Array.isArray(i.tags)), items.map((i) => i.tags));
  assert("list 契约字段齐全", items.every((i) => ["id", "kind", "title", "content", "tags", "hitCount", "createdAt", "updatedAt"].every((k) => k in i)), items[0] && Object.keys(items[0]));

  // 合并前两条的 hitCount 之和（hitCount 只在被检索命中时自增，新建记忆本来就是 0）
  const hitSum = items.reduce((acc, i) => acc + (typeof i.hitCount === "number" ? i.hitCount : 0), 0);

  // 5) stats：总数/分类/最近 7 天/标签
  const statsRes = await call("/memory/stats");
  const st = dataOf(statsRes.body);
  assert("stats 返回 200", statsRes.status === 200, "status=" + statsRes.status);
  assert("stats.total 是数字且 ≥2", !!(st && typeof st.total === "number" && st.total >= 2), st && st.total);
  assert("stats.byKind 四类齐全", !!(st && st.byKind && ["note", "fact", "preference", "lesson"].every((k) => typeof st.byKind[k] === "number")), st && st.byKind);
  assert("stats.last7d ≥2（刚写入的）", !!(st && st.last7d >= 2), st && st.last7d);
  assert("stats.topTags 是数组且 ≤8", !!(st && Array.isArray(st.topTags) && st.topTags.length <= 8), st && st.topTags && st.topTags.length);

  // 6) merge：故意传反，服务端必须保留 createdAt 更早的 older
  const merged = await call("/memory/merge", { method: "POST", body: JSON.stringify({ keepId: newer.id, dropId: older.id }) });
  const md = dataOf(merged.body);
  assert("merge 返回 200", merged.status === 200, "status=" + merged.status);
  assert("merge 返回实际保留条（较早的 older）", !!(md && md.id === older.id), md && md.id);
  assert("merge 正文非空", !!(md && typeof md.content === "string" && md.content.trim().length > 0), md && md.content && md.content.slice(0, 80));
  assert("merge tags 是数组", !!(md && Array.isArray(md.tags)), md && md.tags);
  assert("merge hitCount 为两条之和", !!(md && md.hitCount === hitSum), { got: md && md.hitCount, expect: hitSum });
  assert("merge mergedFrom 含被删除的 newer", !!(md && Array.isArray(md.mergedFrom) && md.mergedFrom.includes(newer.id)), md && md.mergedFrom);

  const afterMerge = await call("/memory/list?query=" + encodeURIComponent(MARK) + "&limit=20");
  const am = dataOf(afterMerge.body);
  const kept = (am && am.items) || [];
  assert("merge 后只剩保留条（标题仍带标记）", am && am.total === 1 && kept.length === 1 && kept[0].id === older.id, { total: am && am.total, ids: kept.map((i) => i.id) });

  // 7) 删除 + 再删 404
  const removed = await removeMemory(older.id);
  const rd = dataOf(removed.body);
  assert("DELETE 返回 200 且 success/id", removed.status === 200 && rd && rd.success === true && rd.id === older.id, { status: removed.status, body: rd });
  const afterDelete = await call("/memory/list?query=" + encodeURIComponent(MARK));
  const ad = dataOf(afterDelete.body);
  assert("删除后 list 查不到（total=0）", ad && ad.total === 0 && (ad.items || []).length === 0, { total: ad && ad.total });
  const again = await removeMemory(older.id);
  assert("重复删除返回 404", again.status === 404, "status=" + again.status);
  const message = (again.body && (again.body.message || (Array.isArray(again.body.message) ? again.body.message.join(" ") : ""))) || "";
  assert("404 文案为「记忆不存在或不属于你」", String(message).includes("记忆不存在或不属于你"), message);

  // 8) 参数校验：merge 同 id 400
  const same = await call("/memory/merge", { method: "POST", body: JSON.stringify({ keepId: "x", dropId: "x" }) });
  const sameMsg = same.body && same.body.message;
  assert("merge keepId=dropId 返回 400", same.status === 400, "status=" + same.status);
  assert("400 文案为「keepId 与 dropId 不能相同」", String(sameMsg).includes("keepId 与 dropId 不能相同"), sameMsg);
} finally {
  // 清理可能残留的测试记忆（失败中断时也尽量不留垃圾）
  for (const id of created) {
    try { await removeMemory(id); } catch { /* ignore */ }
  }
}

console.log("");
if (pass && !process.exitCode) console.log("P23 PROD VERIFY GREEN (" + pass + " checks)");
else console.log("P23 PROD VERIFY FAILED (" + pass + " passed)");
