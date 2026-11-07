#!/usr/bin/env node
/** P16 文档生成能力单测：doc_write（xlsx / docx）生成、回读、限额、命名安全与用户隔离。 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "p16-doc-write-"));
process.env.WORKSPACE_DIR = workspace;
process.env.WORKSPACE_MAX_BYTES = "2000000";
process.env.WORKSPACE_UPLOAD_MAX_BYTES = "50000000";
process.env.PUBLIC_BASE_URL = "";
process.env.OSS_ACCESS_KEY_ID = "";
process.env.OSS_ACCESS_KEY_SECRET = "";
process.env.OSS_BUCKET = "";
process.env.OSS_REGION = "";
process.env.OSS_ENDPOINT = "";

const docWrite = require("../packages/server/dist/capabilities/capabilities/docs-write.js");
const files = require("../packages/server/dist/capabilities/capabilities/files.js");
const XLSX = require("xlsx");
const mammoth = require("mammoth");

const USER = "user-a";
const OTHER = "user-b";
let pass = 0;
let fail = 0;

function ok(name) { pass += 1; console.log("[PASS] " + name); }
function bad(name, detail) { fail += 1; console.log("[FAIL] " + name + " :: " + detail); }
async function check(name, fn) {
  try { const value = await fn(); ok(name); return value; }
  catch (error) { bad(name, error && error.message ? error.message : String(error)); return undefined; }
}
async function rejects(name, fn, needle) {
  try {
    await fn();
    bad(name, "未抛错");
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (needle && !message.includes(needle)) bad(name, "错误文案不含「" + needle + "」，实际：" + message);
    else ok(name);
  }
}
function expect(condition, message) { if (!condition) throw new Error(message); }
function eq(actual, expected, label) {
  const left = JSON.stringify(actual), right = JSON.stringify(expected);
  if (left !== right) throw new Error((label ? label + "：" : "") + "期望 " + right + " 实际 " + left);
}
function call(params, userId = USER) { return docWrite.handlers.doc_write({ userId, params }); }
async function readFile(result) {
  const file = await files.resolveWorkspaceFile(USER, { key: result.key });
  expect(!!file, "文件无法按 key 定位：" + result.key);
  return files.readWorkspaceBytes(USER, file);
}

// ---------- xlsx ----------
const xlsxResult = await check("xlsx 生成成功并返回 key/name/format", async () => {
  const result = await call({
    format: "xlsx",
    name: "选品报表",
    sheets: [{ name: "汇总", rows: [["商品", "销量"], ["洗衣液", 120], ["纸巾", 80]] }],
  });
  eq(result.format, "xlsx", "format");
  eq(result.name, "选品报表.xlsx", "name");
  eq(result.sheets, ["汇总"], "sheets");
  expect(result.key.startsWith("workspace/" + USER + "/"), "key 前缀不对：" + result.key);
  expect(result.bytes > 0, "bytes 应为正数");
  expect(result.url === null || /^https?:\/\//.test(String(result.url)), "url 形态不对：" + result.url);
  return result;
});

if (xlsxResult) {
  await check("xlsx 文件真实落盘且 bytes 与实际一致", async () => {
    const buffer = await readFile(xlsxResult);
    eq(buffer.byteLength, xlsxResult.bytes, "bytes");
    expect(buffer.byteLength > 0, "文件为空");
  });

  await check("xlsx 用 XLSX.read 读回表名与首行值", async () => {
    const book = XLSX.read(await readFile(xlsxResult), { type: "buffer" });
    eq(book.SheetNames, ["汇总"], "表名");
    const rows = XLSX.utils.sheet_to_json(book.Sheets["汇总"], { header: 1, raw: true });
    eq(rows[0], ["商品", "销量"], "首行");
    eq(rows[1], ["洗衣液", 120], "第二行");
  });

  await check("xlsx 中文不乱码（单元格内容逐字比对）", async () => {
    const book = XLSX.read(await readFile(xlsxResult), { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json(book.Sheets["汇总"], { header: 1, raw: true });
    eq(rows[2][0], "纸巾", "第三行首列");
    expect(!String(rows[2][0]).includes("�"), "出现替换字符，编码异常");
  });
}

await check("xlsx 多工作表按顺序生成", async () => {
  const result = await call({
    format: "xlsx",
    name: "多表",
    sheets: [
      { name: "一表", rows: [["甲"]] },
      { name: "二表", rows: [["乙"]] },
    ],
  });
  eq(result.sheets, ["一表", "二表"], "返回表名");
  const book = XLSX.read(await readFile(result), { type: "buffer" });
  eq(book.SheetNames, ["一表", "二表"], "读回表名");
  eq(XLSX.utils.sheet_to_json(book.Sheets["二表"], { header: 1 })[0][0], "乙", "二表内容");
});

await check("xlsx rows 快捷方式等价单表（title 作表名）", async () => {
  const result = await call({ format: "xlsx", name: "快捷表", title: "数据", rows: [["名称", "数量"], ["A", 1], ["B", true], ["C", null]] });
  eq(result.sheets, ["数据"], "表名");
  const book = XLSX.read(await readFile(result), { type: "buffer" });
  eq(book.SheetNames, ["数据"], "读回表名");
  const rows = XLSX.utils.sheet_to_json(book.Sheets["数据"], { header: 1, raw: true });
  eq(rows[0], ["名称", "数量"], "首行");
  eq(rows[2][1], true, "布尔单元格");
});

await check("xlsx 超长表名截断到 31 字符", async () => {
  const longName = "长".repeat(40);
  const result = await call({ format: "xlsx", name: "长表名", sheets: [{ name: longName, rows: [["x"]] }] });
  const book = XLSX.read(await readFile(result), { type: "buffer" });
  eq(book.SheetNames[0].length, 31, "表名长度");
  eq(result.sheets[0].length, 31, "返回表名长度");
});

await check("xlsx 表名非法字符被清洗为下划线", async () => {
  const result = await call({ format: "xlsx", name: "脏表名", sheets: [{ name: "报表[1]:*?/\\", rows: [["x"]] }] });
  expect(!/[\[\]:*?\/\\]/.test(result.sheets[0]), "仍含非法字符：" + result.sheets[0]);
  const book = XLSX.read(await readFile(result), { type: "buffer" });
  expect(!/[\[\]:*?\/\\]/.test(book.SheetNames[0]), "读回仍含非法字符：" + book.SheetNames[0]);
});

await check("xlsx 重名工作表自动加后缀", async () => {
  const result = await call({
    format: "xlsx",
    name: "重名表",
    sheets: [
      { name: "重复", rows: [["a"]] },
      { name: "重复", rows: [["b"]] },
      { name: "重复", rows: [["c"]] },
    ],
  });
  eq(result.sheets, ["重复", "重复 (2)", "重复 (3)"], "去重表名");
});

await check("xlsx 单表超过 5000 行被拒", async () => {
  try {
    await call({ format: "xlsx", name: "超行", rows: Array.from({ length: 5001 }, (_, i) => [i]) });
  } catch (error) {
    expect(String(error.message).includes("5000 行"), "错误文案不含行数上限：" + error.message);
    return;
  }
  throw new Error("未抛错");
});

await check("xlsx 单行超过 100 列被拒", async () => {
  try {
    await call({ format: "xlsx", name: "超列", rows: [Array.from({ length: 101 }, (_, i) => i)] });
  } catch (error) {
    expect(String(error.message).includes("100 列"), "错误文案不含列数上限：" + error.message);
    return;
  }
  throw new Error("未抛错");
});

await check("xlsx 总单元格超过 50000 被拒", async () => {
  const rows = () => Array.from({ length: 3000 }, () => Array.from({ length: 11 }, () => "x"));
  try {
    await call({ format: "xlsx", name: "超总量", sheets: [{ name: "A", rows: rows() }, { name: "B", rows: rows() }] });
  } catch (error) {
    expect(String(error.message).includes("50000"), "错误文案不含总量上限：" + error.message);
    return;
  }
  throw new Error("未抛错");
});

await check("xlsx 不支持的对象单元格被拒", async () => {
  try {
    await call({ format: "xlsx", name: "坏单元格", rows: [[{ a: 1 }]] });
  } catch (error) {
    expect(String(error.message).includes("类型不支持"), "错误文案不符：" + error.message);
    return;
  }
  throw new Error("未抛错");
});

// ---------- 参数校验 ----------
await rejects("缺少 format 报错", () => call({ name: "无格式", rows: [["x"]] }), "format 必填");
await rejects("format=pdf 报错（本批次不做 PDF）", () => call({ format: "pdf", name: "报告", content: "x" }), "xlsx 或 docx");
await rejects("缺少 name 报错", () => call({ format: "xlsx", rows: [["x"]] }), "name 必填");
await rejects("content 与 sheets/rows 都不给报错", () => call({ format: "xlsx", name: "空" }), "至少给一个");
await rejects("xlsx 只给 content 报错（content 仅用于 docx）", () => call({ format: "xlsx", name: "只有正文", content: "abc" }), "必须提供 sheets 或 rows");
await rejects("sheets 超过 10 个报错", () => call({
  format: "xlsx",
  name: "太多表",
  sheets: Array.from({ length: 11 }, (_, i) => ({ name: "S" + i, rows: [["x"]] })),
}), "最多 10 个");
await rejects("content 超过 200000 字符报错", () => call({ format: "docx", name: "超长文", content: "字".repeat(200001) }), "200000");

// ---------- docx ----------
const docContent = [
  "# 季度总结",
  "## 一、概览",
  "本季度营收 **同比增长** 30%。",
  "",
  "- 第一条：洗衣液",
  "- 第二条：纸巾",
  "1. 步骤一",
  "2. 步骤二",
  "",
  "| 指标 | 数值 |",
  "| --- | --- |",
  "| 营收 | 100 |",
  "| 成本 | 60 |",
].join("\n");

const docResult = await check("docx 生成成功并返回 key/name/paragraphs", async () => {
  const result = await call({ format: "docx", name: "季度总结", title: "经营季报", content: docContent });
  eq(result.format, "docx", "format");
  eq(result.name, "季度总结.docx", "name");
  expect(result.key.startsWith("workspace/" + USER + "/"), "key 前缀不对：" + result.key);
  expect(result.bytes > 0, "bytes 应为正数");
  expect(result.paragraphs > 0, "paragraphs 应为正数");
  expect(result.url === null || /^https?:\/\//.test(String(result.url)), "url 形态不对：" + result.url);
  return result;
});

if (docResult) {
  await check("docx 用 mammoth 读回标题与正文", async () => {
    const buffer = await readFile(docResult);
    const raw = await mammoth.extractRawText({ buffer });
    const text = raw.value;
    expect(text.includes("经营季报"), "缺文档标题");
    expect(text.includes("季度总结"), "缺一级标题");
    expect(text.includes("一、概览"), "缺二级标题");
    expect(text.includes("本季度营收 同比增长 30%。"), "粗体破坏了正文连续性：" + JSON.stringify(text.slice(0, 120)));
  });

  await check("docx 读回项目符号与编号条目文本", async () => {
    const buffer = await readFile(docResult);
    const text = (await mammoth.extractRawText({ buffer })).value;
    expect(text.includes("第一条：洗衣液"), "缺项目符号一");
    expect(text.includes("第二条：纸巾"), "缺项目符号二");
    expect(text.includes("步骤一") && text.includes("步骤二"), "缺编号条目");
  });

  await check("docx 读回表格单元格文本", async () => {
    const buffer = await readFile(docResult);
    const text = (await mammoth.extractRawText({ buffer })).value;
    expect(text.includes("指标") && text.includes("数值"), "缺表头");
    expect(text.includes("营收") && text.includes("100"), "缺表格数据行");
    expect(text.includes("成本") && text.includes("60"), "缺表格数据行二");
  });

  await check("docx 标题层级与表格结构被正确识别", async () => {
    const buffer = await readFile(docResult);
    const html = (await mammoth.convertToHtml({ buffer })).value;
    expect(/<h1[^>]*>/.test(html), "缺少 h1");
    expect(/<h2[^>]*>/.test(html), "缺少 h2");
    expect(/<table[^>]*>/.test(html), "缺少 table");
    expect(/<strong>同比增长<\/strong>/.test(html), "粗体未渲染为 strong");
    expect(/<ul>/.test(html), "缺少项目符号列表");
    expect(/<ol>/.test(html), "缺少编号列表");
  });
}

await check("docx 只给 title 也能生成（空正文）", async () => {
  const result = await call({ format: "docx", name: "只有标题", title: "单独标题" });
  eq(result.paragraphs, 1, "段落数");
  const text = (await mammoth.extractRawText({ buffer: await readFile(result) })).value;
  expect(text.includes("单独标题"), "缺标题文本");
});

await rejects("docx content 为空且无 sheets 报错", () => call({ format: "docx", name: "空文档" }), "至少给一个");
await rejects("docx 只给 sheets 不给 content 报错", () => call({ format: "docx", name: "错配", sheets: [{ name: "S", rows: [["x"]] }] }), "没有可写入的内容");

// ---------- 命名安全 / 隔离 ----------
await check("name 带 ../ 被安全化且不越界", async () => {
  const result = await call({ format: "xlsx", name: "../报表", rows: [["x"]] });
  expect(!result.name.includes(".."), "文件名仍含 ..：" + result.name);
  expect(!result.name.includes("/") && !result.name.includes("\\"), "文件名仍含路径分隔符：" + result.name);
  expect(result.name.endsWith(".xlsx"), "扩展名不对：" + result.name);
  eq(result.name, "报表.xlsx", "安全化结果");
  const hit = await files.resolveWorkspaceFile(USER, { name: result.name });
  expect(!!hit, "安全化后的文件按名找不到");
});

await check("name 仅由 .. 组成被拒", async () => {
  try {
    await call({ format: "xlsx", name: "..", rows: [["x"]] });
  } catch (error) {
    expect(String(error.message).includes("清洗后为空"), "错误文案不符：" + error.message);
    return;
  }
  throw new Error("未抛错");
});

await check("name 带反斜杠被安全化", async () => {
  const result = await call({ format: "xlsx", name: "a\\b", rows: [["x"]] });
  expect(!result.name.includes("\\"), "仍含反斜杠：" + result.name);
  eq(result.name, "a_b.xlsx", "安全化结果");
});

await check("name 误带扩展名不会重复拼接", async () => {
  const result = await call({ format: "docx", name: "重复扩展名.docx", content: "正文" });
  eq(result.name, "重复扩展名.docx", "最终文件名");
});

await rejects("B 用户按 key 访问 A 用户文件被拒", () => files.resolveWorkspaceFile(OTHER, { key: xlsxResult.key }), "无权访问");
await check("B 用户按名访问 A 用户文件拿不到", async () => {
  const hit = await files.resolveWorkspaceFile(OTHER, { name: xlsxResult.name });
  eq(hit, null, "越权命中");
});

// ---------- 收尾 ----------
try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

console.log("— 通过 " + pass + " 项，失败 " + fail + " 项");
if (fail > 0) {
  console.log("P16 doc-write SMOKE FAILED (" + fail + " failed)");
  process.exit(1);
}
console.log("P16 doc-write SMOKE OK (" + pass + " checks)");
process.exit(0);
