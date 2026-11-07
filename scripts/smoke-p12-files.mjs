#!/usr/bin/env node
/** P12 工作区文件能力单测：file_list / 按名 file_read / doc_read（Excel）/ 上传白名单与越权隔离。 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "p12-ws-"));
process.env.WORKSPACE_DIR = workspace;
process.env.WORKSPACE_MAX_BYTES = "2000000";
process.env.WORKSPACE_UPLOAD_MAX_BYTES = "50000000";
process.env.PUBLIC_BASE_URL = "https://api.example.com";
process.env.OSS_ACCESS_KEY_ID = "";
process.env.OSS_ACCESS_KEY_SECRET = "";
process.env.OSS_BUCKET = "";
process.env.OSS_REGION = "";
process.env.OSS_ENDPOINT = "";

const files = require("../packages/server/dist/capabilities/capabilities/files.js");
const docs = require("../packages/server/dist/capabilities/capabilities/docs.js");
const XLSX = require("xlsx");

const USER = "user-a";
const OTHER = "user-b";
let pass = 0;
function ok(name) { pass += 1; console.log("[PASS] " + name); }
function bad(name, detail) { console.log("[FAIL] " + name + " :: " + detail); process.exitCode = 1; }
async function checkAsync(name, fn) {
  try { await fn(); ok(name); } catch (error) { bad(name, error && error.message ? error.message : error); }
}
async function rejects(name, fn, needle) {
  try { await fn(); bad(name, "未抛错"); }
  catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (needle && !message.includes(needle)) bad(name, "错误文案不含「" + needle + "」实际：" + message);
    else ok(name);
  }
}
function expectEq(name, actual, expected) {
  const left = JSON.stringify(actual), right = JSON.stringify(expected);
  if (left !== right) bad(name, "期望 " + right + " 实际 " + left); else ok(name);
}

let written = null;

await checkAsync("file_write 写出交付物并可下载", async () => {
  written = await files.handlers.file_write({ userId: USER, params: { name: "选品清单.md", content: "# 选品\n- 洗衣液\n- 纸巾" } });
  if (!written.key || !written.key.startsWith("workspace/" + USER + "/")) throw new Error("key 前缀不对：" + written.key);
  expectEq("file_write bytes", written.bytes, Buffer.byteLength("# 选品\n- 洗衣液\n- 纸巾", "utf8"));
  expectEq("file_write url", written.url && written.url.startsWith("https://api.example.com/uploads/workspace/"), true);
});

await checkAsync("file_list 列出自有文件并带展示名", async () => {
  const listed = await files.handlers.file_list({ userId: USER, params: {} });
  expectEq("file_list total", listed.total, 1);
  expectEq("file_list name", listed.items[0].name, "选品清单.md");
  expectEq("file_list key 一致", listed.items[0].key, written.key);
});

await checkAsync("file_list 对空工作区返回 0", async () => {
  const listed = await files.handlers.file_list({ userId: OTHER, params: {} });
  expectEq("空工作区 total", listed.total, 0);
});

await checkAsync("file_read 按 name 读取（不要求 key）", async () => {
  const read = await files.handlers.file_read({ userId: USER, params: { name: "选品清单.md" } });
  if (!read.text.includes("洗衣液")) throw new Error("内容不对：" + read.text);
  expectEq("file_read truncated", read.truncated, false);
});

await checkAsync("file_read 按 key 读取并按 maxChars 截断（下限 500）", async () => {
  const long = await files.handlers.file_write({ userId: USER, params: { name: "长文.md", content: "A".repeat(900) } });
  const read = await files.handlers.file_read({ userId: USER, params: { key: long.key, maxChars: 500 } });
  expectEq("file_read 截断", read.truncated, true);
  expectEq("file_read 截断长度", read.text.length, 500);
});

await rejects("file_read 不读别人的同名文件", () => files.handlers.file_read({ userId: OTHER, params: { name: "选品清单.md" } }), "文件不存在");
await rejects("file_read 越权 key 被拒", () => files.handlers.file_read({ userId: OTHER, params: { key: written.key } }), "无权访问");
await rejects("file_read 缺 key 与 name 报错", () => files.handlers.file_read({ userId: USER, params: {} }), "key 或 name");

// 上传一份真实 xlsx（模拟用户上传的表格资料）
const book = XLSX.utils.book_new();
const sheet = XLSX.utils.aoa_to_sheet([["客户", "手机号", "意向"], ["张三", "13800000000", "高"], ["李四", "13900000000", "中"]]);
XLSX.utils.book_append_sheet(book, sheet, "客户线索");
const xlsxBuffer = Buffer.from(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
let uploaded = null;

await checkAsync("上传 xlsx 走 saveWorkspaceFile", async () => {
  uploaded = await files.saveWorkspaceFile(USER, "客户线索.xlsx", xlsxBuffer);
  expectEq("上传 ext", uploaded.file.ext, ".xlsx");
  expectEq("上传 bytes", uploaded.file.bytes, xlsxBuffer.byteLength);
});

await rejects("file_read 拒绝表格，提示用 doc_read", () => files.handlers.file_read({ userId: USER, params: { name: "客户线索.xlsx" } }), "doc_read");

await checkAsync("doc_read 解析 Excel 工作表为 CSV 文本", async () => {
  const parsed = await docs.handlers.doc_read({ userId: USER, params: { name: "客户线索.xlsx" } });
  if (!parsed.text.includes("客户线索")) throw new Error("缺工作表名：" + parsed.text);
  if (!parsed.text.includes("张三")) throw new Error("缺单元格内容：" + parsed.text);
  expectEq("doc_read sheets", parsed.meta.sheets, 1);
  expectEq("doc_read truncated", parsed.truncated, false);
});

await checkAsync("doc_read 按 key 也能读并按 maxChars 截断", async () => {
  const big = XLSX.utils.book_new();
  const rows = [["序号", "备注"]];
  for (let i = 1; i <= 200; i += 1) rows.push([i, "第" + i + "行备注内容用于撑长度"]);
  XLSX.utils.book_append_sheet(big, XLSX.utils.aoa_to_sheet(rows), "明细");
  const saved = await files.saveWorkspaceFile(USER, "大表.xlsx", Buffer.from(XLSX.write(big, { type: "buffer", bookType: "xlsx" })));
  const parsed = await docs.handlers.doc_read({ userId: USER, params: { key: saved.file.key, maxChars: 500 } });
  expectEq("doc_read 截断标记", parsed.truncated, true);
  expectEq("doc_read 截断长度", parsed.text.length, 500);
});

await rejects("doc_read 不读别人的文件", () => docs.handlers.doc_read({ userId: OTHER, params: { key: uploaded.file.key } }), "无权访问");

await rejects("上传拒绝白名单外扩展名", () => files.saveWorkspaceFile(USER, "木马.exe", Buffer.from("MZ")), "不支持的文件类型");
await rejects("上传拒绝路径穿越名", () => files.saveWorkspaceFile(USER, "../evil.txt", Buffer.from("x")), "不能包含路径分隔符");
await rejects("上传拒绝空内容", () => files.saveWorkspaceFile(USER, "空.txt", Buffer.alloc(0)), "内容为空");

await checkAsync("file_list 按时间倒序且 limit 生效", async () => {
  await files.handlers.file_write({ userId: USER, params: { name: "第二次交付.md", content: "v2" } });
  const listed = await files.handlers.file_list({ userId: USER, params: { limit: 2 } });
  expectEq("file_list total 全部", listed.total, 5);
  expectEq("file_list 条数受 limit 限制", listed.items.length, 2);
  expectEq("最新文件在最前", listed.items[0].name, "第二次交付.md");
});

await checkAsync("删除文件后列表同步", async () => {
  await files.deleteWorkspaceFile(USER, { name: "第二次交付.md" });
  const listed = await files.handlers.file_list({ userId: USER, params: {} });
  expectEq("删除后 total", listed.total, 4);
});

if (process.exitCode) { console.log("P12 FILES SMOKE FAILED (" + pass + " checks passed)"); }
else { console.log("P12 FILES SMOKE OK (" + pass + " checks)"); }
