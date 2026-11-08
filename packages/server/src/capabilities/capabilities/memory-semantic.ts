import { Logger } from "@nestjs/common";

/**
 * 记忆的语义检索（P19）。
 *
 * 为什么不用 embedding：2026-11-07 实测当前火山方舟账号对 doubao-embedding-* 全部 404
 * （InvalidEndpointOrModel.NotFound），线上也没有 SiliconFlow / DashScope 之类的 embedding 凭证，
 * 本地跑 onnx 模型又要往 4C8G 生产机上塞 200MB 依赖。
 *
 * 所以用「小模型做检索的两端」实现语义：
 *   1) 查询扩展（expandQuery）：把「这个客户价格怎么收」扩成 价格/收费/报价/费用… 补上同义词，
 *      关键词召回才能把「报价只接受季度付」捞出来（纯 LIKE 是捞不到的）。
 *   2) 语义重排（rerank）：把候选（标题 + 正文摘要）交给模型打 0–100 相关度，再和关键词分加权合并。
 *
 * 两处都走 doubao-seed-2.0-mini 并关掉思考（thinking.type = disabled），任何一步失败自动退回纯关键词检索，不影响可用性。
 *
 * 为什么必须关思考：2026-11-08 生产实测 doubao-seed-2-0-lite-260428 默认开思考（响应里带 reasoning_content），
 * 查询扩展一次 7.2s、重排 10 条 38.9s，微信客户根本等不起；同一模型加 thinking:{type:"disabled"} 后
 * 扩展 ~1.0s、重排 10 条 ~1.7–2.8s，打分质量不变（相关条目 85 分、无关 0 分）。mini 比 lite 再快一档，
 * 所以默认走 mini（可用 MEMORY_SEMANTIC_MODEL 覆盖别名）。
 */

const logger = new Logger("MemorySemantic");

export const DEFAULT_SEMANTIC_ALIAS = "doubao-seed-2.0-mini";
const EXPAND_TTL_MS = 10 * 60 * 1000;
const EXPAND_CACHE_MAX = 300;
const LLM_TIMEOUT_MS = 8000;
const MAX_EXPANDED = 6;
/** 候选太多模型会变慢、分数也会糊（实测 30 条时分数退化成 0/30），15 条是速度与质量的折中 */
const MAX_RERANK_ITEMS = 15;
/** 每条候选送进模型的正文长度：80–120 字足够判断主题相关，再长只增加延迟 */
const RERANK_SNIPPET = 120;

type ExpandEntry = { terms: string[]; at: number };
const expandCache = new Map<string, ExpandEntry>();

export function clearSemanticCache(): void {
  expandCache.clear();
}

export function semanticEnabled(): boolean {
  return process.env.MEMORY_SEMANTIC !== "0";
}

function cacheGet(query: string): string[] | null {
  const hit = expandCache.get(query);
  if (!hit) return null;
  if (Date.now() - hit.at > EXPAND_TTL_MS) {
    expandCache.delete(query);
    return null;
  }
  return hit.terms;
}

function cacheSet(query: string, terms: string[]) {
  if (expandCache.size >= EXPAND_CACHE_MAX) {
    const oldest = expandCache.keys().next().value;
    if (oldest !== undefined) expandCache.delete(oldest);
  }
  expandCache.set(query, { terms, at: Date.now() });
}

async function callModel(providers: any, prompt: string, maxTokens: number): Promise<string> {
  const alias = process.env.MEMORY_SEMANTIC_MODEL || DEFAULT_SEMANTIC_ALIAS;
  const target = await providers.resolve(alias);
  const work = providers.chat(target, {
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    max_tokens: maxTokens,
    // 关键：不关思考，这些模型每次会烧上千 reasoning token，一次检索要 20–40 秒
    thinking: { type: "disabled" },
  });
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error("语义检索模型超时")), LLM_TIMEOUT_MS));
  const json: any = await Promise.race([work, timer]);
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part: any) => (typeof part === "string" ? part : part?.text || "")).join("");
  return "";
}

function extractJson(text: string, open: string, close: string): any {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function cleanTerm(value: any): string | null {
  if (typeof value !== "string") return null;
  const term = value.trim().replace(/^["'“”]+|["'“”]+$/g, "");
  if (!term || term.length > 12) return null;
  return term;
}

/** 把查询扩展成同义/近义关键词；失败返回空数组 */
export async function expandQuery(providers: any, query: string): Promise<string[]> {
  if (!providers || !semanticEnabled()) return [];
  const cached = cacheGet(query);
  if (cached) return cached;
  const prompt =
    "你是检索助手。用户要在自己的记忆库（客户偏好、报价口径、项目结论）里找东西，请把下面的查询扩展成最多 " +
    MAX_EXPANDED +
    " 个中文检索关键词，用来做同义匹配。\n" +
    "要求：\n" +
    "1) 每个词 2-6 个字，不要带「这个 / 那个 / 客户 / 我的」这类泛指前缀；\n" +
    "2) 覆盖同义说法、常见别名与口语说法（例如「价格」→ 报价、收费、费用、多少钱）；\n" +
    "3) 只输出 JSON 字符串数组，不要解释，不要写标点分隔的句子。\n\n查询：" +
    query;
  try {
    const text = await callModel(providers, prompt, 200);
    const parsed = extractJson(text, "[", "]");
    const terms: string[] = [];
    for (const item of Array.isArray(parsed) ? parsed : []) {
      const term = cleanTerm(item);
      if (term && !terms.includes(term)) terms.push(term);
    }
    const out = terms.slice(0, MAX_EXPANDED);
    if (out.length) cacheSet(query, out);
    return out;
  } catch (e: any) {
    logger.warn("查询扩展失败，退回纯关键词检索：" + (e?.message ?? e));
    return [];
  }
}

/** 让模型给候选打 0–100 相关度；失败返回 null */
export async function rerank(providers: any, query: string, items: { id: string; title?: string | null; text: string }[]): Promise<Map<string, number> | null> {
  if (!providers || !semanticEnabled() || !items.length) return null;
  const payload = items.map((item, index) => ({
    id: item.id,
    i: index,
    title: String(item.title || ""),
    text: String(item.text || "").slice(0, RERANK_SNIPPET),
  }));
  const prompt =
    "你是检索排序助手。用户的查询是：\n" +
    query +
    "\n\n下面是他的记忆条目（JSON）。请判断每条与查询的相关程度：0 = 完全无关，1-30 = 弱相关，" +
    "31-70 = 部分相关，71-100 = 直接回答了查询。\n" +
    "注意：字面不同但语义相关的也要给分（例如查询问价格时，出现报价 / 收费 / 费用的条目应高分）。\n" +
    "只输出 JSON 对象，形如 {\"scores\":[{\"id\":\"...\",\"score\":0}]}，不要输出别的。\n\n" +
    JSON.stringify(payload);
  try {
    const text = await callModel(providers, prompt, 500);
    const parsed = extractJson(text, "{", "}");
    const list = parsed && Array.isArray(parsed.scores) ? parsed.scores : Array.isArray(parsed) ? parsed : [];
    const scores = new Map<string, number>();
    for (const entry of list) {
      const id = entry && typeof entry.id === "string" ? entry.id : null;
      const raw = entry ? Number(entry.score) : NaN;
      if (!id || !Number.isFinite(raw)) continue;
      scores.set(id, Math.min(100, Math.max(0, raw)));
    }
    return scores.size ? scores : null;
  } catch (e: any) {
    logger.warn("语义重排失败，退回关键词排序：" + (e?.message ?? e));
    return null;
  }
}

/**
 * 多轮追问改写（P20）：把「那她呢」「上面说的那个客户」这类带指代的追问，
 * 结合最近几轮对话补全成能独立检索的问题，否则语义检索拿到的只是一个代词。
 */
const REWRITE_TTL_MS = 10 * 60 * 1000;
const REWRITE_CACHE_MAX = 300;
const REWRITE_MAX_CHARS = 80;
export const REWRITE_CONTEXT_MAX = 1200;

const rewriteCache = new Map<string, { text: string; at: number }>();

export function clearRewriteCache(): void {
  rewriteCache.clear();
}

export async function rewriteQuery(providers: any, query: string, context: string): Promise<string | null> {
  const history = String(context || "").trim().slice(-REWRITE_CONTEXT_MAX);
  if (!providers || !semanticEnabled() || !history) return null;
  const key = history.slice(-240) + "\u0000" + query;
  const cached = rewriteCache.get(key);
  if (cached && Date.now() - cached.at <= REWRITE_TTL_MS) return cached.text;
  const prompt =
    "你是检索改写助手。下面是用户与助手最近几轮对话，以及用户现在的问题。\n" +
    "请把「现在的问题」改写成一句独立、完整、能单独拿去检索记忆库的中文问题：\n" +
    "1) 「她 / 他 / 那个客户 / 上面那个方案 / 刚才说的」这类指代，必须按对话补全成具体名字或对象；\n" +
    "2) 问题本身已经完整（没有任何指代）时，原样输出；\n" +
    "3) 只输出改写后的问题本身，不要解释、不要引号、不要超过 " + REWRITE_MAX_CHARS + " 字。\n\n" +
    "最近对话：\n" + history + "\n\n现在的问题：" + query;
  try {
    const text = await callModel(providers, prompt, 120);
    const out = String(text || "")
      .trim()
      .split("\n")[0]
      .trim()
      .replace(/^["'“”]+|["'“”]+$/g, "")
      .trim();
    if (!out || out.length > REWRITE_MAX_CHARS || out === query) return null;
    if (rewriteCache.size >= REWRITE_CACHE_MAX) {
      const oldest = rewriteCache.keys().next().value;
      if (oldest !== undefined) rewriteCache.delete(oldest);
    }
    rewriteCache.set(key, { text: out, at: Date.now() });
    return out;
  } catch (e: any) {
    logger.warn("追问改写失败，按原问题检索：" + (e?.message ?? e));
    return null;
  }
}

export type MemoryMergeVerdict = {
  relation: "duplicate" | "merge" | "different";
  id?: string;
  merged?: string;
};

const MERGE_MAX_CHARS = 1000;

/**
 * 写入前去重/合并判定（P20）：把新记忆与已有候选交给模型比对，
 * 同义重复返回 duplicate（不新增），同主题有新事实返回 merge（给出合并后正文）。
 * 任何异常都返回 null，调用方按原逻辑新增，绝不因为判定失败而丢记忆。
 */
export async function judgeMemory(
  providers: any,
  content: string,
  candidates: { id: string; title?: string | null; text: string }[],
): Promise<MemoryMergeVerdict | null> {
  if (!providers || !semanticEnabled() || !candidates.length) return null;
  const payload = candidates.map((item) => ({
    id: item.id,
    title: String(item.title || ""),
    text: String(item.text || "").slice(0, 400),
  }));
  const prompt =
    "你是记忆库管理员。下面是「新记忆」和「已有记忆」（JSON）。请判断新记忆与哪一条已有记忆是同一件事：\n" +
    "- duplicate：意思完全相同，只是措辞不同，没有新增任何事实；\n" +
    "- merge：同一对象/同一主题，但新记忆补充或更新了事实（新的偏好、新的报价、新的进展）；\n" +
    "- different：讲的是不同的事。\n" +
    "只输出 JSON 对象：{\"relation\":\"duplicate|merge|different\",\"id\":\"命中的已有记忆 id\",\"merged\":\"合并后的正文\"}；\n" +
    "relation=merge 时 merged 必须保留两者全部具体事实（人名、数字、日期、金额、渠道），去掉重复表述，不超过 " +
    MERGE_MAX_CHARS +
    " 字；duplicate 和 different 时 merged 留空字符串。不要输出别的。\n\n新记忆：\n" +
    content +
    "\n\n已有记忆：\n" +
    JSON.stringify(payload);
  try {
    const text = await callModel(providers, prompt, 900);
    const parsed = extractJson(text, "{", "}");
    const relation = parsed && typeof parsed.relation === "string" ? parsed.relation.trim() : "";
    if (relation !== "duplicate" && relation !== "merge" && relation !== "different") return null;
    if (relation === "different") return { relation };
    const id = parsed && typeof parsed.id === "string" ? parsed.id.trim() : "";
    if (!id || !candidates.some((item) => item.id === id)) return null;
    if (relation === "duplicate") return { relation, id };
    const merged = parsed && typeof parsed.merged === "string" ? parsed.merged.trim() : "";
    if (!merged) return { relation: "merge", id };
    return { relation: "merge", id, merged: merged.slice(0, MERGE_MAX_CHARS) };
  } catch (e: any) {
    logger.warn("记忆去重判定失败，按新增写入：" + (e?.message ?? e));
    return null;
  }
}

/** 合并关键词分与语义分（0–100 归一化）：关键词占 40%，语义占 60% */
export function combineScores(keywordScore: number, maxKeywordScore: number, semanticScore: number | undefined): number {
  const normKeyword = maxKeywordScore > 0 ? (keywordScore / maxKeywordScore) * 100 : 0;
  if (semanticScore === undefined) return normKeyword;
  return normKeyword * 0.4 + semanticScore * 0.6;
}

export const SEMANTIC_LIMITS = { MAX_RERANK_ITEMS, MAX_EXPANDED, LLM_TIMEOUT_MS, RERANK_SNIPPET };
