import { createHmac } from "node:crypto";
import { env } from "../common/env";

/**
 * 渠道长结果页：把超过渠道单条发送上限的产出，存成全网页链接再回推。
 *
 * 为什么不用 OSS：OSS 上的 .md/.html 在微信内置浏览器里可能被当成下载，
 * 而且私有桶改签名后链接会过期；用服务端渲染一页 HTML 最稳、样式可控、也能随时改。
 *
 * env：
 * - PUBLIC_BASE_URL：服务端对外地址，例如 https://api.fcmediaagent.com（为空则不生成长结果链接，退回截断）
 * - CHANNEL_RESULT_SECRET：链接签名密钥（为空则回落 JWT_SECRET）
 */
const TOKEN_LENGTH = 32;

export function resultSecret(): string {
  const explicit = env("CHANNEL_RESULT_SECRET", "").trim();
  if (explicit) return explicit;
  const jwt = env("JWT_SECRET", "").trim();
  if (jwt) return jwt;
  return "fcmediaagent-channel-result";
}

/** 任务 id → 链接校验串（无密钥时也仍然不可猜，因为任务 id 本身是 cuid） */
export function resultToken(taskId: string): string {
  return createHmac("sha256", resultSecret()).update(String(taskId)).digest("hex").slice(0, TOKEN_LENGTH);
}

export function publicBaseUrl(): string {
  return env("PUBLIC_BASE_URL", "").trim().replace(/\/+$/, "");
}

/** 服务端根地址：优先 PUBLIC_BASE_URL，其次 OPENAPI/PORT 拼 127.0.0.1（本地可用） */
export function resultUrl(taskId: string, baseUrl: string = publicBaseUrl()): string | null {
  if (!baseUrl) return null;
  return baseUrl + "/api/channels/result/" + encodeURIComponent(taskId) + "?t=" + resultToken(taskId);
}

export function escapeHtml(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 行内格式：**粗体**、`code`、[文字](链接) */
function inline(md: string): string {
  let out = escapeHtml(md);
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, href) => {
    return '<a href="' + href + '" target="_blank" rel="noreferrer">' + label + "</a>";
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  return out;
}

/**
 * 极简 Markdown → HTML：标题、无序/有序列表、引用、分隔线、代码块、段落。
 * 不引第三方依赖（仓库约束：服务端尽量不新增运行时包）。
 */
export function renderMarkdown(md: string): string {
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let inCode = false;
  let listType: "ul" | "ol" | null = null;
  const closeList = () => {
    if (listType) {
      html.push("</" + listType + ">");
      listType = null;
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^```/.test(line.trim())) {
      if (inCode) {
        html.push("</code></pre>");
        inCode = false;
      } else {
        closeList();
        html.push("<pre><code>");
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      html.push(escapeHtml(raw));
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">");
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      closeList();
      html.push("<hr />");
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      html.push("<blockquote>" + inline(quote[1]) + "</blockquote>");
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      if (listType !== "ul") {
        closeList();
        html.push("<ul>");
        listType = "ul";
      }
      html.push("<li>" + inline(bullet[1]) + "</li>");
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      if (listType !== "ol") {
        closeList();
        html.push("<ol>");
        listType = "ol";
      }
      html.push("<li>" + inline(ordered[1]) + "</li>");
      continue;
    }
    closeList();
    html.push("<p>" + inline(line) + "</p>");
  }
  closeList();
  if (inCode) html.push("</code></pre>");
  return html.join("\n");
}

export interface ResultPageOptions {
  title?: string;
  taskId?: string;
  status?: string;
  createdAt?: Date | string | null;
  content: string;
}

/** 完整结果页 HTML（微信内置浏览器可读，白底窄栏，手机上不横向滚动） */
export function renderResultPage(options: ResultPageOptions): string {
  const title = options.title ? escapeHtml(options.title) : "AI 员工运行结果";
  const created = options.createdAt ? new Date(options.createdAt) : null;
  const metaParts: string[] = [];
  if (created && !Number.isNaN(created.getTime())) {
    const text = created.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
    metaParts.push("生成时间 " + escapeHtml(text));
  }
  if (options.status) metaParts.push("状态 " + escapeHtml(options.status));
  if (options.taskId) metaParts.push("任务 " + escapeHtml(options.taskId));
  const meta = metaParts.join(" · ");
  return [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>" + title + "</title>",
    "<style>",
    "body{margin:0;background:#f6f7f9;color:#1f2329;font:16px/1.75 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;}",
    ".wrap{max-width:760px;margin:0 auto;padding:20px 16px 64px;background:#fff;min-height:100vh;box-sizing:border-box;}",
    "h1{font-size:22px;line-height:1.4;margin:8px 0 12px;}h2{font-size:19px;margin:26px 0 10px;padding-bottom:6px;border-bottom:1px solid #eceef1;}",
    "h3{font-size:17px;margin:20px 0 8px;}h4,h5,h6{font-size:16px;margin:16px 0 6px;}",
    "p{margin:10px 0;}ul,ol{padding-left:22px;margin:10px 0;}li{margin:6px 0;}",
    "blockquote{margin:12px 0;padding:8px 14px;border-left:3px solid #d7dbe0;background:#fafbfc;color:#4a5159;}",
    "code{background:#f2f3f5;padding:1px 5px;border-radius:4px;font-size:14px;}pre{background:#f2f3f5;padding:12px;border-radius:8px;overflow-x:auto;}",
    "pre code{background:none;padding:0;}",
    "a{color:#2f6fed;word-break:break-all;}",
    ".meta{color:#8a9099;font-size:13px;margin-bottom:18px;word-break:break-all;}",
    "hr{border:0;border-top:1px solid #eceef1;margin:22px 0;}",
    "</style></head><body><div class=\"wrap\">",
    "<div class=\"meta\">" + meta + "</div>",
    renderMarkdown(options.content),
    "</div></body></html>",
  ].join("\n");
}
