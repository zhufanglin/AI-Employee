#!/usr/bin/env node
/** P24 平台发布能力描述符单测：只校验 descriptors 与「云执行器必失败」的 handler 契约，不依赖 electron、不连数据库。 */
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const tools = require("../packages/server/dist/capabilities/capabilities/platform-tools.js");

let pass = 0;
let fail = 0;

function ok(name) { pass += 1; console.log("[PASS] " + name); }
function bad(name, detail) { fail += 1; console.log("[FAIL] " + name + " :: " + detail); }
async function check(name, fn) {
  try { const v = await fn(); ok(name); return v; }
  catch (e) { bad(name, e && e.message ? e.message : String(e)); return undefined; }
}
async function rejects(name, fn, needle) {
  try {
    await fn();
    bad(name, "未抛错");
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (needle && !msg.includes(needle)) bad(name, "错误文案不含「" + needle + "」，实际：" + msg);
    else ok(name);
  }
}

const EXPECTED = ["platform_publish", "platform_status", "platform_stats"];
const PLATFORMS = ["douyin", "xiaohongshu", "shipinhao"];

// ---------- descriptors ----------
await check("descriptors 恰好包含 3 个能力且命名/顺序正确", () => {
  assert.deepEqual(tools.descriptors.map((d) => d.name), EXPECTED);
});

await check("descriptors 全部 category=platform、title/description 非空", () => {
  for (const d of tools.descriptors) {
    assert.equal(d.category, "platform", d.name + " 的 category 应为 platform");
    assert.equal(typeof d.title, "string");
    assert.ok(d.title.length > 0, d.name + " 缺 title");
    assert.equal(typeof d.description, "string");
    assert.ok(d.description.length > 0, d.name + " 缺 description");
    assert.equal(typeof d.params, "object");
  }
});

await check("platform_publish：params 六项齐全（platform/type/title/content/tags/mediaPaths）", () => {
  const d = tools.descriptors.find((x) => x.name === "platform_publish");
  assert.deepEqual(Object.keys(d.params).sort(), ["content", "mediaPaths", "platform", "tags", "title", "type"]);
});

await check("platform_publish：platform 枚举为 douyin|xiaohongshu|shipinhao", () => {
  const d = tools.descriptors.find((x) => x.name === "platform_publish");
  for (const p of PLATFORMS) assert.ok(d.params.platform.includes(p), "platform 缺 " + p);
  assert.ok(d.params.platform.includes("|"), "platform 枚举应写成 a|b|c");
});

await check("platform_publish：type 枚举为 video|image", () => {
  const d = tools.descriptors.find((x) => x.name === "platform_publish");
  assert.ok(d.params.type.includes("video"), "type 缺 video");
  assert.ok(d.params.type.includes("image"), "type 缺 image");
});

await check("platform_publish：mediaPaths 标明本机绝对路径、多个用逗号分隔", () => {
  const d = tools.descriptors.find((x) => x.name === "platform_publish");
  assert.ok(d.params.mediaPaths.includes("本机绝对路径"), "mediaPaths 应说明本机绝对路径");
  assert.ok(d.params.mediaPaths.includes("逗号"), "mediaPaths 应说明多个用逗号分隔");
});

await check("platform_publish：description 说明创作后台自动发布且需桌面端已登录", () => {
  const d = tools.descriptors.find((x) => x.name === "platform_publish");
  assert.ok(d.description.includes("创作后台"), "description 应提到创作后台");
  assert.ok(d.description.includes("桌面端"), "description 应提到桌面端");
  assert.ok(d.description.includes("登录"), "description 应提到登录");
});

await check("platform_status：只有 platform 一个参数且写明留空查全部", () => {
  const d = tools.descriptors.find((x) => x.name === "platform_status");
  assert.deepEqual(Object.keys(d.params), ["platform"]);
  assert.ok(d.params.platform.includes("留空"), "platform_status 的 platform 应说明留空查全部");
});

await check("platform_stats：params 含 platform", () => {
  const d = tools.descriptors.find((x) => x.name === "platform_stats");
  assert.deepEqual(Object.keys(d.params), ["platform"]);
});

// ---------- handlers：云执行器一律拿到中文提示 ----------
await check("buildPlatformHandlers 返回三个 handler 且都是函数", () => {
  const handlers = tools.buildPlatformHandlers();
  assert.deepEqual(Object.keys(handlers).sort(), EXPECTED.slice().sort());
  for (const name of EXPECTED) assert.equal(typeof handlers[name], "function", name + " 不是函数");
});

for (const name of EXPECTED) {
  await rejects(name + "：云端调用抛出含「桌面端」的中文错误", async () => {
    await tools.buildPlatformHandlers()[name]({ userId: "u1", phone: null, params: {} });
  }, "桌面端");
}

await check("handler 抛的是 BadRequestException（HTTP 400）", async () => {
  try {
    await tools.buildPlatformHandlers().platform_publish({ userId: "u1", phone: null, params: {} });
    throw new Error("未抛错");
  } catch (e) {
    assert.equal(e.getStatus ? e.getStatus() : e.status, 400);
    assert.equal(e.getResponse && e.getResponse().message ? e.getResponse().message : e.message, "平台发布需要在桌面端（本机）执行，请在客户端登录平台后再试");
  }
});

console.log("");
if (fail > 0) {
  console.log("P24 platform-tools SMOKE FAILED (" + fail + " failed, " + pass + " passed)");
  process.exit(1);
}
console.log("P24 platform-tools SMOKE OK (" + pass + " checks)");
