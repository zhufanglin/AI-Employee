import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ProvidersService } from "../providers/providers.service";
import { CapabilityService } from "../capabilities/capability.service";
import { judgeMemory } from "../capabilities/capabilities/memory-semantic";

/**
 * 记忆管理（P23）：给桌面端「🧠 记忆」页面用的 REST 服务。
 *
 * 与 capabilities/memory-tools.ts 的关系：那边是给 AI 员工调用的能力（写入/检索），
 * 这边是给人看的后台管理接口（列表/统计/删除/手动合并/查重），两者共用 AgentMemory 表与
 * judgeMemory 语义判定，但权限边界都在 userId 上（越权一律当作不存在 → 404）。
 */

const KINDS = ["note", "fact", "preference", "lesson"];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_CONTENT = 4000;
const MAX_TAGS = 512;
const DEFAULT_DEDUPE_LIMIT = 30;
const MAX_DEDUPE_LIMIT = 60;
const DAY_MS = 86400000;

function userIdOf(user: any): string {
  const id = user && typeof user.id === "string" ? user.id.trim() : "";
  if (!id) throw new BadRequestException("未登录");
  return id;
}

function iso(value: any): any {
  return value instanceof Date ? value.toISOString() : value;
}

/** 库里 tags 是逗号分隔字符串（可能为 null/空串），对外一律返回数组 */
function tagArray(raw: any): string[] {
  if (raw === undefined || raw === null) return [];
  return String(raw)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 标签并集：保序去重，逗号拼接总长不超过 512 */
function unionTags(a: any, b: any): string | null {
  const list: string[] = [];
  for (const raw of [a, b]) {
    for (const item of String(raw || "").split(",")) {
      const tag = item.trim();
      if (tag && !list.includes(tag)) list.push(tag);
    }
  }
  if (!list.length) return null;
  const out: string[] = [];
  let length = 0;
  for (const tag of list) {
    const next = length ? length + 1 + tag.length : tag.length;
    if (next > MAX_TAGS) break;
    out.push(tag);
    length = next;
  }
  return out.length ? out.join(",") : null;
}

function shape(row: any) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title ?? null,
    content: row.content,
    tags: tagArray(row.tags),
    employeeSlug: row.employeeSlug ?? null,
    sourceTaskId: row.sourceTaskId ?? null,
    hitCount: row.hitCount ?? 0,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function clampInt(value: any, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) throw new BadRequestException(name + " 必须是数字");
  return Math.min(Math.max(Math.trunc(num), min), max);
}

function cleanId(value: any, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequestException(name + " 必填");
  const id = value.trim();
  if (id.length > 64) throw new BadRequestException(name + " 超过 64 字符");
  return id;
}

@Injectable()
export class MemoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProvidersService,
    private readonly capabilities: CapabilityService,
  ) {}

  /** 列表：keyset 分页（createdAt DESC, id DESC），筛选条件同时用于 count */
  async list(user: any, params: any = {}) {
    const userId = userIdOf(user);
    const limit = clampInt(params?.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, "limit");
    const kind = typeof params?.kind === "string" ? params.kind.trim() : "";
    if (kind && !KINDS.includes(kind)) throw new BadRequestException("kind 只能是 note/fact/preference/lesson");
    const query = typeof params?.query === "string" ? params.query.trim() : "";
    const cursor = typeof params?.cursor === "string" ? params.cursor.trim() : "";

    const base: any = { userId };
    if (kind) base.kind = kind;
    if (query) base.OR = [{ title: { contains: query } }, { content: { contains: query } }, { tags: { contains: query } }];

    let where: any = { ...base };
    if (cursor) {
      // 游标记录必须属于当前用户；已删除/伪造的游标按第一页处理，避免翻页中断
      const anchor = await (this.prisma as any).agentMemory.findFirst({ where: { id: cursor, userId } });
      if (anchor) {
        where = {
          AND: [
            base,
            {
              OR: [
                { createdAt: { lt: anchor.createdAt } },
                { createdAt: anchor.createdAt, id: { lt: anchor.id } },
              ],
            },
          ],
        };
      }
    }

    const rows = await (this.prisma as any).agentMemory.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const total = await (this.prisma as any).agentMemory.count({ where: base });
    const page = rows.slice(0, limit);
    return {
      items: page.map(shape),
      nextCursor: rows.length > limit && page.length ? page[page.length - 1].id : null,
      total,
    };
  }

  /** 统计：按 kind 分组、最近 7 天新增、标签 Top 8 */
  async stats(user: any) {
    const userId = userIdOf(user);
    const since = new Date(Date.now() - 7 * DAY_MS);
    const [total, groups, last7d, tagRows] = await Promise.all([
      (this.prisma as any).agentMemory.count({ where: { userId } }),
      (this.prisma as any).agentMemory.groupBy({ by: ["kind"], where: { userId }, _count: { _all: true } }),
      (this.prisma as any).agentMemory.count({ where: { userId, createdAt: { gte: since } } }),
      (this.prisma as any).agentMemory.findMany({ where: { userId }, select: { tags: true } }),
    ]);

    const byKind: Record<string, number> = { note: 0, fact: 0, preference: 0, lesson: 0 };
    for (const group of groups || []) {
      if (group && typeof group.kind === "string") byKind[group.kind] = Number(group._count?._all ?? group._count ?? 0);
    }

    const counts = new Map<string, number>();
    for (const row of tagRows || []) {
      for (const tag of tagArray(row?.tags)) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    const topTags = Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, 8);

    return { total, byKind, last7d, topTags };
  }

  /** 删除自己的记忆；不存在 / 别人的一律 404 */
  async remove(user: any, id: string) {
    const userId = userIdOf(user);
    const value = cleanId(id, "id");
    const found = await (this.prisma as any).agentMemory.findFirst({ where: { id: value, userId } });
    if (!found) throw new NotFoundException("记忆不存在或不属于你");
    await (this.prisma as any).agentMemory.deleteMany({ where: { id: value, userId } });
    return { success: true, id: value };
  }

  /**
   * 手动合并两条记忆。保留 createdAt 更早的那条（调用方传反也以更早为准）。
   * 正文优先采用 judgeMemory 的 merge 结果（仅 relation=merge 且返回 merged），否则拼接后截 4000 字。
   */
  async merge(user: any, body: any = {}) {
    const userId = userIdOf(user);
    const keepId = cleanId(body?.keepId, "keepId");
    const dropId = cleanId(body?.dropId, "dropId");
    if (keepId === dropId) throw new BadRequestException("keepId 与 dropId 不能相同");

    const [first, second] = await Promise.all([
      (this.prisma as any).agentMemory.findFirst({ where: { id: keepId, userId } }),
      (this.prisma as any).agentMemory.findFirst({ where: { id: dropId, userId } }),
    ]);
    if (!first || !second) throw new NotFoundException("记忆不存在或不属于你");

    const firstTime = new Date(first.createdAt).getTime();
    const secondTime = new Date(second.createdAt).getTime();
    // 时间相同则以调用方传入的 keepId 为准
    const keep = firstTime <= secondTime ? first : second;
    const drop = keep === first ? second : first;

    let mergedText: string | null = null;
    try {
      const verdict = await judgeMemory(this.providers, String(keep.content || ""), [
        { id: drop.id, title: drop.title, text: String(drop.content || "") },
      ]);
      if (verdict && verdict.relation === "merge" && verdict.merged) mergedText = verdict.merged.trim();
    } catch {
      // 语义合并失败不影响手动合并：退化为正文拼接
    }
    const usedLlm = !!mergedText;
    const content = (usedLlm ? mergedText : String(keep.content || "") + "\n" + String(drop.content || "")).slice(0, MAX_CONTENT);
    const tags = unionTags(keep.tags, drop.tags);
    const title = keep.title || drop.title || null;
    const hitCount = (keep.hitCount || 0) + (drop.hitCount || 0);

    // update keep + delete drop 必须原子提交，避免合并到一半留下半条数据
    await (this.prisma as any).$transaction(async (tx: any) => {
      await tx.agentMemory.update({
        where: { id: keep.id },
        data: { content, tags, title, hitCount },
      });
      await tx.agentMemory.delete({ where: { id: drop.id } });
    });

    return { id: keep.id, content, tags: tagArray(tags), hitCount, mergedFrom: [drop.id], usedLlm };
  }

  /** 存量查重委托给能力层 memory_dedupe，接口只做参数校验与解包 */
  async dedupe(user: any, body: any = {}) {
    const userId = userIdOf(user);
    const rawMode = body?.mode === undefined || body?.mode === null || body?.mode === "" ? "apply" : String(body.mode).trim();
    if (rawMode !== "report" && rawMode !== "apply") throw new BadRequestException("mode 只能是 report 或 apply");
    let limit = DEFAULT_DEDUPE_LIMIT;
    if (body?.limit !== undefined && body?.limit !== null && body?.limit !== "") {
      const num = Number(body.limit);
      if (!Number.isFinite(num) || num < 1) throw new BadRequestException("limit 必须是正整数");
      limit = Math.min(MAX_DEDUPE_LIMIT, Math.floor(num));
    }

    const result = await this.capabilities.run({ id: userId }, "memory_dedupe", { mode: rawMode, limit });
    if (!result || result.success === false) {
      throw new BadRequestException((result && result.error) || "记忆查重失败");
    }
    return result.data;
  }
}
