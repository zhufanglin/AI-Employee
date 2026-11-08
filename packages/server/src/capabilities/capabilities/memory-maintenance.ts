import { BadRequestException } from "@nestjs/common";
import type { CapabilityContext, CapabilityDescriptor, CapabilityHandler } from "../capability.types";
import { judgeMemory, semanticEnabled } from "./memory-semantic";

/**
 * 存量记忆清理（P21）。
 *
 * 背景：P20 之后新写入的记忆会自动查重/合并，但 P20 之前已经写重的历史记忆还留在库里
 * （同一件事写了两三遍、同一客户的情况散在几条记录里）。这个能力把存量扫一遍：
 *
 * 1. 召回：直接读该用户最近 200 条记忆（单用户记忆量只有几百条，不值得上向量库）；
 * 2. 粗筛：纯 JS 算词面相似度（分词 + 中文二元组，Jaccard），只把「看起来像」的 5 条交给模型，
 *    避免几百条记忆两两比对把模型打爆；
 * 3. 精判：复用 P20 的 judgeMemory，得到 duplicate（同义）/ merge（同主题补事实）/ different；
 * 4. 落库：apply 模式下合并进**较早**的那条（id 不变，命中次数相加、标签取并集、正文取合并结果），
 *    删掉较晚的重复条；report 模式只出报告，不动数据（默认）。
 *
 * 为什么保留较早那条：记忆里的客户偏好/报价往往越早越权威，后来的记录多为补充；
 * 且外部（其他任务、人工核对）引用早期 id 的概率更高。
 */

const MAX_ROWS = 200;
const DEFAULT_SCAN = 30;
const MAX_SCAN = 60;
const MAX_CANDIDATES = 5;
/** 词面相似度门槛：低于它连模型都不问（避免无谓调用） */
const MIN_SIMILARITY = 0.12;
const MIN_SHARED = 2;
const MAX_CONTENT = 4000;
const MAX_TAGS = 512;
const MAX_CALLS = 30;
const BUDGET_MS = 55000;

/** 分词：空白/标点切分，中文长片段补二元组，用于词面粗筛 */
export function tokenize(text: string): string[] {
  const parts = String(text || "")
    .split(/[\s,，。.;；:：!！?？、/\\|()（）\[\]【】"'“”‘’<>《》]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const tokens = new Set<string>();
  for (const part of parts) {
    tokens.add(part);
    if (part.length >= 2 && /[^\x00-\x7f]/.test(part)) {
      for (let i = 0; i + 2 <= part.length; i += 1) tokens.add(part.slice(i, i + 2));
    }
  }
  return Array.from(tokens).slice(0, 80);
}

export function similarity(a: string, b: string): { score: number; shared: number } {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (!left.size || !right.size) return { score: 0, shared: 0 };
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = left.size + right.size - shared;
  return { score: union > 0 ? shared / union : 0, shared };
}

function rowText(row: any): string {
  return [row?.title, row?.content, row?.tags].filter(Boolean).join(" ");
}

/** 标签并集（逗号分隔），按 512 字截断 */
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

function iso(value: any): any {
  return value instanceof Date ? value.toISOString() : value;
}

function preview(text: string, max = 200): string {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

export const descriptors: CapabilityDescriptor[] = [
  {
    name: "memory_dedupe",
    title: "清理存量重复记忆",
    category: "memory",
    description:
      "把已经写重的历史记忆收一遍：逐条与相似记忆比对，找出同义重复与可合并的条目。默认只出报告（report），确认后用 mode=apply 执行合并与删除，合并进较早的那条",
    params: {
      mode: "可选，report（默认，只报告不改数据）| apply（执行合并并删除多余条目）",
      limit: "可选，本次扫描多少条记忆（从最新往回扫），默认 " + DEFAULT_SCAN + "，最多 " + MAX_SCAN,
    },
  },
];

export function buildMemoryMaintenanceHandlers(prisma: any, providers?: any): Record<string, CapabilityHandler> {
  return {
    memory_dedupe: async (ctx: CapabilityContext) => {
      const modeRaw = typeof ctx.params.mode === "string" ? ctx.params.mode.trim() : "report";
      if (modeRaw !== "report" && modeRaw !== "apply") throw new BadRequestException("mode 只能是 report 或 apply");
      if (!providers || !semanticEnabled()) {
        throw new BadRequestException("记忆清理需要语义模型，请检查 MEMORY_SEMANTIC 配置后再试");
      }

      let limit = DEFAULT_SCAN;
      if (ctx.params.limit !== undefined && ctx.params.limit !== null && ctx.params.limit !== "") {
        const raw = Number(ctx.params.limit);
        if (!Number.isFinite(raw) || raw < 1) throw new BadRequestException("limit 必须是正整数");
        limit = Math.min(MAX_SCAN, Math.floor(raw));
      }

      const startedAt = Date.now();
      const rows: any[] = await prisma.agentMemory.findMany({
        where: { userId: ctx.userId },
        orderBy: { createdAt: "desc" },
        take: MAX_ROWS,
      });
      const scan = rows.slice(0, limit);
      const used = new Set<string>();
      const proposals: any[] = [];
      let calls = 0;
      let applied = 0;
      let truncated = false;

      for (const base of scan) {
        if (used.has(base.id)) continue;
        const candidates = scan
          .filter((row) => row.id !== base.id && !used.has(row.id))
          .map((row) => ({ row, byWords: similarity(rowText(base), rowText(row)) }))
          .filter((item) => item.byWords.shared >= MIN_SHARED && item.byWords.score >= MIN_SIMILARITY)
          .sort((left, right) => right.byWords.score - left.byWords.score)
          .slice(0, MAX_CANDIDATES);
        if (!candidates.length) continue;

        if (calls >= MAX_CALLS || Date.now() - startedAt > BUDGET_MS) {
          truncated = true;
          break;
        }
        calls += 1;
        const verdict = await judgeMemory(
          providers,
          String(base.content || ""),
          candidates.map((item) => ({ id: item.row.id, title: item.row.title, text: item.row.content })),
        );
        if (!verdict || verdict.relation === "different") continue;
        const match = candidates.find((item) => item.row.id === verdict.id);
        if (!match) continue;

        const baseTime = new Date(base.createdAt).getTime();
        const matchTime = new Date(match.row.createdAt).getTime();
        const keep = baseTime <= matchTime ? base : match.row;
        const drop = keep === base ? match.row : base;
        const mergedText =
          verdict.relation === "merge" && verdict.merged
            ? verdict.merged
            : verdict.relation === "merge"
              ? keep.content + "\n" + drop.content
              : keep.content;
        const previewText = String(mergedText || "").slice(0, MAX_CONTENT);

        proposals.push({
          relation: verdict.relation,
          keepId: keep.id,
          dropId: drop.id,
          keepTitle: keep.title || null,
          dropTitle: drop.title || null,
          keepCreatedAt: iso(keep.createdAt),
          dropCreatedAt: iso(drop.createdAt),
          similarity: Number(match.byWords.score.toFixed(3)),
          mergedPreview: verdict.relation === "merge" ? preview(previewText) : null,
        });

        if (modeRaw === "apply") {
          const nextContent = previewText;
          const nextTags = unionTags(keep.tags, drop.tags);
          const nextTitle = keep.title || drop.title || null;
          const nextHits = (keep.hitCount || 0) + (drop.hitCount || 0);
          await prisma.agentMemory.update({
            where: { id: keep.id },
            data: {
              content: nextContent,
              tags: nextTags,
              title: nextTitle,
              hitCount: nextHits,
            },
          });
          await prisma.agentMemory.deleteMany({ where: { id: drop.id, userId: ctx.userId } });
          // 让后续比对看到合并后的正文
          keep.content = nextContent;
          keep.tags = nextTags;
          keep.title = nextTitle;
          keep.hitCount = nextHits;
          used.add(drop.id);
          applied += 1;
        } else {
          // 报告模式：同一条既当保留方又当被合并方会让报告重复，故两边都跳过
          used.add(drop.id);
          used.add(keep.id);
        }
      }

      return {
        mode: modeRaw,
        total: rows.length,
        scanned: scan.length,
        calls,
        applied,
        truncated,
        durationMs: Date.now() - startedAt,
        proposals,
      };
    },
  };
}
