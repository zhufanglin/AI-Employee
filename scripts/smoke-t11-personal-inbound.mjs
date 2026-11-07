#!/usr/bin/env node
/**
 * T-11 个人微信「入站 → 员工任务 → 回推」链路单测（不需要真实微信 / 网桥）
 *
 * 直接加载 tsc 产物 dist/channels/personal-wechat.poller.js，注入假 bridge 与假 dispatcher，
 * 验证：新消息只处理一次、自己发的消息忽略、非文本消息回提示、ACK 回推到同一会话。
 * 前置：packages/server 已 tsc 编译（npm run verify / verify.ps1 会先编译）。
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const pollerPath = path.join(repoRoot, "packages/server/dist/channels/personal-wechat.poller.js");

let failures = 0;
let checks = 0;
function check(name, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log("[PASS] " + name);
  } else {
    failures += 1;
    console.log("[FAIL] " + name + (detail ? " | " + detail : ""));
  }
}

let PersonalWeChatPoller;
let PersonalWeChatOwnTexts;
try {
  ({ PersonalWeChatPoller } = require(pollerPath));
  ({ PersonalWeChatOwnTexts } = require(path.join(repoRoot, "packages/server/dist/channels/personal-wechat.own-texts.js")));
} catch (error) {
  console.error("[FAIL] 无法加载 " + pollerPath + "：" + error.message);
  console.error("请先编译：node node_modules/typescript/bin/tsc -p packages/server/tsconfig.json");
  process.exit(1);
}

const chat = "文件传输助手";
const now = Math.floor(Date.now() / 1000);

function makePoller(itemsRef, sent, options = {}) {
  const config = {
    personalChats: [chat],
    personalPollMs: 60_000,
    personalAllowSelf: options.allowSelf === true,
    isPersonalWeChatConfigured: () => true,
  };
  const bridge = {
    async listen() {
      return { ok: true };
    },
    async messages() {
      return { ok: true, chat_name: chat, items: itemsRef.value };
    },
    async send(name, msg) {
      sent.push({ name, msg });
      return { ok: true };
    },
  };
  const handled = [];
  const dispatcher = {
    async handleInbound(msg) {
      handled.push(msg);
      return "已收到，正在处理，稍后把结果发给你";
    },
  };
  const ownTexts = new PersonalWeChatOwnTexts();
  const poller = new PersonalWeChatPoller(config, bridge, dispatcher, ownTexts);
  poller.onModuleInit();
  return { poller, handled, ownTexts };
}

async function main() {
  // --- 场景 1：陌生人发来一条文本 → 建任务 + ACK 回推；重复轮询不重复处理 ---
  const sent = [];
  const itemsRef = {
    value: [
      { id: "m1", from: "我", text: "我自己发的", ts: now - 5, type: "text" },
      { id: "m2", from: "客户A", text: "帮我看下今天有什么 AI 政策", ts: now, type: "text" },
    ],
  };
  const { poller, handled } = makePoller(itemsRef, sent);
  await poller.tick();
  check(
    "入站文本：只把对方消息交给 dispatcher",
    handled.length === 1 && handled[0].content === "帮我看下今天有什么 AI 政策",
    JSON.stringify(handled),
  );
  check(
    "入站文本：channel 标记为 personal-wechat 且带 msgId",
    handled[0] && handled[0].channel === "personal-wechat" && handled[0].msgId === "m2",
    JSON.stringify(handled[0] ?? null),
  );
  check(
    "入站文本：ACK 回推到同一会话",
    sent.length === 1 && sent[0].name === chat && sent[0].msg.includes("已收到"),
    JSON.stringify(sent),
  );

  await poller.tick();
  check("重复轮询：同一消息不重复建任务", handled.length === 1 && sent.length === 1, "handled=" + handled.length + " sent=" + sent.length);

  // --- 场景 2：增量新消息会被处理 ---
  itemsRef.value = [
    ...itemsRef.value,
    { id: "m3", from: "客户A", text: "再帮我写个周报", ts: now + 10, type: "text" },
  ];
  await poller.tick();
  check("增量消息：新消息被处理", handled.length === 2 && handled[1].content === "再帮我写个周报", JSON.stringify(handled.map((h) => h.content)));

  // --- 场景 3：非文本消息只回提示，不建任务 ---
  const sent2 = [];
  const itemsRef2 = {
    value: [{ id: "m9", from: "客户B", text: "[图片]", ts: now, type: "image" }],
  };
  const { poller: poller2, handled: handled2 } = makePoller(itemsRef2, sent2);
  await poller2.tick();
  check(
    "非文本消息：不建任务，只回提示",
    handled2.length === 0 && sent2.length === 1 && sent2[0].msg.includes("只支持文字"),
    JSON.stringify({ handled: handled2, sent: sent2 }),
  );

  // --- 场景 4：启动前的历史消息不回溯 ---
  const sent3 = [];
  const itemsRef3 = { value: [{ id: "old", from: "客户C", text: "很久以前", ts: now - 3600, type: "text" }] };
  const { poller: poller3, handled: handled3 } = makePoller(itemsRef3, sent3);
  await poller3.tick();
  check("历史消息：启动前的消息不处理", handled3.length === 0 && sent3.length === 0, JSON.stringify({ handled: handled3, sent: sent3 }));

  // --- 场景 5：自测模式（WECHAT_PERSONAL_ALLOW_SELF=1，只有一个微信号时用） ---
  const sent4 = [];
  const itemsRef4 = {
    value: [{ id: "s1", from: "我", text: "从手机发的一条需求：写个周报", ts: now, type: "text" }],
  };
  const r4 = makePoller(itemsRef4, sent4, { allowSelf: true });
  await r4.poller.tick();
  check(
    "自测模式：「我」发的消息也被处理（默认模式会忽略）",
    r4.handled.length === 1 && r4.handled[0].content.includes("写个周报"),
    JSON.stringify(r4.handled),
  );
  check(
    "自测模式：ACK 已登记为自有文本（防自问自答）",
    r4.ownTexts.has(chat, "已收到，正在处理，稍后把结果发给你"),
    JSON.stringify(sent4),
  );

  // 机器人自己刚回的 ACK 出现在消息流里 → 不能再当新需求
  itemsRef4.value = [
    ...itemsRef4.value,
    { id: "s2", from: "我", text: "已收到，正在处理，稍后把结果发给你", ts: now + 3, type: "text" },
  ];
  await r4.poller.tick();
  check(
    "自测模式：机器人自己的回复不会被当成新需求（无自问自答）",
    r4.handled.length === 1 && sent4.length === 1,
    "handled=" + r4.handled.length + " sent=" + sent4.length,
  );

  // 默认模式（生产）对「我」的消息依然严格忽略
  const sent5 = [];
  const itemsRef5 = { value: [{ id: "s9", from: "我", text: "这条不该被处理", ts: now, type: "text" }] };
  const r5 = makePoller(itemsRef5, sent5);
  await r5.poller.tick();
  check("默认模式：「我」发的一律忽略", r5.handled.length === 0 && sent5.length === 0, JSON.stringify(sent5));

  poller.onModuleDestroy();
  poller2.onModuleDestroy();
  poller3.onModuleDestroy();
  r4.poller.onModuleDestroy();
  r5.poller.onModuleDestroy();

  console.log("");
  if (failures > 0) {
    console.log("T11 PERSONAL INBOUND SMOKE FAILED (" + failures + "/" + checks + ")");
    process.exit(1);
  }
  console.log("T11 PERSONAL INBOUND SMOKE OK (" + checks + " checks)");
}

main().catch((error) => {
  console.error("[FAIL] 未捕获异常：" + (error?.stack ?? error));
  process.exit(1);
});
