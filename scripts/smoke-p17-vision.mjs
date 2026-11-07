#!/usr/bin/env node
/**
 * P17 看图理解能力单测：image_understand
 * 用假 providers 拦截上游调用，校验工作区图片、公网链接、参数与安全边界。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "p17-vision-ws-"));
process.env.WORKSPACE_DIR = workspace;
process.env.WORKSPACE_UPLOAD_MAX_BYTES = "52428800";
process.env.PUBLIC_BASE_URL = "https://api.example.com";
process.env.OSS_ACCESS_KEY_ID = "";
process.env.OSS_ACCESS_KEY_SECRET = "";
process.env.OSS_BUCKET = "";
process.env.OSS_REGION = "";
process.env.OSS_ENDPOINT = "";

const vision = require("../packages/server/dist/capabilities/capabilities/vision.js");
const files = require("../packages/server/dist/capabilities/capabilities/files.js");

const USER = "user-a";
const OTHER = "user-b";
let pass = 0;
function ok(name) { pass += 1; console.log("[PASS] " + name); }
function bad(name, detail) { console.log("[FAIL] " + name + " :: " + detail); process.exitCode = 1; }
function assert(name, cond, detail) { if (cond) ok(name); else bad(name, detail); }

/** 最小合法 JPEG 头（够 media 层识别，不真解码） */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);

const calls = [];
const providers = {
  resolve: async (alias) => ({ alias, provider: "ark", baseUrl: "https://ark.example.com", apiKey: "k", upstreamModel: "doubao-seed-2-1-pro-260628" }),
  chat: async (target, body) => {
    calls.push({ target, body });
    return { choices: [{ message: { content: "这是一张红色方块的图片。" } }], usage: { total_tokens: 42 } };
  },
};

const handlers = vision.buildVisionHandlers(providers);
const ctx = (params, userId = USER) => ({ userId, phone: "13900000000", params });

async function expectError(name, params, keyword, userId = USER) {
  try {
    await handlers.image_understand(ctx(params, userId));
    bad(name, "应当报错但没有");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(name, !keyword || message.includes(keyword), message);
  }
}

// 1) 描述符
assert("导出 image_understand 描述符", Array.isArray(vision.descriptors) && vision.descriptors.some((d) => d.name === "image_understand"));
const desc = vision.descriptors[0];
assert("描述符带 source 参数说明", typeof desc.params.source === "string" && desc.params.source.includes("工作区"));
assert("描述符 category 为 ai", desc.category === "ai");

// 2) 工作区图片
const saved = await files.saveWorkspaceFile(USER, "红色方块.jpg", JPEG);
assert("工作区写图成功", !!saved.file.key);
const byName = await handlers.image_understand(ctx({ source: "红色方块.jpg" }));
assert("按文件名理解图片成功", byName.text.includes("红色"), byName.text);
assert("返回模型别名", byName.model === "doubao-seed-2.0-lite", byName.model);
assert("返回 usage", byName.usage && byName.usage.total_tokens === 42);
assert("返回 source 元信息", byName.source && byName.source.name === "红色方块.jpg" && byName.source.bytes === JPEG.length, JSON.stringify(byName.source));
assert("图片以 base64 内联（未配 OSS）", byName.source.kind === "inline");

const last = calls[calls.length - 1].body;
assert("上游 messages 是数组", Array.isArray(last.messages) && last.messages.length === 1);
const parts = last.messages[0].content;
assert("content 是 2 段（文本 + 图片）", Array.isArray(parts) && parts.length === 2);
assert("第一段是文本问题", parts[0].type === "text" && parts[0].text.includes("描述"));
assert("第二段是 image_url", parts[1].type === "image_url" && String(parts[1].image_url.url).startsWith("data:image/jpeg;base64,"));
assert("透传了上游模型 id", last.model === "doubao-seed-2-1-pro-260628", last.model);

// 3) 按 key + 自定义问题 + 指定模型
const byKey = await handlers.image_understand(ctx({ source: saved.file.key, question: "图里是什么颜色？", model: "doubao-seed-2.0-pro" }));
assert("按 key 理解图片成功", byKey.text.length > 0);
assert("自定义问题透传给模型", calls[calls.length - 1].body.messages[0].content[0].text === "图里是什么颜色？");
assert("指定模型生效", byKey.model === "doubao-seed-2.0-pro", byKey.model);

// 4) 公网链接
const remote = await handlers.image_understand(ctx({ source: "https://1.1.1.1/pic.png" }));
assert("公网链接理解成功", remote.source.kind === "url");
assert("链接原样传给模型", calls[calls.length - 1].body.messages[0].content[1].image_url.url === "https://1.1.1.1/pic.png");

// 5) 参数与安全边界
await files.saveWorkspaceFile(USER, "笔记.md", Buffer.from("# 标题", "utf8"));
await expectError("缺 source 报错", {}, "source 必填");
await expectError("工作区没有该图片时报错", { source: "不存在.jpg" }, "找不到");
await expectError("非图片扩展名被拒", { source: "笔记.md" }, "只支持图片");
await expectError("内网链接被拒", { source: "http://127.0.0.1/a.png" }, "不允许访问");
await expectError("内网 IP 段被拒", { source: "http://192.168.1.5/a.png" }, "不允许访问");
await expectError("ftp 链接当文件名时找不到", { source: "ftp://example.com/a.png" }, "找不到");
await expectError("非法链接被拒", { source: "http://" }, "不合法");

// 6) 越权
try {
  await handlers.image_understand(ctx({ source: "红色方块.jpg" }, OTHER));
  bad("别的用户读不到这张图", "应当报错但没有");
} catch (error) {
  assert("别的用户读不到这张图", String(error.message).includes("找不到"), String(error.message));
}

// 8) 超限图片（假装 9MB）
const big = Buffer.concat([JPEG, Buffer.alloc(9 * 1024 * 1024)]);
const bigSaved = await files.saveWorkspaceFile(USER, "大图.jpg", big);
await expectError("超过 8MB 的图被拒", { source: bigSaved.file.name }, "8MB");

// 9) 模型空回复
providers.chat = async () => ({ choices: [{ message: { content: "" } }] });
await expectError("模型空回复时报错", { source: "红色方块.jpg" }, "没有返回可读内容");

console.log("");
console.log("P17 vision SMOKE OK (" + pass + " checks)");
