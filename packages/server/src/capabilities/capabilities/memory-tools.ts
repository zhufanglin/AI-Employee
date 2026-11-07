import { BadRequestException } from "@nestjs/common";
import type { CapabilityContext, CapabilityDescriptor, CapabilityHandler } from "../capability.types";
import { SEMANTIC_LIMITS, combineScores, expandQuery, rerank, semanticEnabled } from "./memory-semantic";

/**
 * 长期记忆能力（P18）。
 *
 * 设计取舍：
 * - 表 AgentMemory 按 userId 隔离，员工之间共享同一份记忆（同一个老板的助理们要互相知道事情）。
 * - 召回：Prisma contains（MySQL LIKE）取候选，先取最近 200 条，避免历史长大后全表扫描。
 * - 排序：关键词分（命中次数 + 标题权重 + 标签权重 + 新鲜度）与语义分（小模型重排 0–100）加权合并，
 *   语义部分见 memory-semantic.ts（P19：没有 embedding 凭证，用「查询扩展 + 模型重排」实现语义检索）。
 * - 语义三步（扩展 → 召回补齐 → 重排）任何一步失败都自动退回纯关键词排序，检索永远可用；
 *   传 mode=keyword 可强制关掉语义。候选补齐见 memory_search 里的注释：光靠扩展词做 LIKE，
 *   遇到「查结汇、记忆里写回款走 Payoneer」这种纯语义查询会一条都召不回来。
 */

const MAX_CONTENT = 4000;
const MAX_TITLE = 191;
const MAX_TAGS = 512;
const CANDIDATE_ROWS = 200;
/** 关键词召回不够时，用最近的记忆把重排候选位补满 */
const SUPPLEMENT_ROWS = 60;
const KINDS = new Set(["note", "fact", "preference", "lesson"]);

function str(value: any, name: string, max?: number): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequestException(name + " 必填");
  const text = value.trim();
  if (max && text.length > max) throw new BadRequestException(name + " 超过 " + max + " 字");
  return text;
}

function optionalStr(value: any, name: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new BadRequestException(name + " 必须是字符串");
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) throw new BadRequestException(name + " 超过 " + max + " 字");
  return text;
}

function normalizeTags(value: any): string | null {
  if (value === undefined || value === null || value === "") return null;
  const list = Array.isArray(value) ? value : String(value).split(/[,，;；\s]+/);
  const tags = Array.from(new Set(list.map((item) => String(item).trim()).filter(Boolean)));
  if (!tags.length) return null;
  if (tags.length > 10) throw new BadRequestException("tags 最多 10 个");
  const joined = tags.join(",");
  if (joined.length > MAX_TAGS) throw new BadRequestException("tags 合计超过 " + MAX_TAGS + " 字");
  return joined;
}

/** 把查询拆成关键词：空白/标点切开，过长的中文片段再补二元组，保证「客户报价」能命中「报价」类记录 */
export function splitTerms(query: string): string[] {
  const parts = String(query)
    .split(/[\s,，。.;；:：!！?？、/\\|()（）\[\]【】"'“”‘’<>《》]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 1);
  const terms = new Set<string>();
  for (const part of parts) {
    terms.add(part);
    if (part.length >= 4 && /[^\x00-\x7f]/.test(part)) {
      for (let i = 0; i + 2 <= part.length; i += 2) terms.add(part.slice(i, i + 2));
    }
  }
  return Array.from(terms).slice(0, 8);
}

function scoreRow(row: any, terms: string[], now: number) {
  const content = String(row.content || "");
  const title = String(row.title || "");
  const tags = String(row.tags || "");
  let score = 0;
  for (const term of terms) {
    const inTitle = title.split(term).length - 1;
    const inContent = content.split(term).length - 1;
    const inTags = tags.split(term).length - 1;
    score += inContent + inTitle * 3 + inTags * 2;
  }
  const ageDays = Math.max(0, (now - new Date(row.createdAt).getTime()) / 86400000);
  score += Math.max(0, 2 - ageDays / 30);
  score += Math.min(1, (row.hitCount || 0) * 0.1);
  return score;
}

function shape(row: any) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    tags: row.tags ? String(row.tags).split(",") : [],
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

export const descriptors: CapabilityDescriptor[] = [
  {
    name: "memory_save",
    title: "记住一件事（长期记忆）",
    category: "memory",
    description: "把值得长期记住的信息写进记忆库：客户偏好、报价口径、项目结论、踩过的坑",
    params: {
      content: "必填，要记住的内容（不超过 4000 字）",
      title: "可选，短标题（不超过 191 字）",
      tags: "可选，标签，逗号分隔或数组，最多 10 个",
      kind: "可选，类型：note（默认）|fact|preference|lesson",
    },
  },
  {
    name: "memory_search",
    title: "回忆（语义检索长期记忆）",
    category: "memory",
    description: "检索记忆库，按语义相关性返回最相关的若干条记忆（字面不同、意思相近也能召回）",
    params: {
      query: "必填，要回忆的问题或关键词，例如「这个客户的价格怎么收」",
      limit: "可选，返回条数，默认 5，最多 20",
      mode: "可选，auto（默认，语义+关键词）| keyword（只用关键词，更快更省）",
    },
  },
  {
    name: "memory_list",
    title: "最近记住的事",
    category: "memory",
    description: "按时间倒序列出最近写入的记忆",
    params: { limit: "可选，返回条数，默认 10，最多 50" },
  },
  {
    name: "memory_delete",
    title: "忘记一件事",
    category: "memory",
    description: "按 id 删除一条记忆（只删自己的）",
    params: { id: "必填，记忆 id（可从 memory_search / memory_list 获得）" },
  },
];

export function buildMemoryHandlers(prisma: any, providers?: any): Record<string, CapabilityHandler> {
  return {
    memory_save: async (ctx: CapabilityContext) => {
      const content = str(ctx.params.content, "content", MAX_CONTENT);
      const title = optionalStr(ctx.params.title, "title", MAX_TITLE);
      const tags = normalizeTags(ctx.params.tags);
      const kindRaw = optionalStr(ctx.params.kind, "kind", 20) || "note";
      if (!KINDS.has(kindRaw)) throw new BadRequestException("kind 只能是 note/fact/preference/lesson");
      const employeeSlug = optionalStr(ctx.params.employeeSlug, "employeeSlug", 64);
      const sourceTaskId = optionalStr(ctx.params.sourceTaskId, "sourceTaskId", 64);
      const row = await prisma.agentMemory.create({
        data: { userId: ctx.userId, kind: kindRaw, title, content, tags, employeeSlug, sourceTaskId },
      });
      return { id: row.id, kind: row.kind, title: row.title, createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt };
    },

    memory_search: async (ctx: CapabilityContext) => {
      const query = str(ctx.params.query, "query", 200);
      const limit = Math.min(Math.max(Math.trunc(Number(ctx.params.limit) || 5), 1), 20);
      const mode = optionalStr(ctx.params.mode, "mode", 16) || "auto";
      const baseTerms = splitTerms(query);
      const useSemantic = !!providers && semanticEnabled() && mode !== "keyword";
      if (!baseTerms.length) throw new BadRequestException("query 至少要有一个关键词");

      // 语义第一步：查询扩展。「这个客户价格怎么收」扩成 价格/报价/收费… 才能召回「报价只接受季度付」
      const expanded = useSemantic ? await expandQuery(providers, query) : [];
      const terms = Array.from(new Set([...baseTerms, ...expanded])).slice(0, 16);
      const rows = await prisma.agentMemory.findMany({
        where: { userId: ctx.userId, OR: terms.flatMap((term) => [{ content: { contains: term } }, { title: { contains: term } }, { tags: { contains: term } }]) },
        orderBy: { createdAt: "desc" },
        take: CANDIDATE_ROWS,
      });
      const now = Date.now();
      const candidates: any[] = rows
        .map((row: any) => ({ row, keyword: scoreRow(row, terms, now) }))
        .filter((entry: any) => entry.keyword > 0)
        .sort((a: any, b: any) => b.keyword - a.keyword)
        .slice(0, SEMANTIC_LIMITS.MAX_RERANK_ITEMS);

      // 语义第二步：补齐候选。扩展词仍然只是「词」，靠 LIKE 召回不到纯语义的表述
      // （实测：查「他那边结汇走什么渠道」，记忆里写的是「回款走 Payoneer」，关键词召回 0 条，
      //  重排根本没机会判断）。所以候选不够时用最近的记忆补满，交给模型挑。
      if (useSemantic && candidates.length < SEMANTIC_LIMITS.MAX_RERANK_ITEMS) {
        const picked = new Set(candidates.map((entry: any) => entry.row.id));
        const recent = await prisma.agentMemory.findMany({
          where: { userId: ctx.userId },
          orderBy: { createdAt: "desc" },
          take: SUPPLEMENT_ROWS,
        });
        for (const row of recent) {
          if (picked.has(row.id)) continue;
          candidates.push({ row, keyword: 0 });
          picked.add(row.id);
          if (candidates.length >= SEMANTIC_LIMITS.MAX_RERANK_ITEMS) break;
        }
      }

      // 语义第三步：模型重排（0–100 相关度），候选补齐进来的条目关键词分为 0，只能靠语义分进榜
      const semanticScores: Map<string, number> | null = useSemantic && candidates.length
        ? await rerank(providers, query, candidates.map((entry: any) => ({ id: entry.row.id, title: entry.row.title, text: entry.row.content })))
        : null;
      const maxKeyword = candidates.reduce((max: number, entry: any) => Math.max(max, entry.keyword), 0);
      const ranked = candidates
        .map((entry: any) => {
          const semanticScore = semanticScores ? semanticScores.get(entry.row.id) : undefined;
          return { row: entry.row, keywordScore: entry.keyword, semanticScore, score: combineScores(entry.keyword, maxKeyword, semanticScore) };
        })
        .filter((entry: any) => entry.score > 0)
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, limit);

      if (ranked.length) {
        await prisma.agentMemory.updateMany({
          where: { id: { in: ranked.map((entry: any) => entry.row.id) }, userId: ctx.userId },
          data: { hitCount: { increment: 1 } },
        });
      }
      return {
        query,
        terms,
        expandedTerms: expanded,
        semantic: !!semanticScores,
        total: ranked.length,
        items: ranked.map((entry: any) => ({
          ...shape(entry.row),
          score: Math.round(entry.score * 100) / 100,
          keywordScore: Math.round(entry.keywordScore * 100) / 100,
          semanticScore: entry.semanticScore === undefined ? null : entry.semanticScore,
        })),
      };
    },

    memory_list: async (ctx: CapabilityContext) => {
      const limit = Math.min(Math.max(Math.trunc(Number(ctx.params.limit) || 10), 1), 50);
      const rows = await prisma.agentMemory.findMany({ where: { userId: ctx.userId }, orderBy: { createdAt: "desc" }, take: limit });
      return { total: rows.length, items: rows.map(shape) };
    },

    memory_delete: async (ctx: CapabilityContext) => {
      const id = str(ctx.params.id, "id", 64);
      const found = await prisma.agentMemory.findFirst({ where: { id, userId: ctx.userId } });
      if (!found) throw new BadRequestException("记忆不存在或不属于你");
      await prisma.agentMemory.deleteMany({ where: { id, userId: ctx.userId } });
      return { id, deleted: true };
    },
  };
}
