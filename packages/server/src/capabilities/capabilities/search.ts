import { BadRequestException } from "@nestjs/common";
import type { CapabilityDescriptor, CapabilityHandler } from "../capability.types";
import { env } from "../../common/env";

/** 联网搜索：原版预装技能 tavily-search 的明文重写，支持 Tavily / Bing 两家供应商。 */
export const descriptor: CapabilityDescriptor = {
  name: "web_search",
  title: "联网搜索",
  category: "web",
  description: "用搜索引擎检索公开网页，返回标题/链接/摘要；需要正文时再用 web_extract 抓取",
  params: { query: "必填，检索词", maxResults: "可选，条数 1-10，默认 5", days: "可选，只取最近 N 天（1-365）" },
};

const SNIPPET_MAX = 400;
const TOTAL_BUDGET = 6000;

export interface SearchItem { title: string; url: string; snippet: string; published: string | null }

function clip(input: unknown, max: number): string {
  const text = typeof input === "string" ? input : input == null ? "" : String(input);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "..." : flat;
}

/** 把各供应商的返回结构归一成统一形状，并做总长度预算截断。 */
export function normalizeItems(items: SearchItem[]): SearchItem[] {
  const out: SearchItem[] = [];
  let budget = TOTAL_BUDGET;
  for (const item of items) {
    if (budget <= 0) break;
    const snippet = clip(item.snippet, Math.min(SNIPPET_MAX, budget));
    budget -= snippet.length;
    out.push({ title: clip(item.title, 120), url: String(item.url || ""), snippet, published: item.published ? String(item.published) : null });
  }
  return out;
}

function tavilyKey(): string { return env("TAVILY_API_KEY", "").trim(); }
function bingKey(): string { return env("BING_SEARCH_KEY", "").trim(); }

export function pickProvider(): "tavily" | "bing" | null {
  const configured = env("SEARCH_PROVIDER", "").trim().toLowerCase();
  if (configured === "tavily") return tavilyKey() ? "tavily" : null;
  if (configured === "bing") return bingKey() ? "bing" : null;
  if (tavilyKey()) return "tavily";
  if (bingKey()) return "bing";
  return null;
}

async function searchTavily(query: string, maxResults: number, days: number | null): Promise<SearchItem[]> {
  const body: Record<string, unknown> = { api_key: tavilyKey(), query, max_results: maxResults, search_depth: "basic", include_answer: false };
  if (days) body.days = days;
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  if (!response.ok) throw new BadRequestException(`搜索服务返回 ${response.status}：${clip(text, 200)}`);
  let data: any;
  try { data = JSON.parse(text); } catch { throw new BadRequestException("搜索服务返回了非 JSON 内容"); }
  const results: any[] = Array.isArray(data?.results) ? data.results : [];
  return results.map((row) => ({ title: String(row?.title ?? ""), url: String(row?.url ?? ""), snippet: String(row?.content ?? row?.snippet ?? ""), published: row?.published_date ? String(row.published_date) : null }));
}

async function searchBing(query: string, maxResults: number): Promise<SearchItem[]> {
  const url = new URL("https://api.bing.microsoft.com/v7.0/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));
  url.searchParams.set("mkt", "zh-CN");
  const response = await fetch(url, { headers: { "Ocp-Apim-Subscription-Key": bingKey() }, signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  if (!response.ok) throw new BadRequestException(`搜索服务返回 ${response.status}：${clip(text, 200)}`);
  let data: any;
  try { data = JSON.parse(text); } catch { throw new BadRequestException("搜索服务返回了非 JSON 内容"); }
  const rows: any[] = Array.isArray(data?.webPages?.value) ? data.webPages.value : [];
  return rows.map((row) => ({ title: String(row?.name ?? ""), url: String(row?.url ?? ""), snippet: String(row?.snippet ?? ""), published: row?.datePublished ? String(row.datePublished) : null }));
}

export const handler: CapabilityHandler = async ({ params }) => {
  const query = String(params.query ?? "").trim();
  if (!query) throw new BadRequestException("query 必填");
  if (query.length > 400) throw new BadRequestException("query 过长（最多 400 字）");
  const maxResults = Math.min(Math.max(Math.trunc(Number(params.maxResults) || 5), 1), 10);
  const rawDays = Number(params.days);
  const days = Number.isFinite(rawDays) && rawDays >= 1 && rawDays <= 365 ? Math.trunc(rawDays) : null;
  const provider = pickProvider();
  if (!provider) throw new BadRequestException("未配置搜索服务，请联系管理员配置 TAVILY_API_KEY 或 BING_SEARCH_KEY");
  const raw = provider === "tavily" ? await searchTavily(query, maxResults, days) : await searchBing(query, maxResults);
  const items = normalizeItems(raw).filter((item) => item.url);
  return { provider, query, total: items.length, items };
};
