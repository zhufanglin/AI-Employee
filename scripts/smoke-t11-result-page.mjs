#!/usr/bin/env node
/**
 * T-11 长结果页单测：Markdown 渲染 + 链接签名 + 结果页控制器
 *
 * 覆盖：
 *   1. resultToken 稳定 / 32 位 hex / 不同任务不同签名
 *   2. PUBLIC_BASE_URL 为空时 resultUrl 返回 null（不产生半截链接）
 *   3. renderMarkdown：标题、粗体、列表、链接、代码块、HTML 转义
 *   4. renderResultPage：包含标题/正文/移动端 viewport
 *   5. ChannelResultController：签名错 403、任务不存在 404、无产出 404、正常 200
 * 前置：packages/server 已 tsc 编译（verify.ps1 会先编译）。
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

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

function load(rel) {
  const full = path.join(repoRoot, "packages/server/dist", rel);
  try {
    return require(full);
  } catch (error) {
    console.error("[FAIL] 无法加载 " + full + "：" + error.message);
    console.error("请先编译：node node_modules/typescript/bin/tsc -p packages/server/tsconfig.json");
    process.exit(1);
  }
}

const page = load("channels/result-page.js");
const { ChannelResultController } = load("channels/result-page.controller.js");

// 1. 签名
const t1 = page.resultToken("cmw123");
const t1b = page.resultToken("cmw123");
const t2 = page.resultToken("cmw124");
check("resultToken 稳定", t1 === t1b, t1 + " vs " + t1b);
check("resultToken 是 32 位 hex", /^[0-9a-f]{32}$/.test(t1), t1);
check("不同任务签名不同", t1 !== t2);

// 2. 链接
const savedBase = process.env.PUBLIC_BASE_URL;
delete process.env.PUBLIC_BASE_URL;
check("未配置 PUBLIC_BASE_URL 时 resultUrl 为 null", page.resultUrl("cmw123") === null);
process.env.PUBLIC_BASE_URL = "https://api.fcmediaagent.com/";
const url = page.resultUrl("cmw123");
check(
  "配置后链接正确（去掉尾部斜杠）",
  url === "https://api.fcmediaagent.com/api/channels/result/cmw123?t=" + t1,
  String(url),
);
if (savedBase === undefined) delete process.env.PUBLIC_BASE_URL;
else process.env.PUBLIC_BASE_URL = savedBase;

// 3. Markdown
const md = [
  "# 一级标题",
  "## 二级标题",
  "",
  "普通段落 **加粗** 和 `行内代码`。",
  "",
  "- 列表一",
  "- 列表二",
  "",
  "1. 第一步",
  "2. 第二步",
  "",
  "> 引用一句话",
  "",
  "```js",
  "const a = 1 < 2;",
  "```",
  "",
  "[官网](https://example.com/a?b=1)",
  "",
  "<script>alert(1)</script>",
].join("\n");
const html = page.renderMarkdown(md);
check("Markdown：一级标题", html.includes("<h1>一级标题</h1>"), html.slice(0, 120));
check("Markdown：二级标题", html.includes("<h2>二级标题</h2>"));
check("Markdown：加粗", html.includes("<strong>加粗</strong>"));
check("Markdown：行内代码", html.includes("<code>行内代码</code>"));
check("Markdown：无序列表", html.includes("<ul>") && html.includes("<li>列表一</li>"));
check("Markdown：有序列表", html.includes("<ol>") && html.includes("<li>第一步</li>"));
check("Markdown：引用", html.includes("<blockquote>引用一句话</blockquote>"));
check("Markdown：代码块转义", html.includes("const a = 1 &lt; 2;"));
check("Markdown：外链", html.includes('href="https://example.com/a?b=1"'));
check("Markdown：禁止注入脚本", !html.includes("<script>") && html.includes("&lt;script&gt;"));

// 4. 页面
const rendered = page.renderResultPage({
  title: "招生方案",
  taskId: "cmw123",
  status: "awaiting_approval",
  createdAt: new Date("2026-11-07T10:00:00Z"),
  content: "# 正文标题\n内容一行",
});
check("结果页含标题", rendered.includes("<title>招生方案</title>"));
check("结果页含正文", rendered.includes("<h1>正文标题</h1>"));
check("结果页移动端适配", rendered.includes('name="viewport"') && rendered.includes("max-width:760px"));
check("结果页展示任务 id 与状态", rendered.includes("cmw123") && rendered.includes("awaiting_approval"));

// 5. 控制器
function makeRes() {
  return {
    statusCode: 200,
    body: "",
    type() { return this; },
    status(code) { this.statusCode = code; return this; },
    send(payload) { this.body = String(payload ?? ""); return this; },
  };
}

const tasks = {
  "cmw-ok": { id: "cmw-ok", title: "测试任务", status: "awaiting_approval", outputText: "# 你好\n这是正文", createdAt: new Date() },
  "cmw-artifact": { id: "cmw-artifact", title: "artifact 任务", status: "succeeded", outputText: "", createdAt: new Date() },
  "cmw-empty": { id: "cmw-empty", title: "空任务", status: "running", outputText: "", createdAt: new Date() },
};
const prisma = {
  employeeTask: {
    async findUnique({ where }) { return tasks[where.id] ?? null; },
  },
  employeeTaskArtifact: {
    async findFirst({ where }) {
      return where.taskId === "cmw-artifact" ? { text: "来自 artifact 的正文" } : null;
    },
  },
};
const controller = new ChannelResultController(prisma);

await (async () => {
  const badRes = makeRes();
  await controller.page("cmw-ok", "deadbeef", badRes);
  check("控制器：签名错误 403", badRes.statusCode === 403, "status=" + badRes.statusCode);
  check("控制器：403 页面友好", badRes.body.includes("链接无效"));

  const missingRes = makeRes();
  await controller.page("cmw-none", page.resultToken("cmw-none"), missingRes);
  check("控制器：任务不存在 404", missingRes.statusCode === 404, "status=" + missingRes.statusCode);

  const emptyRes = makeRes();
  await controller.page("cmw-empty", page.resultToken("cmw-empty"), emptyRes);
  check("控制器：无产出 404", emptyRes.statusCode === 404, "status=" + emptyRes.statusCode);

  const okRes = makeRes();
  await controller.page("cmw-ok", page.resultToken("cmw-ok"), okRes);
  check("控制器：正常 200", okRes.statusCode === 200, "status=" + okRes.statusCode);
  check("控制器：渲染出正文", okRes.body.includes("<h1>你好</h1>") && okRes.body.includes("这是正文"));

  const artifactRes = makeRes();
  await controller.page("cmw-artifact", page.resultToken("cmw-artifact"), artifactRes);
  check("控制器：artifact 回落 200", artifactRes.statusCode === 200 && artifactRes.body.includes("来自 artifact 的正文"));
})();

console.log("");
if (failures > 0) {
  console.error("T11 RESULT PAGE SMOKE FAILED (" + failures + "/" + checks + ")");
  process.exit(1);
}
console.log("T11 RESULT PAGE SMOKE OK (" + checks + " checks)");
