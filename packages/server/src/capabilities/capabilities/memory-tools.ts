import { BadRequestException } from "@nestjs/common";
import type { CapabilityContext, CapabilityDescriptor, CapabilityHandler } from "../capability.types";

/**
 * 长期记忆能力（P18）。
 *
 * 设计取舍：
 * - 表 AgentMemory 按 userId 隔离，员工之间共享同一份记忆（同一个老板的助理们要互相知道事情）。
 * - 检索是纯关键词（Prisma contains → MySQL LIKE），在候选集上做 JS 打分（命中次数 + 标题权重 + 新鲜度），
 *   不引入向量库/embedding：一是没有 embedding 凭证，二是单用户记忆量（几百条）关键词足够。
 * - 打分先取最近 200 条候选，避免历史长大后全表扫描。
 */

const MAX_CONTENT = 4000;
const MAX_TITLE = 191;
const MAX_TAGS = 512;
const CANDIDATE_ROWS = 200;
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
    title: "回忆（搜索长期记忆）",
    category: "memory",
    description: "按关键词检索记忆库，返回最相关的若干条记忆",
    params: {
      query: "必填，要回忆的关键词或短句",
      limit: "可选，返回条数，默认 5，最多 20",
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

export function buildMemoryHandlers(prisma: any): Record<string, CapabilityHandler> {
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
      const terms = splitTerms(query);
      if (!terms.length) throw new BadRequestException("query 至少要有一个关键词");
      const rows = await prisma.agentMemory.findMany({
        where: { userId: ctx.userId, OR: terms.flatMap((term) => [{ content: { contains: term } }, { title: { contains: term } }, { tags: { contains: term } }]) },
        orderBy: { createdAt: "desc" },
        take: CANDIDATE_ROWS,
      });
      const now = Date.now();
      const ranked = rows
        .map((row: any) => ({ row, score: scoreRow(row, terms, now) }))
        .filter((entry: any) => entry.score > 0)
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, limit);
      if (ranked.length) {
        await prisma.agentMemory.updateMany({
          where: { id: { in: ranked.map((entry: any) => entry.row.id) }, userId: ctx.userId },
          data: { hitCount: { increment: 1 } },
        });
      }
      return { query, terms, total: ranked.length, items: ranked.map((entry: any) => ({ ...shape(entry.row), score: Math.round(entry.score * 100) / 100 })) };
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
