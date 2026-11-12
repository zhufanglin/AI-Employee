#!/usr/bin/env node
/**
 * P43 域 C：对话持久化 + 会话列表 + 中断（P0-2 / P1）
 * 静态：服务端 chat 模块/路由契约 + 桌面 IPC/preload/页面能力
 * 在线：建会话 → 追加消息（自动标题）→ 列表 → 详情 → 重命名 → 删除
 * 用法：node scripts/smoke-p43-chat.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.FCM_API_BASE || "http://127.0.0.1:3000/api";
const PHONE = process.env.FCM_PHONE || "13900000002";
let token = "";
let pass = 0;
function ok(n, d) { pass += 1; console.log("[PASS] " + n + (d ? " :: " + d : "")); }
function bad(n, d) { console.log("[FAIL] " + n + " :: " + d); process.exitCode = 1; }
function check(n, c, d) { if (c) ok(n, d); else bad(n, d); }
function read(rel) { return readFileSync(join(ROOT, rel), "utf8"); }
async function call(path, init = {}) {
  const headers = { "content-type": "application/json", ...(init.headers || {}) };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { ...init, headers });
  const text = await res.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

console.log("=== 静态：服务端 chat 模块 ===");
const schema = read("packages/server/prisma/schema.prisma");
check("有 ChatSession 表", /^model ChatSession \{/m.test(schema));
check("有 ChatMessage 表（长正文）", /^model ChatMessage \{/m.test(schema) && /content\s+String\s+@db\.LongText/.test(schema));
const svc = read("packages/server/src/chat/chat.service.ts");
check("会话按 userId 隔离", /userIdOf\(/.test(svc));
check("自动标题（新对话 → 首条正文）", svc.includes("新对话") && svc.includes("AUTO_TITLE"));
check("追加消息会 touch updatedAt", /updatedAt:\s*new Date\(\)/.test(svc));
const ctrl = read("packages/server/src/chat/chat.controller.ts");
check("PATCH 会话返回 200", /@Patch\("sessions\/:id"\)[\s\S]{0,80}@HttpCode\(HttpStatus\.OK\)/.test(ctrl));
check("追加消息返回 200", /@Post\("sessions\/:id\/messages"\)[\s\S]{0,80}@HttpCode\(HttpStatus\.OK\)/.test(ctrl));
const appModule = read("packages/server/src/app.module.ts");
check("ChatModule 已注册", /ChatModule/.test(appModule));

console.log("=== 静态：桌面端会话列表与中断 ===");
const mainTs = read("packages/desktop/src/main/index.ts");
for (const ch of ["chat:abort", "chat:sessions", "chat:session-create", "chat:session-get", "chat:session-rename", "chat:session-remove", "chat:session-append"]) {
  check("IPC " + ch, mainTs.includes("'" + ch + "'"));
}
check("chat:send 支持中断", /AbortController/.test(mainTs) && /aborted: true/.test(mainTs));
const preload = read("packages/desktop/src/preload/index.ts");
check("preload 暴露 abort", /abort:\s*\(/.test(preload));
check("preload 暴露 appendMessages", /appendMessages:\s*\(/.test(preload));
const chatTsx = read("packages/desktop/src/renderer/src/pages/Chat.tsx");
check("页面有会话列表", chatTsx.includes("session-list") || /sessions\(/.test(chatTsx));
check("页面有停止生成", chatTsx.includes("已停止生成"));
check("页面有模型随会话记忆", chatTsx.includes("renameSession"));
check("页面持久化消息", chatTsx.includes("appendMessages"));

async function login() {
  for (let i = 0; i < 3; i += 1) {
    const sent = await call("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone: PHONE }) });
    const code = sent.body && (sent.body.devCode || (sent.body.data && sent.body.data.devCode));
    if (code) {
      const res = await call("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone: PHONE, code, consent: { version: "2026-11-12", crossBorder: true, source: "smoke" } }) });
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
  const created = await call("/chat/sessions", { method: "POST", body: JSON.stringify({ model: "doubao-seed-2-0-lite" }) });
  const session = created.body && created.body.session;
  check("新建会话", created.status < 300 && !!session && !!session.id, "status=" + created.status);
  check("缺省标题为「新对话」", session && session.title === "新对话", session && session.title);
  if (session && session.id) {
    const sid = session.id;
    const first = await call("/chat/sessions/" + sid + "/messages", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "帮我写一个双十一活动文案，口语化一点" }] }) });
    check("追加用户消息", first.status === 200 && first.body && first.body.appended === 1, "status=" + first.status);
    const after = await call("/chat/sessions/" + sid);
    const doc = after.body || {};
    check("详情返回消息", Array.isArray(doc.messages) && doc.messages.length === 1, "len=" + (doc.messages ? doc.messages.length : 0));
    check("首条 user 消息自动成为标题", !!doc.session && doc.session.title !== "新对话" && doc.session.title.includes("双十一"), doc.session && doc.session.title);
    const second = await call("/chat/sessions/" + sid + "/messages", { method: "POST", body: JSON.stringify({ messages: [{ role: "assistant", content: "好的，给你三版口播文案。", tokensIn: 120, tokensOut: 64 }] }) });
    check("追加助手消息", second.status === 200 && second.body.appended === 1);
    const list = await call("/chat/sessions?limit=30");
    const items = (list.body && list.body.items) || [];
    const found = items.find((i) => i.id === sid);
    check("列表包含该会话", !!found, "count=" + items.length);
    check("列表带 messageCount 与 preview", !!found && found.messageCount === 2 && typeof found.preview === "string" && found.preview.length > 0, found ? JSON.stringify({ c: found.messageCount, p: found.preview.slice(0, 20) }) : "");
    const badRole = await call("/chat/sessions/" + sid + "/messages", { method: "POST", body: JSON.stringify({ messages: [{ role: "hacker", content: "x" }] }) });
    check("非法角色被拒", badRole.status >= 400, "status=" + badRole.status);
    const renamed = await call("/chat/sessions/" + sid, { method: "PATCH", body: JSON.stringify({ title: "双十一文案" }) });
    check("重命名会话返回 200", renamed.status === 200 && renamed.body.session.title === "双十一文案", "status=" + renamed.status);
    const emptyTitle = await call("/chat/sessions/" + sid, { method: "PATCH", body: JSON.stringify({ title: "  " }) });
    check("空标题被拒", emptyTitle.status >= 400, "status=" + emptyTitle.status);
    const removed = await call("/chat/sessions/" + sid, { method: "DELETE" });
    check("删除会话", removed.status < 300 && removed.body && removed.body.ok === true, "status=" + removed.status);
    const gone = await call("/chat/sessions/" + sid);
    check("删除后 404", gone.status === 404, "status=" + gone.status);
    const cross = await call("/chat/sessions/not-a-real-id");
    check("不存在/越权一律 404", cross.status === 404, "status=" + cross.status);
  }
}

console.log("\nP43-CHAT RESULT: " + (process.exitCode ? "FAILED" : "ALL PASS") + " (" + pass + " checks)");
