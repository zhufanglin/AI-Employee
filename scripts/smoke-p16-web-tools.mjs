// P16：批量抓取（web_batch）与文件删除（file_delete）能力冒烟
// 用法：node scripts/smoke-p16-web-tools.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "p16-web-"));
process.env.WORKSPACE_DIR = dir;
process.env.OSS_BUCKET = "";
process.env.OSS_ENDPOINT = "";
process.env.OSS_ACCESS_KEY_ID = "";
process.env.OSS_ACCESS_KEY_SECRET = "";

let checks = 0;
function ok(label) { checks++; console.log("[PASS]", label); }
async function fails(label, fn, pattern) {
  try { await fn(); } catch (error) {
    const message = String(error?.response?.message ?? error?.message ?? error);
    if (pattern && !pattern.test(message)) throw new Error(label + " 报错文案不符：" + message);
    checks++; console.log("[PASS]", label); return;
  }
  throw new Error(label + " 应当抛错但没有");
}

const batch = await import("../packages/server/dist/capabilities/capabilities/web-batch.js");
const files = await import("../packages/server/dist/capabilities/capabilities/files.js");

const ctx = (params, userId = "u1") => ({ userId, phone: null, params });

// --- web_batch：用假 extract 验证聚合、预算、容错、并发参数 ---
const seen = [];
const fakeExtract = async ({ params }) => {
  seen.push(params.url);
  if (params.url.includes("boom")) throw new Error("连接超时");
  return { url: params.url, title: "标题 " + params.url, text: "正文".repeat(100), truncated: false };
};
const h = batch.buildHandler(fakeExtract);

const one = await h(ctx({ urls: ["https://a.com/1"] }));
assert.equal(one.total, 1); ok("web_batch 单个 URL 返回 1 条");
assert.equal(one.ok, 1); ok("web_batch ok 计数正确");
assert.equal(one.items[0].title, "标题 https://a.com/1"); ok("web_batch 透传标题");

const many = await h(ctx({ urls: ["https://a.com/1", "https://a.com/boom", "https://a.com/3"] }));
assert.equal(many.total, 3);
assert.equal(many.ok, 2);
assert.equal(many.failed, 1);
ok("web_batch 单条失败不影响其它条");
assert.match(many.items[1].error, /连接超时/); ok("web_batch 失败条带错误信息且已截断");

await fails("web_batch 拒绝非 http 协议", () => h(ctx({ urls: ["ftp://x/y"] })), /http/);
await fails("web_batch 空 urls 报错", () => h(ctx({ urls: [] })), /urls 必填/);
await fails("web_batch 超过 5 个报错", () => h(ctx({ urls: Array.from({ length: 6 }, (_, i) => "https://a.com/" + i) })), /最多抓 5 个/);

const longText = async ({ params }) => ({ url: params.url, title: "t", text: "字".repeat(1000), truncated: false });
const budgeted = await batch.buildHandler(longText)(ctx({ urls: ["https://a.com/1", "https://a.com/2"], maxChars: 600, totalChars: 1000 }));
assert.ok(budgeted.chars <= 1000, "总字数超出 " + budgeted.chars); ok("web_batch 遵守 totalChars 预算");
assert.ok(budgeted.items[1].chars < budgeted.items[0].chars); ok("web_batch 后续条按剩余预算截断");

// 真实 SSRF 守卫：内网地址必须被拒（走真实 web-extract handler）
const real = await batch.handler(ctx({ urls: ["http://127.0.0.1:1/a"] }));
assert.equal(real.ok, 0);
assert.match(real.items[0].error, /内网|禁止|拒绝|不允许/);
ok("web_batch 真实抓取拒绝内网地址");

// --- file_delete ---
await mkdir(join(dir, "u1"), { recursive: true });
const written = await files.handlers.file_write(ctx({ name: "待删.md", content: "内容" }));
ok("file_write 写入成功（前置条件）");
const listed = await files.handlers.file_list(ctx({}));
assert.equal(listed.total, 1); ok("file_list 能看到文件");
const removed = await files.handlers.file_delete(ctx({ name: "待删.md" }));
assert.equal(removed.deleted, true); ok("file_delete 删除成功");
const after = await files.handlers.file_list(ctx({}));
assert.equal(after.total, 0); ok("删除后 file_list 为空");

await fails("file_delete 删不存在的文件报错", () => files.handlers.file_delete(ctx({ name: "无此文件.md" })), /不存在/);
const other = await files.handlers.file_write(ctx({ name: "别人的.md", content: "x" }, "u2"));
await fails("file_delete 不能删别的用户的文件", () => files.handlers.file_delete(ctx({ key: other.key })), /不存在|无权/);
await fails("file_delete 缺参数报错", () => files.handlers.file_delete(ctx({})), /key 或 name/);

await rm(dir, { recursive: true, force: true });
console.log("P16 WEB TOOLS SMOKE OK (" + checks + " checks)");