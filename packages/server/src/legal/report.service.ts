import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * P45-4：举报与投诉（AI 生成内容违规 / 违法违规信息 / 侵权 / 个人信息 / 计费 / 功能故障 / 其他）
 *
 * 合规依据：《网络信息内容生态治理规定》要求平台公示投诉举报入口并及时受理，
 * 《生成式人工智能服务管理暂行办法》第十五条要求对违法内容及时处置。
 *
 * 关键约束：
 * - 入口必须 @Public（未登录用户、审核机构、被侵权人都要能提交），userId 尽力而为；
 * - IP 限流放在进程内（单实例部署；多实例时换成 Redis，量级很小不值得引入依赖）；
 * - 不建外键到 User：匿名举报也要落库，且用户注销后工单仍需留档。
 */

export const CATEGORIES = [
  "ai-content", // AI 生成内容违规（涉政/涉黄/暴力/虚假信息等）
  "illegal", // 违法违规信息
  "copyright", // 侵权（著作权/商标/肖像）
  "privacy", // 个人信息 / 隐私泄露
  "billing", // 计费与积分
  "bug", // 功能故障
  "other", // 其他
] as const;

export const CATEGORY_LABELS: Record<string, string> = {
  "ai-content": "AI 生成内容违规",
  illegal: "违法违规信息",
  copyright: "侵权投诉",
  privacy: "个人信息与隐私",
  billing: "计费与积分",
  bug: "功能故障",
  other: "其他",
};

const MIN_CONTENT = 5;
const MAX_CONTENT = 2000;
const MAX_CONTACT = 120;
const MAX_URL = 500;
const MAX_UA = 255;
const MAX_IP = 64;

/** 同一 IP 每小时最多提交次数 */
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 3600000;
const RATE_LIMIT_CLEAN_MS = 10 * 60000;

export interface ReportInput {
  category?: string;
  content?: string;
  contact?: string;
  targetUrl?: string;
  source?: string;
}

export interface ReportActor {
  userId?: string;
  ip?: string;
  userAgent?: string;
}

function text(value: any): string {
  return typeof value === "string" ? value.trim() : "";
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);
  /** ip -> 提交时间戳数组 */
  private readonly buckets = new Map<string, number[]>();
  private lastClean = 0;

  constructor(private readonly prisma: PrismaService) {}

  /** 允许的分类（给桌面前端/文档用的清单） */
  categories() {
    return CATEGORIES.map((key) => ({ key, label: CATEGORY_LABELS[key] || key }));
  }

  /** 提交一条举报工单 */
  async submit(input: ReportInput, actor: ReportActor = {}) {
    const category = text(input.category).toLowerCase();
    if (!category || !CATEGORIES.includes(category as any)) {
      throw new BadRequestException("请选择举报类别（" + CATEGORIES.join(" / ") + "）");
    }
    const content = text(input.content);
    if (content.length < MIN_CONTENT) {
      throw new BadRequestException("请填写至少 " + MIN_CONTENT + " 个字的举报说明");
    }
    if (content.length > MAX_CONTENT) {
      throw new BadRequestException("举报说明不能超过 " + MAX_CONTENT + " 个字");
    }
    const contact = clip(text(input.contact), MAX_CONTACT);
    const targetUrl = clip(text(input.targetUrl), MAX_URL);
    const source = clip(text(input.source) || "api", 32).replace(/[^a-zA-Z0-9_.-]/g, "") || "api";
    const ip = clip(text(actor.ip), MAX_IP);
    const userAgent = clip(text(actor.userAgent), MAX_UA);
    const userId = text(actor.userId) || null;

    this.limit(ip || userId || "anonymous");

    const created = await this.prisma.reportTicket.create({
      data: { userId, category, content, contact: contact || null, targetUrl: targetUrl || null, source, ip: ip || null, userAgent: userAgent || null },
      select: { id: true, category: true, createdAt: true },
    });

    // 联系方式是可选字段：既支持匿名举报，也支持留邮箱/手机等回访方式
    this.logger.warn("收到举报 " + created.id + " 类别=" + category + " 来源=" + source + (userId ? " 用户=" + userId : " 匿名"));
    return {
      id: created.id,
      category: created.category,
      categoryLabel: CATEGORY_LABELS[category] || category,
      createdAt: created.createdAt,
      message: "已收到你的举报，我们会在 3 个工作日内核实处理；如需回访请留下联系方式。",
    };
  }

  /** 管理端列表（默认只看 open） */
  async list(query: { status?: string; category?: string; limit?: string | number } = {}) {
    const status = text(query.status);
    const category = text(query.category);
    const limitRaw = Number(query.limit);
    const take = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 50;
    const where: any = {};
    if (status && status !== "all") where.status = status;
    if (category && CATEGORIES.includes(category as any)) where.category = category;
    const [rows, total, open] = await Promise.all([
      this.prisma.reportTicket.findMany({ where, orderBy: { createdAt: "desc" }, take }),
      this.prisma.reportTicket.count({ where }),
      this.prisma.reportTicket.count({ where: { status: "open" } }),
    ]);
    return {
      total,
      openCount: open,
      items: rows.map((r) => ({
        ...r,
        categoryLabel: CATEGORY_LABELS[r.category] || r.category,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    };
  }

  /** 管理端处理（resolved / rejected） */
  async resolve(id: string, body: { status?: string; handledBy?: string; handledNote?: string } = {}) {
    const ticketId = text(id);
    if (!ticketId) throw new BadRequestException("缺少工单号");
    const status = text(body.status) === "rejected" ? "rejected" : "resolved";
    const handledNote = clip(text(body.handledNote), 500);
    const existing = await this.prisma.reportTicket.findUnique({ where: { id: ticketId }, select: { id: true } });
    if (!existing) throw new BadRequestException("工单不存在");
    const updated = await this.prisma.reportTicket.update({
      where: { id: ticketId },
      data: { status, handledBy: clip(text(body.handledBy) || "admin", 64), handledNote: handledNote || null },
      select: { id: true, status: true, handledBy: true, handledNote: true, updatedAt: true },
    });
    return { success: true, ticket: updated };
  }

  /** 进程内限流：同一 key 每小时 RATE_LIMIT_MAX 次 */
  private limit(key: string) {
    const now = Date.now();
    if (now - this.lastClean > RATE_LIMIT_CLEAN_MS) {
      this.lastClean = now;
      for (const [k, stamps] of this.buckets) {
        const fresh = stamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
        if (fresh.length) this.buckets.set(k, fresh);
        else this.buckets.delete(k);
      }
    }
    const current = (this.buckets.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (current.length >= RATE_LIMIT_MAX) {
      throw new HttpException("举报提交过于频繁，请稍后再试", HttpStatus.TOO_MANY_REQUESTS);
    }
    current.push(now);
    this.buckets.set(key, current);
  }
}
