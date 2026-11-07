import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { MediaService } from "../media/media.service";
import { resolvePhone } from "../common/owner";

/** 原版契约：compose-videos.service.js 导出的 COMPOSE_VIDEO_TYPES */
export const COMPOSE_VIDEO_TYPES = ["lipsync", "realman_mix", "mixcut", "news"] as const;

const TERMINAL = new Set(["completed", "failed"]);
/** 每次列表请求最多推进 5 条未完成任务，避免拖慢接口 */
const REFRESH_LIMIT = 5;
const UPSTREAM_SUCCESS = new Set(["SUCCESS", "SUCCEEDED", "COMPLETED", "DONE"]);
const UPSTREAM_FAILED = new Set(["FAILED", "ERROR", "CANCELED", "CANCELLED"]);

@Injectable()
export class ComposeVideosService {
  constructor(private readonly prisma: PrismaService, private readonly media: MediaService) {}

  private async scope(user: any) {
    return { phone: await resolvePhone(this.prisma, user), userId: String(user?.id ?? "") };
  }

  /** create：lipsync/realman_mix 先交给媒体服务做音色克隆+对口型；mixcut/news 直接走智能混剪 */
  async create(user: any, dto: any) {
    const { phone, userId } = await this.scope(user);
    const composeType = String(dto?.composeType || "lipsync");
    if (!(COMPOSE_VIDEO_TYPES as readonly string[]).includes(composeType)) {
      throw new BadRequestException("composeType 不合法");
    }

    let status = composeType === "mixcut" || composeType === "news" ? "composing" : "cloning_audio";
    let musetalkTaskId: string | null = null;
    let smartClipTaskId: string | null = null;

    if (composeType === "lipsync" || composeType === "realman_mix") {
      const image = dto?.videoUrl || dto?.imageUrl || dto?.image || dto?.characterImage;
      const audio = dto?.sourceAudioUrl || dto?.audioUrl || dto?.audio || dto?.voiceFile;
      if (!image) throw new BadRequestException("缺少人像素材（videoUrl / imageUrl）");
      if (!audio) throw new BadRequestException("缺少音频素材（sourceAudioUrl / audioUrl）");
      const submitted = await this.media.submit(userId, "lipsync", {
        image,
        audio,
        seconds: dto?.seconds ?? dto?.inputSeconds,
        start: dto?.start,
        prompt: dto?.prompt,
        resolution: dto?.resolution,
        fps: dto?.fps,
      });
      musetalkTaskId = submitted.taskId;
      status = "cloning_audio";
    } else {
      const mode = composeType === "mixcut" ? "broadcast_mixcut" : "news_mixcut";
      // nodeInfoList 可直接透传；否则由 image/prompt/seconds 自动构造（节点号见 RUNNINGHUB_NODE_CLIP_*）
      const submitted = await this.media.submit(userId, "smart_clip", { ...dto, mode });
      smartClipTaskId = submitted.taskId;
      status = "composing";
    }

    return this.prisma.composeVideo.create({
      data: {
        phone,
        composeType,
        status,
        videoUrl: dto?.videoUrl ?? dto?.imageUrl ?? null,
        sourceAudioUrl: dto?.sourceAudioUrl ?? dto?.audioUrl ?? null,
        styleId: dto?.styleId ?? null,
        styleName: dto?.styleName ?? null,
        title: dto?.title ?? null,
        materials: dto?.materials ?? null,
        cloneAudioUrl: dto?.cloneAudioUrl ?? null,
        text: dto?.text ?? null,
        cloneTaskId: dto?.cloneTaskId ?? null,
        sceneTaskId: dto?.sceneTaskId ?? null,
        musetalkTaskId,
        smartClipTaskId,
      },
    });
  }

  async query(user: any, q: any) {
    const { phone, userId } = await this.scope(user);
    const rows = await this.prisma.composeVideo.findMany({
      where: {
        phone,
        ...(q?.status ? { status: String(q.status) } : {}),
        ...(q?.composeType ? { composeType: String(q.composeType) } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const pending = rows.filter((r) => !TERMINAL.has(r.status)).slice(0, REFRESH_LIMIT);
    if (pending.length === 0) return rows;
    const advanced = await Promise.all(pending.map((r) => this.refresh(userId, r).catch(() => r)));
    const byId = new Map(advanced.map((r) => [r.id, r]));
    return rows.map((r) => byId.get(r.id) ?? r);
  }

  /** 用上游任务状态推进本地状态机：cloning_audio → composing → completed | failed */
  private async refresh(userId: string, row: any) {
    const taskId = row.musetalkTaskId || row.smartClipTaskId;
    if (!taskId) return row;
    const task: any = await this.media.getTask(userId, taskId);
    const upstream = String(task?.status ?? "").toUpperCase();
    let status = row.status;
    if (UPSTREAM_SUCCESS.has(upstream)) status = "completed";
    else if (UPSTREAM_FAILED.has(upstream)) status = "failed";
    else if (row.status === "cloning_audio") status = "composing";
    const resultUrl = task?.resultUrl || row.resultUrl;
    if (status === row.status && resultUrl === row.resultUrl) return row;
    const data: any = { status };
    if (resultUrl) {
      data.resultUrl = resultUrl;
      // 原版契约：成片地址写在 videoUrl（前端也是读这个字段），resultUrl 是上游原始结果
      if (!row.videoUrl) data.videoUrl = resultUrl;
    }
    return this.prisma.composeVideo.update({ where: { id: row.id }, data });
  }

  private async own(user: any, id: string) {
    const { phone } = await this.scope(user);
    const row = await this.prisma.composeVideo.findFirst({ where: { id, phone } });
    if (!row) throw new NotFoundException("视频不存在");
    return row;
  }

  async update(user: any, id: string, body: any) {
    await this.own(user, id);
    const { phone, id: _ignore, createdAt, updatedAt, ...rest } = body ?? {};
    return this.prisma.composeVideo.update({ where: { id }, data: rest });
  }

  async remove(user: any, id: string) {
    await this.own(user, id);
    await this.prisma.composeVideo.delete({ where: { id } });
    return { success: true };
  }

  /** transfer-oss：把上游临时结果转存到 OSS（沿用媒体服务已有的转存实现） */
  async transfer(user: any, id: string) {
    const { userId } = await this.scope(user);
    let row = await this.own(user, id);
    if (!row.resultUrl) {
      row = await this.refresh(userId, row).catch(() => row);
    }
    if (!row.resultUrl) throw new BadRequestException("任务尚无结果，无法转存");
    const sourceUrl = String(row.resultUrl);
    const alreadyHosted = /(^|\.)aliyuncs\.com$/i.test(new URL(sourceUrl).hostname);
    if (alreadyHosted) {
      return this.prisma.composeVideo.update({ where: { id }, data: { status: "completed" } });
    }
    const transferred: any = await this.media.ossTransfer(userId, {
      sourceUrl,
      taskId: row.musetalkTaskId || row.smartClipTaskId || row.id,
      extension: "mp4",
    });
    return this.prisma.composeVideo.update({
      where: { id },
      data: { resultUrl: transferred?.url || sourceUrl, status: "completed" },
    });
  }

  /** musetalk-callback：上游回调推进状态，按 taskId 幂等 */
  async callback(body: any) {
    const taskId = String(body?.taskId ?? body?.musetalkTaskId ?? body?.smartClipTaskId ?? "");
    if (!taskId) throw new BadRequestException("taskId 必填");
    const row = await this.prisma.composeVideo.findFirst({
      where: { OR: [{ musetalkTaskId: taskId }, { smartClipTaskId: taskId }] },
    });
    if (!row) throw new NotFoundException("任务不存在");
    const rawStatus = String(body?.status ?? "").toUpperCase();
    const status = UPSTREAM_SUCCESS.has(rawStatus) ? "completed" : UPSTREAM_FAILED.has(rawStatus) ? "failed" : row.status;
    const resultUrl = body?.resultUrl || body?.url || row.resultUrl;
    return this.prisma.composeVideo.update({
      where: { id: row.id },
      data: { status, ...(resultUrl ? { resultUrl: String(resultUrl) } : {}) },
    });
  }
}
