import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * 对话持久化（P43 域 C P0-2）：桌面端「会话列表 / 历史会话」的服务端存储。
 *
 * 归属键是登录用户 id，所有查询都带 userId，越权一律当作不存在（404）。
 * 说明：ChatSession / ChatMessage 是本次新增的表，lead 跑 migrate + generate 前
 * Prisma Client 里还没有对应类型，故沿用本仓库既有写法 `(this.prisma as any)` 访问。
 */

const DEFAULT_TITLE = "新对话";
const MAX_TITLE = 200;
const AUTO_TITLE = 30;
const MAX_MODEL = 120;
const MAX_CONTENT = 100000;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const PREVIEW_LEN = 60;
const ROLES = ["user", "assistant", "system"];

function userIdOf(user: any): string {
  const id = user && typeof user.id === "string" ? user.id.trim() : "";
  if (!id) throw new BadRequestException("未登录");
  return id;
}

function iso(value: any): any {
  return value instanceof Date ? value.toISOString() : value;
}

/** 会话对外形状（列表接口另外拼 messageCount / preview） */
function sessionShape(row: any) {
  return {
    id: row.id,
    title: row.title,
    model: row.model ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function messageShape(row: any) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    tokensIn: row.tokensIn ?? null,
    tokensOut: row.tokensOut ?? null,
    isError: row.isError === true,
    createdAt: iso(row.createdAt),
  };
}

function clampLimit(raw: any): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_LIMIT;
  const num = Number(raw);
  if (!Number.isFinite(num)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(num), 1), MAX_LIMIT);
}

/** 标题：去空白；空串时 fallback 为 null 则报错，否则回落默认值；超 200 截断 */
function normalizeTitle(raw: any, fallback: string | null): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) {
    if (fallback === null) throw new BadRequestException("会话标题不能为空");
    return fallback;
  }
  return text.slice(0, MAX_TITLE);
}

function normalizeModel(raw: any): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  return text ? text.slice(0, MAX_MODEL) : null;
}

function toInt(raw: any): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.trunc(num);
}

function cleanId(raw: any): string {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) throw new NotFoundException("会话不存在或不属于你");
  return id;
}

@Injectable()
export class ChatService {
  constructor(private readonly prisma: PrismaService) {}

  /** 会话列表：updatedAt desc，附消息条数与最后一条非空正文的前 60 字 */
  async list(user: any, limitRaw: any) {
    const userId = userIdOf(user);
    const limit = clampLimit(limitRaw);
    const p: any = this.prisma;

    const rows = await p.chatSession.findMany({
      where: { userId },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit,
    });
    const ids: string[] = rows.map((row: any) => row.id);
    if (!ids.length) return { items: [] };

    const [countRows, previewRows] = await Promise.all([
      p.chatMessage.groupBy({
        by: ["sessionId"],
        where: { sessionId: { in: ids } },
        _count: { _all: true },
      }),
      Promise.all(
        ids.map((id: string) =>
          p.chatMessage.findFirst({
            where: { sessionId: id, content: { not: "" } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { content: true },
          }),
        ),
      ),
    ]);

    const counts = new Map<string, number>();
    for (const group of countRows || []) {
      if (!group || !group.sessionId) continue;
      const rawCount = group._count;
      const value = rawCount && typeof rawCount === "object" ? rawCount._all : rawCount;
      counts.set(group.sessionId, Number(value) || 0);
    }

    return {
      items: rows.map((row: any, index: number) => {
        const content = previewRows[index]?.content;
        return {
          id: row.id,
          title: row.title,
          model: row.model ?? null,
          updatedAt: iso(row.updatedAt),
          messageCount: counts.get(row.id) || 0,
          preview: typeof content === "string" ? content.trim().slice(0, PREVIEW_LEN) : "",
        };
      }),
    };
  }

  /** 新建会话；title 缺省「新对话」，model 可空 */
  async create(user: any, body: any = {}) {
    const userId = userIdOf(user);
    const title = normalizeTitle(body?.title, DEFAULT_TITLE);
    const model = normalizeModel(body?.model);
    const row = await (this.prisma as any).chatSession.create({ data: { userId, title, model } });
    return { session: sessionShape(row) };
  }

  /** 会话详情：session + messages（createdAt asc） */
  async detail(user: any, id: string) {
    const userId = userIdOf(user);
    const sessionId = cleanId(id);
    const p: any = this.prisma;

    const session = await p.chatSession.findFirst({ where: { id: sessionId, userId } });
    if (!session) throw new NotFoundException("会话不存在或不属于你");
    const messages = await p.chatMessage.findMany({
      where: { sessionId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return { session: sessionShape(session), messages: messages.map(messageShape) };
  }

  /** 只允许改 title / model；显式传空标题报「会话标题不能为空」 */
  async update(user: any, id: string, body: any = {}) {
    const userId = userIdOf(user);
    const sessionId = cleanId(id);
    const p: any = this.prisma;

    const found = await p.chatSession.findFirst({ where: { id: sessionId, userId } });
    if (!found) throw new NotFoundException("会话不存在或不属于你");

    const payload: any = body || {};
    const data: any = {};
    if (Object.prototype.hasOwnProperty.call(payload, "title")) data.title = normalizeTitle(payload.title, null);
    if (Object.prototype.hasOwnProperty.call(payload, "model")) data.model = normalizeModel(payload.model);
    if (!Object.keys(data).length) return { session: sessionShape(found) };

    const row = await p.chatSession.update({ where: { id: sessionId }, data });
    return { session: sessionShape(row) };
  }

  /** 删除会话，messages 一并删（事务） */
  async remove(user: any, id: string) {
    const userId = userIdOf(user);
    const sessionId = cleanId(id);
    const p: any = this.prisma;

    const found = await p.chatSession.findFirst({ where: { id: sessionId, userId } });
    if (!found) throw new NotFoundException("会话不存在或不属于你");

    await p.$transaction(async (tx: any) => {
      await tx.chatMessage.deleteMany({ where: { sessionId } });
      await tx.chatSession.delete({ where: { id: sessionId } });
    });
    return { ok: true };
  }

  /**
   * 批量追加消息。校验全部通过后再落库，避免半批写入；
   * 追加后 touch 会话 updatedAt；会话仍叫「新对话」且这是首条 user 消息时，
   * 用该消息前 30 字自动重命名。
   */
  async append(user: any, id: string, body: any = {}) {
    const userId = userIdOf(user);
    const sessionId = cleanId(id);
    const p: any = this.prisma;

    const session = await p.chatSession.findFirst({ where: { id: sessionId, userId } });
    if (!session) throw new NotFoundException("会话不存在或不属于你");

    const rawMessages = body?.messages;
    if (rawMessages !== undefined && rawMessages !== null && !Array.isArray(rawMessages)) {
      throw new BadRequestException("messages 必须是数组");
    }
    const list: any[] = Array.isArray(rawMessages) ? rawMessages : [];

    const rows = list.map((item: any) => {
      const role = typeof item?.role === "string" ? item.role.trim() : "";
      if (!ROLES.includes(role)) throw new BadRequestException("消息角色不合法");
      const rawContent = item?.content;
      const content = (typeof rawContent === "string" ? rawContent : String(rawContent ?? "")).slice(0, MAX_CONTENT);
      return {
        sessionId,
        role,
        content,
        tokensIn: toInt(item?.tokensIn),
        tokensOut: toInt(item?.tokensOut),
        isError: item?.isError === true,
      };
    });
    if (!rows.length) return { ok: true, appended: 0 };

    const firstUser = rows.find((row: any) => row.role === "user" && row.content.trim());
    const appended = await p.$transaction(async (tx: any) => {
      let title: string | undefined;
      if (session.title === DEFAULT_TITLE && firstUser) {
        const prior = await tx.chatMessage.count({ where: { sessionId, role: "user" } });
        if (prior === 0) title = firstUser.content.trim().slice(0, AUTO_TITLE);
      }
      const created = await tx.chatMessage.createMany({ data: rows });
      const sessionData: any = { updatedAt: new Date() };
      if (title) sessionData.title = title;
      await tx.chatSession.update({ where: { id: sessionId }, data: sessionData });
      return Number(created?.count ?? rows.length);
    });

    return { ok: true, appended };
  }
}
