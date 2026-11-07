import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { MediaService } from "../media/media.service";
import { resolvePhone } from "../common/owner";

const UPSTREAM_SUCCESS = new Set(["SUCCESS", "SUCCEEDED", "COMPLETED", "DONE"]);
const UPSTREAM_FAILED = new Set(["FAILED", "ERROR", "CANCELED", "CANCELLED"]);
const REFRESH_LIMIT = 5;

@Injectable()
export class CloneRecordsService {
  constructor(private readonly prisma: PrismaService, private readonly media: MediaService) {}

  private async scope(user: any) {
    return { phone: await resolvePhone(this.prisma, user), userId: String(user?.id ?? "") };
  }

  /** 克隆音色：交给媒体服务的 indextts 应用，成功后轮询取回音色文件 */
  async create(user: any, body: any) {
    const { phone, userId } = await this.scope(user);
    const sourceUrl = body?.sourceUrl || body?.audioUrl || body?.audio;
    if (!sourceUrl) throw new BadRequestException("缺少音频样本（sourceUrl）");
    const submitted = await this.media.submit(userId, "indextts", {
      audio: sourceUrl,
      audioUrl: sourceUrl,
      text: body?.text,
      nodeInfoList: body?.nodeInfoList,
    });
    return this.prisma.cloneRecord.create({
      data: {
        phone,
        type: String(body?.type || "voice"),
        sourceUrl: String(sourceUrl),
        taskId: submitted.taskId,
        status: "polling",
        text: body?.text ?? null,
      },
    });
  }

  async list(user: any, q: any) {
    const { phone, userId } = await this.scope(user);
    const rows = await this.prisma.cloneRecord.findMany({
      where: { phone, ...(q?.status ? { status: String(q.status) } : {}), ...(q?.type ? { type: String(q.type) } : {}) },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const pending = rows.filter((r) => r.status === "polling" && r.taskId).slice(0, REFRESH_LIMIT);
    if (pending.length === 0) return rows;
    const advanced = await Promise.all(pending.map((r) => this.refresh(userId, r).catch(() => r)));
    const byId = new Map(advanced.map((r) => [r.id, r]));
    return rows.map((r) => byId.get(r.id) ?? r);
  }

  private async refresh(userId: string, row: any) {
    const task: any = await this.media.getTask(userId, row.taskId);
    const upstream = String(task?.status ?? "").toUpperCase();
    const status = UPSTREAM_SUCCESS.has(upstream) ? "completed" : UPSTREAM_FAILED.has(upstream) ? "failed" : "polling";
    const resultUrl = task?.resultUrl || row.resultUrl;
    if (status === row.status && resultUrl === row.resultUrl) return row;
    return this.prisma.cloneRecord.update({
      where: { id: row.id },
      data: { status, ...(resultUrl ? { resultUrl: String(resultUrl) } : {}) },
    });
  }

  private async own(user: any, id: string) {
    const { phone } = await this.scope(user);
    const row = await this.prisma.cloneRecord.findFirst({ where: { id, phone } });
    if (!row) throw new NotFoundException("克隆记录不存在");
    return row;
  }

  async update(user: any, id: string, body: any) {
    await this.own(user, id);
    const { phone, id: _ignore, taskId, sourceUrl, createdAt, updatedAt, ...rest } = body ?? {};
    return this.prisma.cloneRecord.update({ where: { id }, data: rest });
  }

  async remove(user: any, id: string) {
    await this.own(user, id);
    await this.prisma.cloneRecord.delete({ where: { id } });
    return { success: true };
  }
}
