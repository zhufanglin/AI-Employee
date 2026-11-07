#!/usr/bin/env node
/**
 * T-11 渠道结果推送单测（不需要真实微信 / 网桥 / 数据库）
 *
 * 直接加载 tsc 产物 dist/channels/dispatcher.service.js，注入假 prisma / 假员工服务 / 假渠道发送器，
 * 验证任务结束态被正确回推：
 *   1. succeeded            → 「任务已完成：<outputText>」
 *   2. awaiting_approval    → 直接把已产出的 outputText 推回去（不能只丢一句「请登录后台」）
 *   3. awaiting_approval 无产出 → 回落提示语
 *   4. failed               → 「任务处理失败：<error>」
 *   5. outputText 为空时回落到 artifact 文本
 * 前置：packages/server 已 tsc 编译（verify.ps1 会先编译）。
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const dispatcherPath = path.join(repoRoot, "packages/server/dist/channels/dispatcher.service.js");

let failures = 0;
let checks = 0;
function check(name, condition, detail = "") {
  checks += 1;
  if (condition) console.log("[PASS] " + name);
  else {
    failures += 1;
    console.log("[FAIL] " + name + (detail ? " | " + detail : ""));
  }
}

let ChannelDispatcherService;
let ACK_TEXT;
try {
  ({ ChannelDispatcherService, ACK_TEXT } = require(dispatcherPath));
} catch (error) {
  console.error("[FAIL] 无法加载 " + dispatcherPath + "：" + error.message);
  console.error("请先编译：node node_modules/typescript/bin/tsc -p packages/server/tsconfig.json");
  process.exit(1);
}

const chat = "文件传输助手";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 造一个 dispatcher 实例。
 * taskRef.value 是本轮任务快照（后续被轮询读取），artifactRef.value 是 artifact 回落文本。
 */
function makeDispatcher(taskRef, artifactRef) {
  const sent = [];
  const config = {
    employeeSlug: "boss-lead-radar",
    ownerUserId: "user-1",
    taskTimeoutMs: 60_000,
    taskPollMs: 40,
  };
  const prisma = {
    employeeTask: {
      async findUnique() {
        return taskRef.value;
      },
    },
    employeeTaskArtifact: {
      async findFirst() {
        return artifactRef.value;
      },
    },
  };
  const employees = {
    async run() {
      return { id: "task-1" };
    },
  };
  const channelStub = {
    async sendText(to, msg) {
      sent.push({ via: "wecom-or-mp", to, msg });
      return { ok: true };
    },
  };
  const personal = {
    async send(to, msg) {
      sent.push({ via: "personal", to, msg });
      return { ok: true };
    },
  };
  const dispatcher = new ChannelDispatcherService(config, prisma, employees, channelStub, channelStub, personal);
  return { dispatcher, sent };
}

async function runCase(name, task, artifact, expectText, expectContains) {
  const taskRef = { value: task };
  const artifactRef = { value: artifact };
  const { dispatcher, sent } = makeDispatcher(taskRef, artifactRef);
  const ack = await dispatcher.handleInbound({
    channel: "personal-wechat",
    fromUser: chat,
    msgType: "text",
    content: "看一下今天的行业动态",
    msgId: "m-" + name,
  });
  check(name + "：入站立刻回 ACK", ack === ACK_TEXT, "ack=" + JSON.stringify(ack));

  // 等轮询命中终态（pollTask 是异步 fire-and-forget）
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && sent.length === 0) await sleep(20);
  await sleep(120);

  const last = sent[sent.length - 1];
  if (!last) {
    check(name + "：结果已推回渠道", false, "没有收到任何推送");
    return;
  }
  check(name + "：结果已推回同一会话", last.via === "personal" && last.to === chat, JSON.stringify(last));
  const ok = expectContains
    ? last.msg.includes(expectContains)
    : last.msg === expectText;
  check(
    name + "：推送内容正确",
    ok,
    "got=" + JSON.stringify(String(last.msg).slice(0, 160)) + " expect=" + JSON.stringify(expectContains ?? expectText),
  );
}

const longText = "【初稿】\n1. 结论：先打护眼与智能联动两个卖点。\n2. 理由：客单价敏感度低、内容素材复用率高。";

await runCase(
  "succeeded 带产出",
  { id: "task-1", status: "succeeded", outputText: "任务跑完了的结论正文", error: null },
  { text: "" },
  "任务已完成：\n任务跑完了的结论正文",
  null,
);
await runCase(
  "awaiting_approval 带产出",
  { id: "task-1", status: "awaiting_approval", outputText: longText, error: null },
  { text: "" },
  null,
  "客单价敏感度低",
);
await runCase(
  "awaiting_approval 无产出",
  { id: "task-1", status: "awaiting_approval", outputText: "", error: null },
  { text: "" },
  "任务需要你补充信息或在后台确认，请登录平台后台处理。",
  null,
);
await runCase(
  "failed 网络抖动（引导重试）",
  { id: "task-1", status: "failed", outputText: "", error: "Bad Gateway Exception" },
  { text: "" },
  "这次没跑成功（服务端临时波动，通常是模型接口网络抖动）。把需求原样再发一遍就行，我会重新执行。",
  null,
);
await runCase(
  "failed 超时也按可重试处理",
  { id: "task-1", status: "failed", outputText: "", error: "模型超时" },
  { text: "" },
  "这次没跑成功（服务端临时波动，通常是模型接口网络抖动）。把需求原样再发一遍就行，我会重新执行。",
  null,
);
await runCase(
  "failed 非网络原因仍报原因",
  { id: "task-1", status: "failed", outputText: "", error: "余额不足，请充值" },
  { text: "" },
  "任务处理失败：余额不足，请充值",
  null,
);
await runCase(
  "outputText 空回落 artifact",
  { id: "task-1", status: "succeeded", outputText: "", error: null },
  { text: "artifact 里的正文" },
  "任务已完成：\nartifact 里的正文",
  null,
);

// ── 长结果：全文链接 ──────────────────────────────────────────────
// 个人微信单条上限 1500 字，超长时要推「前 N 字 + 全文链接」，不能再硬截断丢掉后文。
const veryLong = Array.from({ length: 120 }, (_, i) => "[段落" + (i + 1) + "] 这是很长的正文内容用于验证长结果回推。").join("\n");

process.env.PUBLIC_BASE_URL = "https://api.fcmediaagent.com";
try {
  const taskRef = { value: { id: "task-long", status: "awaiting_approval", outputText: veryLong, error: null } };
  const artifactRef = { value: { text: "" } };
  const { dispatcher, sent } = makeDispatcher(taskRef, artifactRef);
  await dispatcher.handleInbound({
    channel: "personal-wechat",
    fromUser: chat,
    msgType: "text",
    content: "写一份很长的方案",
    msgId: "m-long",
  });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && sent.length === 0) await sleep(20);
  await sleep(120);
  const last = sent[sent.length - 1];
  const msg = String(last?.msg ?? "");
  check(
    "长结果：推送里有全文链接",
    /https:\/\/api\.fcmediaagent\.com\/api\/channels\/result\/[A-Za-z0-9_-]+\?t=[0-9a-f]{32}/.test(msg),
    msg.slice(-160),
  );
  check("长结果：推送里有字数提示", /全文约 \d+ 字/.test(msg), msg.slice(-160));
  check("长结果：单条不超过 1500 字", msg.length <= 1500, "len=" + msg.length);
  check("长结果：保留了正文开头", msg.includes("[段落1]"), msg.slice(0, 80));
} finally {
  delete process.env.PUBLIC_BASE_URL;
}

// 未配置 PUBLIC_BASE_URL（本地/未上线）时必须退回截断，不能推一个空链接
{
  const taskRef = { value: { id: "task-long2", status: "awaiting_approval", outputText: veryLong, error: null } };
  const artifactRef = { value: { text: "" } };
  const { dispatcher, sent } = makeDispatcher(taskRef, artifactRef);
  await dispatcher.handleInbound({
    channel: "personal-wechat",
    fromUser: chat,
    msgType: "text",
    content: "写一份很长的方案",
    msgId: "m-long2",
  });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && sent.length === 0) await sleep(20);
  await sleep(120);
  const msg = String(sent[sent.length - 1]?.msg ?? "");
  check("无 PUBLIC_BASE_URL：退回截断提示", msg.includes("内容过长已截断"), msg.slice(-160));
  check("无 PUBLIC_BASE_URL：不含 result 链接", !msg.includes("/api/channels/result/"));
}

console.log("");
if (failures > 0) {
  console.error("T11 CHANNEL PUSH SMOKE FAILED (" + failures + "/" + checks + ")");
  process.exit(1);
}
console.log("T11 CHANNEL PUSH SMOKE OK (" + checks + " checks)");
