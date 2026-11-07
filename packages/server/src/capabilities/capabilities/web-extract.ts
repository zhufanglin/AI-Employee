import { BadRequestException } from "@nestjs/common";
import type { CapabilityDescriptor, CapabilityHandler } from "../capability.types";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export const descriptor: CapabilityDescriptor = {
  name: "web_extract",
  title: "网页正文提取",
  category: "web",
  description: "抓取一个 URL 并提取标题与正文纯文本（去掉脚本/样式/导航），用于后续总结或改写",
  params: { url: "必填，http(s) 网址", maxChars: "可选，正文最大字符数，默认 8000" },
};

const ENTITY: Record<string, string> = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&mdash;": "-", "&hellip;": "..." };

function stripHtml(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decode(titleMatch[1]).trim() : "";
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|article|li|h[1-6]|br|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  body = decode(body)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
  return { title, text: body };
}

function decode(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITY[entity.toLowerCase()] ?? entity);
}

// IPv4 与 IPv6 必须分表：Node 的 BlockList 在检查 ipv4 时会把地址映射成 ::ffff:a.b.c.d，
// 若同一个表里存在 ::ffff:0:0/96 这条（IPv4-mapped 段本身），就会把**所有** IPv4 判为命中。
const deniedV4 = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as Array<[string, number]>) deniedV4.addSubnet(address, prefix, "ipv4");

const deniedV6 = new BlockList();
for (const [address, prefix] of [["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2001:db8::", 32], ["2001::", 32], ["2002::", 16]] as Array<[string, number]>) deniedV6.addSubnet(address, prefix, "ipv6");

/** IPv4-mapped IPv6 既可能为点分格式，也可能被 URL 规范化成两段十六进制。 */
function mappedIpv4(address: string): string | null {
  let canonical: string;
  try { canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1); }
  catch { return null; }
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(canonical);
  if (!match) return null;
  const high = parseInt(match[1], 16), low = parseInt(match[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

export function isDenied(address: string, family: number): boolean {
  if (family === 6) {
    const mapped = mappedIpv4(address);
    if (mapped) return deniedV4.check(mapped, "ipv4");
    return deniedV6.check(address, "ipv6");
  }
  return deniedV4.check(address, "ipv4");
}

/** 只保留公网地址；优先用 IPv4（避免无 IPv6 出口时连不上），全部被拦才拒绝 */
export function pickPublicAddress(addresses: Array<{ address: string; family: number }>) {
  const allowed = addresses.filter((entry) => !isDenied(entry.address, entry.family));
  if (!allowed.length) throw new BadRequestException("禁止访问内网或保留地址");
  return allowed.sort((a, b) => a.family - b.family)[0];
}

async function fetchPublicPage(input: string, redirects = 0): Promise<{ html: string; type: string | null }> {
  let url: URL;
  try { url = new URL(input); } catch { throw new BadRequestException("网址无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new BadRequestException("仅支持不含凭据的 http(s) 网址");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(host);
  const addresses = literalFamily ? [{ address: host, family: literalFamily }] : await lookup(host, { all: true, verbatim: true });
  const chosen = pickPublicAddress(addresses);
  const response = await new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, { family: chosen.family, signal: AbortSignal.timeout(20000), headers: { "user-agent": "Mozilla/5.0 (compatible; fcmediaagent-capability/1.0)" }, lookup: (_host: string, _options: any, callback: any) => callback(null, chosen.address, chosen.family) }, res => {
      const chunks: Buffer[] = []; let bytes = 0;
      res.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) req.destroy(new Error("网页超过 2MB 限制")); else chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject); req.end();
  });
  if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
    if (redirects >= 3) throw new BadRequestException("网页重定向次数过多");
    return fetchPublicPage(new URL(response.headers.location, url).href, redirects + 1);
  }
  if (response.status < 200 || response.status >= 300) throw new Error(`抓取失败: HTTP ${response.status}`);
  return { html: response.body, type: response.headers['content-type'] || null };
}

export const handler: CapabilityHandler = async ({ params }) => {
  const url = String(params.url || "").trim();
  if (!/^https?:\/\//i.test(url)) throw new BadRequestException("url 必须是 http(s) 地址");
  const maxChars = Math.min(Math.max(Number(params.maxChars) || 8000, 500), 40000);
  const response = await fetchPublicPage(url);
  const html = response.html;
  const { title, text } = stripHtml(html);
  return {
    url,
    title,
    contentType: response.type || "",
    length: text.length,
    truncated: text.length > maxChars,
    text: text.slice(0, maxChars),
  };
};
