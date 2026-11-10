import { BadGatewayException, BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import OSS from "ali-oss";
import { CreditsService } from "../billing/credits.service";
import { PrismaService } from "../prisma/prisma.service";
import { env } from "../common/env";

class ProviderRejectedError extends BadGatewayException {}

@Injectable()
export class MediaService {
  constructor(private readonly prisma: PrismaService, private readonly credits: CreditsService) {}

  private async provider(path: string, body: unknown) {
    const base = env("RUNNINGHUB_BASE_URL", "https://www.runninghub.ai").replace(/\/$/, "");
    const key = env("RUNNINGHUB_API_KEY", "");
    if (!base || !key) throw new ProviderRejectedError("媒体服务未配置");
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new BadGatewayException("媒体服务请求失败");
    const payload = await response.json() as Record<string, unknown>;
    if (typeof payload.code === "number" && payload.code !== 0) throw new ProviderRejectedError(String(payload.msg ?? "媒体服务请求失败"));
    return payload;
  }

  private async providerQuery(taskId: string) {
    const base = env("RUNNINGHUB_BASE_URL", "https://www.runninghub.ai").replace(/\/$/, "");
    const key = env("RUNNINGHUB_API_KEY", "");
    if (!base || !key) return null;
    const response = await fetch(`${base}/openapi/v2/query`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ taskId }),
    });
    if (!response.ok) return null;
    return response.json() as Promise<Record<string, unknown>>;
  }

  private async price(taskType: string, inputSeconds?: number) {
    const pricing = await this.prisma.mediaPricing.findUnique({ where: { taskType } });
    if (!pricing || !pricing.isActive) throw new BadRequestException("媒体任务类型未配置");
    if (pricing.pricingMode !== "per_input_second") return Math.max(1, pricing.pricePerRequest);
    const seconds = Number(inputSeconds);
    const basis = Number.isFinite(seconds) && seconds > 0 ? seconds : pricing.defaultEstimatedSeconds;
    const amount = Math.ceil(basis * pricing.pricePerInputSecond);
    if (!Number.isFinite(amount) || amount < 1) throw new BadRequestException("媒体任务计费参数无效");
    return Math.max(1, amount);
  }

  private apiId(taskType: string) {
    const envKey: Record<string, string> = {
      indextts: "RUNNINGHUB_API_ID_INDEXTTS",
      lipsync: "RUNNINGHUB_API_ID_LIPSYNC",
      smart_clip: "RUNNINGHUB_API_ID_SMART_CLIP",
      image_gen: "RUNNINGHUB_API_ID_IMAGE",
      video_gen: "RUNNINGHUB_API_ID_VIDEO",
    };
    const configured = envKey[taskType] ? env(envKey[taskType], "") : "";
    if (configured) return configured;
    if (taskType === "lipsync") return env("RUNNINGHUB_API_ID", "2031016553440878594");
    throw new BadRequestException(`媒体任务 ${taskType} 尚未配置 RunningHub API ID`);
  }

  /** 画幅 -> 图生视频工作流的 select 下标（0:1:1 1:4:3 2:3:4 3:16:9 4:9:16） */
  private aspectIndex(value: unknown) {
    if (typeof value === "number") return value;
    const table: Record<string, number> = { "1:1": 0, "4:3": 1, "3:4": 2, "16:9": 3, "9:16": 4 };
    const key = String(value || "").trim();
    if (key && table[key] !== undefined) return table[key];
    return Number(env("RUNNINGHUB_NODE_VID_ASPECT_DEFAULT", "4"));
  }

  /** 把业务字段翻译成 RunningHub 的 nodeInfoList（节点号可用环境变量覆盖） */
  private buildNodeInfoList(taskType: string, body: any) {
    if (Array.isArray(body?.nodeInfoList) && body.nodeInfoList.length) return body.nodeInfoList;
    const validRef = (value: unknown) => {
      const s = String(value || "");
      return /^https?:\/\//i.test(s) || /^data:[^;]+;base64,/i.test(s) || s.startsWith("openapi/");
    };

    // 音色克隆（indextts）：13 = 被模仿音频，15 = 情感参考音频，14 = 要合成的文本
    if (taskType === "indextts") {
      const audio = body?.audio || body?.audioUrl || body?.sourceUrl || body?.voiceFile;
      const emotion = body?.emotionAudio || body?.emotionUrl || audio;
      const text = String(body?.text || body?.content || "").trim();
      if (!audio) throw new BadRequestException("缺少音频样本（audio / sourceUrl）");
      if (!validRef(audio)) throw new BadRequestException("音频素材引用无效");
      if (!text) throw new BadRequestException("缺少要合成的文本（text）");
      const node = {
        audio: env("RUNNINGHUB_NODE_TTS_AUDIO", "13"),
        emotion: env("RUNNINGHUB_NODE_TTS_EMOTION", "15"),
        text: env("RUNNINGHUB_NODE_TTS_TEXT", "14"),
      };
      return [
        { nodeId: node.audio, fieldName: "audio", fieldValue: String(audio), description: "Need to imitate the sound (mainly)" },
        { nodeId: node.emotion, fieldName: "audio", fieldValue: String(emotion), description: "Emotional tone to be imitated (secondary)" },
        { nodeId: node.text, fieldName: "value", fieldValue: text, description: "Input mimicked text" },
      ];
    }

    // 混剪（smart_clip）：114 = 参考图，224 = 提示词，115 = 画幅 + 像素，135 = 时长
    if (taskType === "smart_clip") {
      const image = body?.image || body?.imageUrl || body?.coverImage || body?.videoUrl;
      const prompt = String(body?.prompt || body?.text || "").trim();
      if (!image) throw new BadRequestException("缺少人像/参考图（image）参数");
      if (!prompt) throw new BadRequestException("缺少混剪提示词（prompt）");
      if (!validRef(image)) throw new BadRequestException("人像素材引用无效");
      const node = {
        image: env("RUNNINGHUB_NODE_CLIP_IMAGE", "114"),
        prompt: env("RUNNINGHUB_NODE_CLIP_PROMPT", "224"),
        aspect: env("RUNNINGHUB_NODE_CLIP_ASPECT", "115"),
        seconds: env("RUNNINGHUB_NODE_CLIP_SECONDS", "135"),
      };
      return [
        { nodeId: node.image, fieldName: "image", fieldValue: String(image), description: "Reference portrait" },
        { nodeId: node.prompt, fieldName: "value", fieldValue: prompt, description: "Mixcut prompt" },
        { nodeId: node.aspect, fieldName: "aspect_ratio", fieldValue: String(body?.aspectRatio || "16:9 (Widescreen)"), description: "Output aspect ratio" },
        { nodeId: node.aspect, fieldName: "megapixels", fieldValue: String(body?.megapixels ?? 0.9), description: "Output megapixels" },
        { nodeId: node.seconds, fieldName: "value", fieldValue: String(body?.seconds ?? 15), description: "Duration seconds" },
      ];
    }

    // 文生图（image_gen）：6 = 提示词，625 = 尺寸档位
    if (taskType === "image_gen") {
      const prompt = String(body?.prompt || body?.text || body?.content || "").trim();
      if (!prompt) throw new BadRequestException("缺少图片提示词（prompt）");
      const node = {
        prompt: env("RUNNINGHUB_NODE_IMG_PROMPT", "6"),
        size: env("RUNNINGHUB_NODE_IMG_SIZE", "625"),
      };
      return [
        { nodeId: node.prompt, fieldName: "text", fieldValue: prompt, description: "Please enter your prompt" },
        { nodeId: node.size, fieldName: "value", fieldValue: String(body?.size ?? body?.sizeIndex ?? 7), description: "Image generation size option" },
      ];
    }

    // 图生视频（video_gen）：135 = 首帧图，107 = 时长，153 = 高清/速度，113 = 设置比例，247 = 画幅，272 = 文本输入方式，116 = 提示词
    if (taskType === "video_gen") {
      const image = body?.image || body?.imageUrl || body?.coverImage;
      let prompt = String(body?.prompt || body?.text || "").trim();
      if (!image) throw new BadRequestException("缺少首帧图（image）参数");
      if (!validRef(image)) throw new BadRequestException("首帧图引用无效");
      if (!prompt) prompt = env("RUNNINGHUB_VIDEO_DEFAULT_PROMPT", "Time-lapse photography");
      const node = {
        image: env("RUNNINGHUB_NODE_VID_IMAGE", "135"),
        seconds: env("RUNNINGHUB_NODE_VID_SECONDS", "107"),
        version: env("RUNNINGHUB_NODE_VID_VERSION", "153"),
        ratio: env("RUNNINGHUB_NODE_VID_RATIO", "113"),
        aspect: env("RUNNINGHUB_NODE_VID_ASPECT", "247"),
        textMode: env("RUNNINGHUB_NODE_VID_TEXTMODE", "272"),
        prompt: env("RUNNINGHUB_NODE_VID_PROMPT", "116"),
      };
      const aspectIndex = this.aspectIndex(body?.aspectRatio);
      return [
        { nodeId: node.image, fieldName: "image", fieldValue: String(image), description: "Upload Image" },
        { nodeId: node.seconds, fieldName: "value", fieldValue: String(body?.seconds ?? 5), description: "Set duration (seconds)" },
        { nodeId: node.version, fieldName: "select", fieldValue: String(body?.version ?? 2), description: "HD/Speed version switching" },
        { nodeId: node.ratio, fieldName: "select", fieldValue: String(body?.ratioSetting ?? 2), description: "Setting the ratio" },
        { nodeId: node.aspect, fieldName: "select", fieldValue: String(aspectIndex), description: "Set the aspect ratio" },
        { nodeId: node.textMode, fieldName: "index", fieldValue: String(body?.textMode ?? 2), description: "Text input method" },
        { nodeId: node.prompt, fieldName: "text", fieldValue: prompt, description: "Handwritten/polished text" },
      ];
    }

    if (taskType !== "lipsync") throw new BadRequestException("缺少 nodeInfoList");
    const image = body?.image || body?.imageUrl || body?.characterImage;
    const audio = body?.audio || body?.audioUrl || body?.voiceFile;
    if (!image) throw new BadRequestException("缺少人像（image）参数");
    if (!audio) throw new BadRequestException("缺少音频（audio）参数");
    if (!validRef(image)) throw new BadRequestException("人像素材引用无效");
    if (!validRef(audio)) throw new BadRequestException("音频素材引用无效");
    const node = {
      image: env("RUNNINGHUB_NODE_IMAGE", "444"),
      audio: env("RUNNINGHUB_NODE_AUDIO", "1755"),
      seconds: env("RUNNINGHUB_NODE_SECONDS", "1583"),
      start: env("RUNNINGHUB_NODE_START", "1776"),
      prompt: env("RUNNINGHUB_NODE_PROMPT", "1624"),
      resolution: env("RUNNINGHUB_NODE_RESOLUTION", "1606"),
      fps: env("RUNNINGHUB_NODE_FPS", "1586"),
    };
    const seconds = String(body?.seconds ?? body?.inputSeconds ?? 10);
    return [
      { nodeId: node.image, fieldName: "image", fieldValue: String(image), description: "Character image" },
      { nodeId: node.audio, fieldName: "audio", fieldValue: String(audio), description: "Upload song or audio" },
      { nodeId: node.seconds, fieldName: "value", fieldValue: seconds, description: "Generate seconds (0 = whole audio)" },
      { nodeId: node.start, fieldName: "value", fieldValue: String(body?.start ?? 0), description: "Audio start offset seconds" },
      { nodeId: node.prompt, fieldName: "value", fieldValue: String(body?.prompt || "角色面向镜头深情的说话，固定镜头。"), description: "Action prompt" },
      { nodeId: node.resolution, fieldName: "value", fieldValue: String(body?.resolution ?? 1280), description: "Max resolution (<1600)" },
      { nodeId: node.fps, fieldName: "value", fieldValue: String(body?.fps ?? 25), description: "Frame rate" },
    ];
  }

  /** 上传本地/Base64 素材到 RunningHub，返回可用于 nodeInfoList 的 fileName */
  async upload(userId: string, body: any) {
    const base64 = String(body?.base64 || body?.data || "").replace(/^data:[^;]+;base64,/, "");
    if (!base64) throw new BadRequestException("缺少 base64 文件内容");
    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length) throw new BadRequestException("文件内容为空");
    if (buffer.length > 60 * 1024 * 1024) throw new BadRequestException("文件超过 60MB");
    const name = String(body?.fileName || body?.name || "upload.bin");
    const mime = String(body?.mime || "application/octet-stream");
    const base = env("RUNNINGHUB_BASE_URL", "https://www.runninghub.ai").replace(/\/$/, "");
    const key = env("RUNNINGHUB_API_KEY", "");
    if (!key) throw new BadGatewayException("媒体服务未配置");
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mime }), name);
    const response = await fetch(base + "/openapi/v2/media/upload/binary", {
      method: "POST",
      headers: { authorization: "Bearer " + key },
      body: form as any,
      signal: AbortSignal.timeout(120000),
    });
    const payload = (await response.json().catch(() => ({}))) as any;
    if (!response.ok || (typeof payload?.code === "number" && payload.code !== 0)) {
      throw new BadGatewayException(String(payload?.message || "素材上传失败"));
    }
    return { userId, fileName: payload?.data?.fileName, url: payload?.data?.download_url, type: payload?.data?.type, size: payload?.data?.size };
  }

  private settleFields(upstream: any) {
    const status = typeof upstream?.status === "string" ? upstream.status : null;
    const resultUrl = Array.isArray(upstream?.results) && upstream.results[0]?.url ? String(upstream.results[0].url) : null;
    return {
      providerStatus: status,
      resultUrl,
      resultMeta: upstream ?? undefined,
      settledAt: status && ["SUCCESS", "FAILED"].includes(status) ? new Date() : null,
    };
  }

  /** OSS 客户端：四项 env 齐全才返回，否则 null（走本地磁盘兜底）。 */
  private ossClient() {
    const accessKeyId = env("OSS_ACCESS_KEY_ID", "");
    const accessKeySecret = env("OSS_ACCESS_KEY_SECRET", "");
    const bucket = env("OSS_BUCKET", "");
    const region = env("OSS_REGION", "");
    const endpoint = env("OSS_ENDPOINT", "");
    if (!accessKeyId || !accessKeySecret || !bucket || !region || !endpoint) return null;
    return new OSS({ region, accessKeyId, accessKeySecret, bucket, endpoint, secure: true });
  }

  /**
   * 上游结果 URL 只有 24 小时有效，SUCCESS 时落一份：
   * OSS 配置齐全 → 优先 OSS（media/auto/<taskId>.<ext>）；
   * 否则 → 本机 uploads/media/ 并用 PUBLIC_BASE_URL 对外。
   * 失败不影响主流程，只保留原始 URL。
   */
  private async archiveResult(taskId: string, url: string | null) {
    if (!url || !/^https?:\/\//i.test(url)) return null;
    if (env("ARCHIVE_MEDIA_RESULTS", "true") === "false") return null;
    const publicBase = env("PUBLIC_BASE_URL", "").replace(/\/$/, "");
    if (publicBase && url.startsWith(publicBase + "/")) return null;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
      if (!response.ok) return null;
      const length = Number(response.headers.get("content-length") || 0);
      if (length > 300 * 1024 * 1024) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) return null;
      const rawExt = (url.split(/[?#]/)[0].split(".").pop() || "mp4").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "mp4";
      const client = this.ossClient();
      if (client) {
        try {
          const objectKey = `media/auto/${taskId}.${rawExt}`;
          const result = await client.put(objectKey, buffer, { headers: { "Content-Type": response.headers.get("content-type") || "application/octet-stream", "Content-Disposition": "inline" } });
          return { url: result.url || null, bytes: buffer.length, sourceUrl: url };
        } catch (ossError) {
          console.error("[media] OSS archive failed, fallback to local:", ossError instanceof Error ? ossError.message : ossError);
        }
      }
      const dir = join(process.cwd(), "uploads", "media");
      await mkdir(dir, { recursive: true });
      const file = `${taskId}.${rawExt}`;
      await writeFile(join(dir, file), buffer);
      return { url: `${publicBase}/uploads/media/${file}`, bytes: buffer.length, sourceUrl: url };
    } catch {
      return null;
    }
  }

  async submit(userId: string, taskType: string, body: any) {
    if (Array.isArray(body?.nodeInfoList) && body.nodeInfoList.length) throw new BadRequestException("暂不支持自定义工作流节点，请使用可确认时长的标准接口");
    if (body?.inputSeconds != null && body?.seconds != null && Number(body.inputSeconds) !== Number(body.seconds)) throw new BadRequestException("媒体时长参数不一致");
    const inputSeconds = Number(body?.inputSeconds ?? body?.seconds ?? (taskType === "video_gen" ? 5 : taskType === "smart_clip" ? 15 : taskType === "lipsync" ? 10 : 0));
    const nodeInfoList = this.buildNodeInfoList(taskType, { ...body, seconds: inputSeconds });
    if (!Number.isFinite(inputSeconds) || inputSeconds < 0 || (!["image_gen", "indextts"].includes(taskType) && inputSeconds === 0)) throw new BadRequestException("请提供大于零且可确认的媒体时长");
    const estimatedAmount = await this.price(taskType, inputSeconds);
    const limit = (key: string, fallback: number) => {
      const value = Number(env(key, String(fallback)));
      if (!Number.isSafeInteger(value) || value < 1) throw new BadRequestException(`媒体限额配置无效：${key}`);
      return value;
    };
    const daily = limit("MEDIA_DAILY_LIMIT", 50);
    const seconds = limit("MEDIA_DAILY_SECONDS_LIMIT", 600);
    const concurrent = limit("MEDIA_CONCURRENT_LIMIT", 3);
    const start = new Date(Math.floor((Date.now() + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000);
    const reservationId = `reservation-${randomUUID()}`;
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM User WHERE id = ${userId} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId }, select: { credits: true } });
      if (!user) throw new NotFoundException("用户不存在");
      const [used, active] = await Promise.all([
        tx.mediaTaskRecord.aggregate({ where: { userId, createdAt: { gte: start } }, _count: true, _sum: { inputSeconds: true } }),
        tx.mediaTaskRecord.count({ where: { userId, status: { in: ["QUEUED", "RUNNING", "SUBMITTING", "REVIEW"] } } }),
      ]);
      if (used._count >= daily) throw new BadRequestException(`今日媒体生成次数已达上限（${daily} 次）`);
      if ((used._sum.inputSeconds || 0) + inputSeconds > seconds) throw new BadRequestException(`今日媒体生成时长已达上限（${seconds} 秒）`);
      if (active >= concurrent) throw new BadRequestException(`同时进行的媒体任务已达上限（${concurrent} 个）`);
      if (user.credits < estimatedAmount) throw new HttpException("算力不足，请充值", HttpStatus.PAYMENT_REQUIRED);
      await tx.user.update({ where: { id: userId }, data: { credits: { decrement: estimatedAmount }, totalCreditsConsumed: { increment: estimatedAmount } } });
      await tx.creditTransaction.create({ data: { userId, type: "consume", amount: -estimatedAmount, balanceBefore: user.credits, balanceAfter: user.credits - estimatedAmount, description: `媒体任务：${taskType}（${reservationId}）` } });
      await tx.mediaTaskRecord.create({ data: { taskId: reservationId, userId, taskType, estimatedAmount, status: "SUBMITTING", inputSeconds } });
    });
    let upstreamAccepted = false;
    try {
      const apiId = this.apiId(taskType);
      const webhookUrl = env("RUNNINGHUB_WEBHOOK_URL", "");
      const payload = { ...body, nodeInfoList, ...(webhookUrl ? { webhookUrl } : {}) };
      delete (payload as any).imageUrl;
      delete (payload as any).audioUrl;
      delete (payload as any).characterImage;
      delete (payload as any).voiceFile;
      const upstream = await this.provider(`/openapi/v2/run/ai-app/${encodeURIComponent(apiId)}`, payload);
      if (upstream.errorCode || (typeof upstream.code === "number" && upstream.code !== 0)) {
        throw new ProviderRejectedError(String(upstream.errorMessage ?? upstream.msg ?? "媒体任务提交失败"));
      }
      const upstreamTaskId = typeof upstream.taskId === "string" && upstream.taskId ? upstream.taskId : null;
      if (!upstreamTaskId) throw new BadGatewayException("媒体服务未返回 taskId");
      upstreamAccepted = true;
      const updated = await this.prisma.mediaTaskRecord.updateMany({ where: { taskId: reservationId, status: "SUBMITTING" }, data: { taskId: upstreamTaskId, status: String(upstream.status ?? "QUEUED") } });
      if (!updated.count) throw new ConflictException("媒体任务状态已变更，需要人工核对");
      const task = await this.prisma.mediaTaskRecord.findUniqueOrThrow({ where: { taskId: upstreamTaskId } });
      return { taskId: task.taskId, status: upstream.status ?? "QUEUED", estimatedAmount, upstream };
    } catch (error) {
      if (!upstreamAccepted && (error instanceof BadRequestException || error instanceof ProviderRejectedError)) await this.refundFailure(reservationId, { status: "FAILED" });
      else {
        await this.prisma.mediaTaskRecord.updateMany({ where: { taskId: reservationId, status: "SUBMITTING" }, data: { status: "REVIEW" } });
        throw new BadGatewayException("媒体任务提交结果待核对，请勿重复提交并联系客服");
      }
      throw error;
    }
  }

  private async refundFailure(taskId: string, data: any, onlySubmitting = false, finalStatus: "FAILED" | "CANCELLED" = "FAILED") {
    return this.prisma.$transaction(async tx => {
      const task = await tx.mediaTaskRecord.findUnique({ where: { taskId } });
      if (!task) throw new NotFoundException("媒体任务不存在");
      const users = await tx.$queryRaw<Array<{ credits: number }>>`SELECT credits FROM User WHERE id = ${task.userId} FOR UPDATE`;
      if (!users.length) throw new NotFoundException("用户不存在");
      const reviewable = { OR: [{ status: "REVIEW" }, { status: "SUBMITTING", createdAt: { lte: new Date(Date.now() - 600000) } }] };
      const changed = await tx.mediaTaskRecord.updateMany({ where: { id: task.id, ...(onlySubmitting ? reviewable : { status: { notIn: ["FAILED", "SUCCESS", "CANCELLED"] } }) }, data: { ...data, status: finalStatus, settledAmount: 0, settledAt: new Date() } });
      if (!changed.count && onlySubmitting) throw new ConflictException("任务已处理，请刷新后查看");
      if (changed.count) {
        const user = users[0];
        await tx.user.update({ where: { id: task.userId }, data: { credits: { increment: task.estimatedAmount }, totalCreditsConsumed: { decrement: task.estimatedAmount } } });
        await tx.creditTransaction.create({ data: { userId: task.userId, type: "refund", amount: task.estimatedAmount, balanceBefore: user.credits, balanceAfter: user.credits + task.estimatedAmount, description: `${finalStatus === "CANCELLED" ? "媒体任务取消退款" : "媒体任务失败退款"}：${task.taskType}（${taskId}）` } });
      }
      return tx.mediaTaskRecord.findUniqueOrThrow({ where: { id: task.id } });
    });
  }

  /** 取消上游任务并全额退款：仅未终态任务可取消。 */
  async cancelTask(userId: string, taskId: string) {
    const task = await this.prisma.mediaTaskRecord.findFirst({ where: { taskId, userId } });
    if (!task) throw new NotFoundException("媒体任务不存在");
    const status = String(task.status || "").toUpperCase();
    if (["SUCCESS", "FAILED", "CANCELLED"].includes(status)) throw new ConflictException("任务已结束，无法取消");
    const cancel = await this.cancelUpstream(taskId);
    const resultMeta = { ...((task.resultMeta as any) || {}), cancel };
    const cancelled = await this.refundFailure(taskId, { resultMeta, providerStatus: "CANCELLED" }, false, "CANCELLED");
    return { ...cancelled, cancel };
  }

  /** 调用 RunningHub 取消接口；上游已结束或不可取消时记录原因但不阻断本地退款。 */
  private async cancelUpstream(taskId: string) {
    const base = env("RUNNINGHUB_BASE_URL", "https://www.runninghub.ai").replace(/\/$/, "");
    const key = env("RUNNINGHUB_API_KEY", "");
    if (!base || !key) return { ok: false, reason: "RUNNINGHUB_NOT_CONFIGURED" };
    try {
      const response = await fetch(base + "/task/openapi/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: key, taskId }),
        signal: AbortSignal.timeout(30000),
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      const code = typeof payload.code === "number" ? payload.code : null;
      return { ok: response.ok && (code === 0 || code === null), code, msg: payload.msg ?? null };
    } catch (error: any) {
      return { ok: false, reason: String(error?.message || error) };
    }
  }

  async getTask(userId: string, taskId: string) {
    const task = await this.prisma.mediaTaskRecord.findFirst({ where: { taskId, userId } });
    if (!task) throw new NotFoundException("媒体任务不存在");
    // 已取消的任务不再回查上游：上游仍在队列里时会回报 QUEUED/RUNNING，会把本地状态顶回去。
    if (String(task.status).toUpperCase() === "CANCELLED") return { ...task, upstream: null };
    const publicBase = env("PUBLIC_BASE_URL", "").replace(/\/$/, "");
    const meta = task.resultMeta as { archivedBytes?: number } | null;
    const alreadyArchived = Boolean(task.resultUrl && task.status === "SUCCESS" && ((meta && meta.archivedBytes) || (publicBase && task.resultUrl.startsWith(publicBase + "/"))));
    if (alreadyArchived && task.status === "SUCCESS") return { ...task, upstream: null };
    const upstream = await this.providerQuery(taskId);
    const fields = this.settleFields(upstream);
    if ((task.resultMeta as any)?.review) fields.resultMeta = { ...(fields.resultMeta as any), review: (task.resultMeta as any).review };
    if (fields.providerStatus === "FAILED") return { ...(await this.refundFailure(taskId, fields)), upstream };
    if (alreadyArchived && fields.resultUrl) fields.resultUrl = task.resultUrl;
    const needsArchive = fields.providerStatus === "SUCCESS" && Boolean(fields.resultUrl) && !alreadyArchived;
    if (fields.providerStatus && (fields.providerStatus !== task.status || fields.resultUrl !== task.resultUrl || needsArchive)) {
      const archived = fields.providerStatus === "SUCCESS" ? await this.archiveResult(taskId, fields.resultUrl) : null;
      const data: any = { status: fields.providerStatus, ...fields };
      if (archived) {
        data.resultUrl = archived.url;
        data.resultMeta = { ...(fields.resultMeta as any), archivedBytes: archived.bytes, sourceUrl: archived.sourceUrl };
      }
      await this.prisma.mediaTaskRecord.updateMany({ where: { id: task.id, status: { not: "FAILED" } }, data });
      return { ...(await this.prisma.mediaTaskRecord.findUniqueOrThrow({ where: { id: task.id } })), upstream };
    }
    return { ...task, upstream };
  }

  async webhook(taskId: string, payload: any) {
    const task = await this.prisma.mediaTaskRecord.findFirst({ where: { taskId } });
    if (!task) throw new NotFoundException("媒体任务不存在");
    // 已取消的任务忽略迟到回调，避免把状态改回运行中或重复退款。
    if (String(task.status).toUpperCase() === "CANCELLED") return task;
    const eventData = typeof payload?.eventData === "string" ? JSON.parse(payload.eventData) : (payload?.eventData ?? payload);
    const normalized = { ...eventData, status: typeof eventData?.status === "string" ? eventData.status : "SUCCESS" };
    const fields = this.settleFields(normalized);
    if ((task.resultMeta as any)?.review) fields.resultMeta = { ...(fields.resultMeta as any), review: (task.resultMeta as any).review };
    if (normalized.status === "FAILED") return this.refundFailure(taskId, fields);
    const data: any = { status: normalized.status, ...fields };
    if (normalized.status === "SUCCESS") {
      const archived = await this.archiveResult(taskId, fields.resultUrl);
      if (archived) {
        data.resultUrl = archived.url;
        data.resultMeta = { ...(fields.resultMeta as any), archivedBytes: archived.bytes, sourceUrl: archived.sourceUrl };
      }
    }
    await this.prisma.mediaTaskRecord.updateMany({ where: { id: task.id, status: { not: "FAILED" } }, data });
    return this.prisma.mediaTaskRecord.findUniqueOrThrow({ where: { id: task.id } });
  }

  async usageSummary(userId: string | undefined, daysValue: unknown) {
    const days = Number(daysValue ?? 7);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new BadRequestException("统计天数须为 1 至 365 的整数");
    const since = new Date(Date.now() - days * 86400000);
    const tasks = await this.prisma.mediaTaskRecord.findMany({ where: { ...(userId ? { userId } : {}), createdAt: { gte: since } }, select: { taskType: true, status: true, estimatedAmount: true, settledAmount: true, resultMeta: true } });
    const groups = new Map<string, { taskType: string; count: number; upstreamCoins: number; unknownUpstreamCount: number; chargedCredits: number; costStatus: string }>();
    for (const task of tasks) {
      const item = groups.get(task.taskType) || { taskType: task.taskType, count: 0, upstreamCoins: 0, unknownUpstreamCount: 0, chargedCredits: 0, costStatus: "待核算" };
      item.count++;
      const raw = (task.resultMeta as any)?.usage?.consumeCoins;
      const coins = raw == null || raw === "" ? NaN : Number(raw);
      if (Number.isFinite(coins) && coins >= 0) item.upstreamCoins += coins; else item.unknownUpstreamCount++;
      item.chargedCredits += task.settledAmount ?? task.estimatedAmount;
      groups.set(task.taskType, item);
    }
    return { days, since, items: [...groups.values()], costStatus: "待核算" };
  }

  async pendingReviews() {
    return this.prisma.mediaTaskRecord.findMany({ where: { OR: [{ status: "REVIEW" }, { status: "SUBMITTING", createdAt: { lte: new Date(Date.now() - 600000) } }] }, select: { taskId: true, userId: true, taskType: true, estimatedAmount: true, inputSeconds: true, createdAt: true }, orderBy: { createdAt: "asc" }, take: 200 });
  }

  async resolveReview(taskId: string, adminId: string, body: any) {
    if (!taskId.startsWith("reservation-")) throw new BadRequestException("不是待核对的预占任务");
    const reason = String(body?.reason || "").trim();
    if (reason.length < 4 || reason.length > 500) throw new BadRequestException("请填写核对依据（4 至 500 字）");
    const review = { adminId, reason, action: body?.action, at: new Date().toISOString() };
    if (body?.action === "refund") return this.refundFailure(taskId, { resultMeta: { review } }, true);
    if (body?.action !== "track") throw new BadRequestException("核对操作无效");
    const upstreamTaskId = String(body?.upstreamTaskId || "").trim();
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(upstreamTaskId) || upstreamTaskId.startsWith("reservation-")) throw new BadRequestException("上游任务编号无效");
    const result = await this.prisma.mediaTaskRecord.updateMany({ where: { taskId, OR: [{ status: "REVIEW" }, { status: "SUBMITTING", createdAt: { lte: new Date(Date.now() - 600000) } }] }, data: { taskId: upstreamTaskId, status: "QUEUED", resultMeta: { review: { ...review, upstreamTaskId } } } });
    if (!result.count) throw new ConflictException("任务已处理，请刷新后查看");
    return this.prisma.mediaTaskRecord.findUniqueOrThrow({ where: { taskId: upstreamTaskId } });
  }

  async template() { return { items: [] }; }
  async tempFile(userId: string, body: any) { return { ...body, userId, uploadUrl: null, expiresIn: 900 }; }
  async ossTransfer(userId: string, body: any) {
    const sourceUrl = String(body?.sourceUrl ?? body?.url ?? "");
    if (!/^https?:\/\//i.test(sourceUrl)) throw new BadRequestException("缺少有效的媒体结果 URL");
    const sourceHost = new URL(sourceUrl).hostname.toLowerCase();
    const allowedHost = /(^|\.)runninghub\.(ai|cn)$|(^|\.)myqcloud\.com$|(^|\.)xiaoyaoyou\.com$/i.test(sourceHost);
    if (!allowedHost) throw new BadRequestException("媒体结果来源域名不受支持");
    const accessKeyId = env("OSS_ACCESS_KEY_ID", "");
    const accessKeySecret = env("OSS_ACCESS_KEY_SECRET", "");
    const bucket = env("OSS_BUCKET", "");
    const region = env("OSS_REGION", "");
    const endpoint = env("OSS_ENDPOINT", "");
    if (!accessKeyId || !accessKeySecret || !bucket || !region || !endpoint) throw new BadRequestException("OSS 未配置完整");
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new BadGatewayException("媒体结果下载失败");
    const data = Buffer.from(await response.arrayBuffer());
    const extension = (body?.extension || sourceUrl.split(/[?#]/)[0].split(".").pop() || "bin").replace(/[^a-z0-9]/gi, "") || "bin";
    const requestedKey = String(body?.objectKey || "");
    const prefix = `media/${userId}/`;
    const objectKey = requestedKey.startsWith(prefix)
      ? requestedKey
      : `${prefix}${body?.taskId || randomUUID()}.${extension}`;
    const client = new OSS({ region, accessKeyId, accessKeySecret, bucket, endpoint, secure: true });
    const result = await client.put(objectKey, data, { headers: { "Content-Type": response.headers.get("content-type") || "application/octet-stream", "Content-Disposition": "inline" } });
    return { ...body, userId, status: "completed", objectKey, url: result.url || null, bytes: data.length };
  }
}