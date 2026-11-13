import { BadRequestException } from "@nestjs/common";
import type { CapabilityDescriptor, CapabilityHandler } from "../capability.types";
import { handler as extractHandler } from "./web-extract";

/**
 * 来源核对（可信引用）：
 * 员工写正文时经常「引用」一段数据，但链接可能是编的、页面里根本没这句话。
 * 这里由程序把链接真的打开、把正文抓下来，和员工声称的原句做归一化比对，
 * 返回 verified / quote-not-found / unreachable 三种结论，员工必须把未通过的标「未核实」。
 * 复用 web_extract 的抓取实现（含 SSRF 守卫、2MB 上限、重定向限制），不重复造轮子。
 */

export const descriptor: CapabilityDescriptor = {
  name: "source_check",
  title: "来源核对（链接与引用原句是否真实存在）",
  category: "web",
  description:
    "逐个打开引用链接，检查页面能否访问、页面里是否真的包含你准备引用的那句话或数字；返回 verified / quote-not-found / unreachable，未通过的一律不得作为已核实数据写进交付物",
  params: {
    claims: "推荐，数组：[{url, quote}]。quote 填你准备写进正文的原句或关键数据（例：{\"url\":\"https://…\",\"quote\":\"去家务化笔记发布量同比增长131%\"}）",
    urls: "可选，只有网址没有原句时传网址数组，逐个检查是否可访问（1-8 个）",
    text: "可选，直接传整段草稿正文，系统自动抽出里面所有网址逐个核对（最多 8 个）",
    quote: "可选，配合 urls/text 使用：要用同一句原句去核对多个链接时在这里传一次，省得每个网址都写 claims",
    maxChars: "可选，每个页面读取的最大字符数，默认 8000，上限 20000",
    strict: "可选，true 时只要有一条未通过就让本次调用失败并列出问题，默认 false（逐条返回，自己判断怎么写）",
  },
};

const MAX_URLS = 8;
const URL_RE = /https?:\/\/[^\s<>"'()\[\]{}，。；、）】」』]+/gi;
const TRAILING = /[.,;:!?)\]]+$/;

/** 从任意文本里抽出 http(s) 链接（去重、去尾部标点、上限 8 个） */
export function extractUrls(text: string): string[] {
  const raw = String(text ?? "");
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of raw.match(URL_RE) || []) {
    const url = match.replace(TRAILING, "");
    if (!/^https?:\/\/\S+$/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    found.push(url);
    if (found.length >= MAX_URLS) break;
  }
  return found;
}

/** 归一化：全角转半角、统一小写、去掉空白与标点（中文标点也要去掉，否则「131%」与「131 %」对不上） */
export function normForMatch(input: string): string {
  let s = String(input ?? "");
  try { s = s.normalize("NFKC"); } catch { /* 老环境没有 normalize 就跳过 */ }
  return s
    .toLowerCase()
    .replace(/[\s\u00a0\u3000]+/g, "")
    .replace(/[，。；：、！？·—–\-_,.;:!?%％"'“”‘’()（）\[\]【】{}<>《》〈〉「」『』|\\/]/g, "");
}

function longestCommonSubstring(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  let best = 0;
  let prev = new Uint16Array(long.length + 1);
  for (let i = 1; i <= short.length; i++) {
    const cur = new Uint16Array(long.length + 1);
    const ch = short.charCodeAt(i - 1);
    for (let j = 1; j <= long.length; j++) {
      if (ch === long.charCodeAt(j - 1)) {
        const v = prev[j - 1] + 1;
        cur[j] = v;
        if (v > best) best = v;
      }
    }
    prev = cur;
    if (best >= short.length) return best;
  }
  return best;
}

export type QuoteMatch = { found: boolean; mode: "exact" | "partial" | "missing" | "empty"; ratio: number };

/** 判断页面正文里是否真的出现了这段引用（允许标点/空格/全半角差异，允许少量改写） */
export function quoteMatches(pageText: string, quote: string): QuoteMatch {
  const q = normForMatch(quote);
  if (!q) return { found: false, mode: "empty", ratio: 0 };
  const page = normForMatch(pageText);
  if (!page) return { found: false, mode: "missing", ratio: 0 };
  if (page.includes(q)) return { found: true, mode: "exact", ratio: 1 };
  if (q.length < 6) return { found: false, mode: "missing", ratio: 0 };
  const hit = longestCommonSubstring(q.length > 400 ? q.slice(0, 400) : q, page.length > 20000 ? page.slice(0, 20000) : page);
  const ratio = hit / Math.min(q.length, 400);
  const threshold = q.length <= 12 ? 0.8 : 0.6;
  return { found: ratio >= threshold, mode: ratio >= threshold ? "partial" : "missing", ratio: Number(ratio.toFixed(3)) };
}

function snippetAround(pageText: string, quote: string): string {
  const text = String(pageText ?? "");
  const q = normForMatch(quote).slice(0, 24);
  if (!q) return text.slice(0, 160);
  const flat = text.replace(/\s+/g, " ");
  const probe = String(quote ?? "").trim().slice(0, 12);
  const at = probe ? flat.indexOf(probe) : -1;
  if (at < 0) return "";
  return flat.slice(Math.max(0, at - 60), Math.min(flat.length, at + 180));
}

export type SourceClaim = { url: string; quote?: string };

function normalizeClaims(params: any): SourceClaim[] {
  const claims: SourceClaim[] = [];
  const sharedQuote = typeof params?.quote === "string" && params.quote.trim() ? params.quote.trim() : undefined;
  const rawClaims = Array.isArray(params?.claims) ? params.claims : [];
  for (const item of rawClaims) {
    if (!item) continue;
    if (typeof item === "string") {
      const url = item.trim();
      if (url) claims.push({ url, quote: sharedQuote });
      continue;
    }
    const url = String(item.url ?? item.link ?? "").trim();
    if (!url) continue;
    const quote = item.quote ?? item.claim ?? item.text;
    claims.push({ url, quote: quote ? String(quote) : undefined });
  }
  const rawUrls = Array.isArray(params?.urls) ? params.urls : typeof params?.urls === "string" ? params.urls.split(/[\s,]+/) : [];
  for (const item of rawUrls) {
    const url = String(item ?? "").trim();
    if (url) claims.push({ url, quote: sharedQuote });
  }
  if (typeof params?.text === "string" && params.text.trim()) {
    for (const url of extractUrls(params.text)) claims.push({ url, quote: sharedQuote });
  }
  const seen = new Set<string>();
  const unique: SourceClaim[] = [];
  for (const claim of claims) {
    if (!/^https?:\/\//i.test(claim.url)) throw new BadRequestException("来源核对只接受 http(s) 网址：" + claim.url);
    const key = claim.url;
    const exists = unique.find((c) => c.url === key);
    if (exists) {
      if (!exists.quote && claim.quote) exists.quote = claim.quote;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(claim);
  }
  return unique;
}

export const handler: CapabilityHandler = async ({ params }: any) => {
  const claims = normalizeClaims(params ?? {});
  if (!claims.length) {
    throw new BadRequestException("请提供要核对的来源：claims:[{url,quote}]、urls:[...] 或直接传草稿正文 text");
  }
  if (claims.length > MAX_URLS) {
    throw new BadRequestException("一次最多核对 " + MAX_URLS + " 个链接，收到 " + claims.length + " 个，请分批");
  }
  const maxChars = Math.min(Math.max(Math.trunc(Number(params?.maxChars) || 8000), 500), 20000);
  const items: any[] = [];
  for (const claim of claims) {
    try {
      const page: any = await (extractHandler as any)({ userId: "source-check", phone: "", params: { url: claim.url, maxChars } });
      const pageText = String(page?.text ?? "");
      const title = String(page?.title ?? "");
      if (!claim.quote) {
        items.push({ url: claim.url, ok: true, verdict: "reachable", title, chars: pageText.length, quote: "", message: "链接可访问（未提供引用原句，只能证明页面存在）" });
        continue;
      }
      const match = quoteMatches(pageText, claim.quote);
      items.push({
        url: claim.url,
        ok: match.found,
        verdict: match.found ? "verified" : "quote-not-found",
        title,
        chars: pageText.length,
        quote: claim.quote,
        matchMode: match.mode,
        matchRatio: match.ratio,
        snippet: match.found ? snippetAround(pageText, claim.quote) : "",
        message: match.found
          ? match.mode === "exact"
            ? "页面里找到这段原句，可引用"
            : "页面里有高度相似的表述（允许少量改写），可引用但建议照抄原句"
          : "页面里没找到这段原句，不能作为已核实数据引用，请改写为「未核实」或换来源",
      });
    } catch (error: any) {
      const message = error?.response?.message ?? error?.message ?? String(error);
      items.push({ url: claim.url, ok: false, verdict: "unreachable", quote: claim.quote ?? "", message: "打不开该链接：" + message });
    }
  }
  const verified = items.filter((i) => i.verdict === "verified").length;
  const reachableOnly = items.filter((i) => i.verdict === "reachable").length;
  const quoteNotFound = items.filter((i) => i.verdict === "quote-not-found").length;
  const unreachable = items.filter((i) => i.verdict === "unreachable").length;
  const summary =
    "共核对 " + items.length + " 条：" +
    verified + " 条找到原句" +
    (reachableOnly ? "，" + reachableOnly + " 条仅确认可访问" : "") +
    (quoteNotFound ? "，" + quoteNotFound + " 条页面里没有该原句（不得写成已核实）" : "") +
    (unreachable ? "，" + unreachable + " 条打不开（不得引用）" : "");
  if (params?.strict === true && (quoteNotFound || unreachable)) {
    const bad = items.filter((i) => i.verdict === "quote-not-found" || i.verdict === "unreachable").map((i) => i.url);
    throw new BadRequestException(summary + "。未通过：" + bad.join("、"));
  }
  return { total: items.length, verified, reachableOnly, quoteNotFound, unreachable, summary, items };
};
