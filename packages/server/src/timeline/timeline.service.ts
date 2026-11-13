import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PrismaService } from "../prisma/prisma.service";
import { resolvePhone } from "../common/owner";
import { buildAss, buildFilterComplex, buildSegments, buildShotPlan, DEFAULT_STYLE, StyleOptions, TimelineClip, TimelineCue } from "./edl";
import { probe, runFfmpeg } from "./ffmpeg";

const ROOT = () => join(process.cwd(), "uploads", "timeline");
const SOURCE_DIR = () => join(ROOT(), "sources");
const JOB_DIR = () => join(ROOT(), "jobs");
const TMP_DIR = () => join(ROOT(), "tmp");
const PUBLIC_PREFIX = "/uploads/timeline";
const ALLOWED_EXT = new Set(["mp4", "mov", "m4v", "mkv", "webm", "jpg", "jpeg", "png", "mp3", "m4a", "wav", "aac"]);

export interface SourceInfo {
  id: string;
  url: string;
  path: string;
  fileName: string;
  kind: "video" | "audio";
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export interface TimelineJobRow {
  id: string;
  phone: string;
  status: string;
  progress: number;
  spec: any;
  resultUrl: string | null;
  error: string | null;
  durationSeconds: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 时间线剪辑：把 A 线（对标视频）那套 ffmpeg 流程固化成接口。
 * 链路：上传素材 → POST /timeline/jobs → 后台按 EDL 切镜/拼接/调色/画中画/烧字幕 → /uploads 静态地址取成片。
 *
 * 说明：TimelineJob 的读写走原生 SQL，因为本机 node_modules/.prisma 里的查询引擎 DLL 被
 * 已运行的旧服务进程占用，`prisma generate` 无法落盘；换成 Prisma 委托写法不需要，表结构已由
 * prisma/migrations/20261113154500_add_timeline_job 建立。
 */
@Injectable()
export class TimelineService {
  private readonly logger = new Logger(TimelineService.name);
  private running = 0;
  private readonly maxConcurrent = 1;
  private readonly pending = new Map<string, any>();

  constructor(private readonly prisma: PrismaService) {}

  private ensureDirs() {
    for (const dir of [ROOT(), SOURCE_DIR(), JOB_DIR(), TMP_DIR()]) mkdirSync(dir, { recursive: true });
  }

  private toPublicUrl(absolute: string): string {
    const base = resolve(ROOT());
    const abs = resolve(absolute);
    const rel = abs.startsWith(base) ? abs.slice(base.length) : `/${abs}`;
    return `${PUBLIC_PREFIX}${rel.replace(/\\/g, "/")}`;
  }

  /** 把客户端传来的引用（/uploads/... 或绝对路径）落地成真实文件路径 */
  private resolveLocal(ref: string): string {
    const raw = String(ref || "").trim();
    if (!raw) throw new BadRequestException("素材引用为空");
    if (/^https?:\/\//i.test(raw)) throw new BadRequestException("只支持本地上传的素材，请先调用 POST /api/timeline/sources");
    if (raw.startsWith(PUBLIC_PREFIX)) {
      const p = join(process.cwd(), "uploads", "timeline", raw.slice(PUBLIC_PREFIX.length));
      if (!existsSync(p)) throw new BadRequestException(`素材不存在：${raw}`);
      return p;
    }
    const abs = resolve(raw);
    if (!existsSync(abs)) throw new BadRequestException(`素材不存在：${raw}`);
    return abs;
  }

  /** POST /timeline/sources：base64 落本地盘，返回可复用的素材引用 + 探测信息 */
  async uploadSource(user: any, body: any): Promise<SourceInfo> {
    this.ensureDirs();
    await resolvePhone(this.prisma, user);
    const base64 = String(body?.base64 || body?.data || "").replace(/^data:[^;]+;base64,/, "");
    if (!base64) throw new BadRequestException("缺少 base64 文件内容");
    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length) throw new BadRequestException("文件内容为空");
    if (buffer.length > 200 * 1024 * 1024) throw new BadRequestException("文件超过 200MB");
    const fileName = String(body?.fileName || body?.name || "source.mp4").replace(/[\\/:*?"<>|]/g, "_").slice(-80);
    const ext = (fileName.split(".").pop() || "mp4").toLowerCase();
    if (!ALLOWED_EXT.has(ext)) throw new BadRequestException(`不支持的素材格式：${ext}`);
    const id = randomUUID();
    const target = join(SOURCE_DIR(), `${id}.${ext}`);
    writeFileSync(target, buffer);
    const info = await probe(target, TMP_DIR());
    return {
      id,
      url: this.toPublicUrl(target),
      path: target,
      fileName,
      kind: info.hasVideo ? "video" : "audio",
      duration: Number(info.duration.toFixed(3)),
      width: info.width,
      height: info.height,
      hasAudio: info.hasAudio,
    };
  }

  /** POST /timeline/jobs：创建剪辑任务（异步执行，立刻返回 id 轮询） */
  async createJob(user: any, body: any) {
    this.ensureDirs();
    const phone = await resolvePhone(this.prisma, user);
    const clipsIn: any[] = Array.isArray(body?.clips) ? body.clips : [];
    if (!clipsIn.length) throw new BadRequestException("请至少提供 1 段视频素材");
    if (clipsIn.length > 200) throw new BadRequestException("单次最多 200 段素材");
    const clipFiles = clipsIn.map((c) => this.resolveLocal(typeof c === "string" ? c : c?.path || c?.url || c?.fileId));
    const voiceoverRef = body?.voiceover || body?.voiceUrl || null;
    const voiceover = voiceoverRef ? this.resolveLocal(voiceoverRef) : null;
    const personRef = body?.person || body?.personUrl || null;
    const person = personRef ? this.resolveLocal(personRef) : null;
    const cues: TimelineCue[] = Array.isArray(body?.cues)
      ? body.cues
          .map((c: any) => ({ start: Number(c?.start), end: Number(c?.end), text: c?.text ? String(c.text) : undefined, keyword: c?.keyword ? String(c.keyword) : undefined }))
          .filter((c: TimelineCue) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
      : [];
    const styleIn = (body?.style || {}) as Partial<StyleOptions>;
    const style: StyleOptions = { ...DEFAULT_STYLE, ...styleIn, pip: styleIn.pip === null ? null : { ...DEFAULT_STYLE.pip!, ...(styleIn.pip || {}) } };
    const totalDuration = Number(body?.totalDuration || 0) || undefined;

    const id = randomUUID();
    const spec = {
      title: body?.title ? String(body.title).slice(0, 120) : undefined,
      clips: clipFiles.map((p) => p.replace(/\\/g, "/")),
      voiceover: voiceover?.replace(/\\/g, "/") || null,
      person: person?.replace(/\\/g, "/") || null,
      cues: cues.length,
      style,
      seed: Number(body?.seed || 7),
      totalDuration: totalDuration ?? null,
    };
    await this.prisma.$executeRawUnsafe(
      "INSERT INTO `TimelineJob` (`id`,`phone`,`status`,`progress`,`spec`,`createdAt`,`updatedAt`) VALUES (?,?,'queued',0,?,NOW(3),NOW(3))",
      id,
      phone,
      JSON.stringify(spec),
    );
    this.enqueue(id, { clipFiles, voiceover, person, cues, style, totalDuration, seed: Number(body?.seed || 7) });
    return { id, status: "queued", progress: 0, title: spec.title ?? null };
  }

  /** GET /timeline/jobs/:id */
  async getJob(user: any, id: string) {
    const phone = await resolvePhone(this.prisma, user);
    const rows = await this.prisma.$queryRawUnsafe<TimelineJobRow[]>(
      "SELECT `id`,`phone`,`status`,`progress`,`spec`,`resultUrl`,`error`,`durationSeconds`,`createdAt`,`updatedAt` FROM `TimelineJob` WHERE `id` = ? AND `phone` = ? LIMIT 1",
      id,
      phone,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException("剪辑任务不存在");
    return this.view(row);
  }

  /** GET /timeline/jobs?limit=20 */
  async listJobs(user: any, query: any) {
    const phone = await resolvePhone(this.prisma, user);
    const limit = Math.min(100, Math.max(1, Number(query?.limit) || 20));
    const rows = await this.prisma.$queryRawUnsafe<TimelineJobRow[]>(
      "SELECT `id`,`phone`,`status`,`progress`,`spec`,`resultUrl`,`error`,`durationSeconds`,`createdAt`,`updatedAt` FROM `TimelineJob` WHERE `phone` = ? ORDER BY `createdAt` DESC LIMIT ?",
      phone,
      limit,
    );
    return rows.map((r) => this.view(r));
  }

  private view(row: TimelineJobRow) {
    return {
      id: row.id,
      phone: row.phone,
      status: row.status,
      progress: row.progress,
      spec: row.spec,
      resultUrl: row.resultUrl,
      error: row.error,
      durationSeconds: row.durationSeconds,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async update(id: string, patch: { status?: string; progress?: number; resultUrl?: string | null; error?: string | null; durationSeconds?: number | null }) {
    const sets: string[] = [];
    const args: any[] = [];
    for (const [key, value] of Object.entries(patch)) {
      sets.push(`\`${key}\` = ?`);
      args.push(value);
    }
    if (!sets.length) return;
    await this.prisma.$executeRawUnsafe(`UPDATE \`TimelineJob\` SET ${sets.join(", ")}, \`updatedAt\` = NOW(3) WHERE \`id\` = ?`, ...args, id);
  }

  private enqueue(jobId: string, payload: any) {
    this.pending.set(jobId, payload);
    void this.drain();
  }

  private async drain() {
    if (this.running >= this.maxConcurrent) return;
    const nextId = this.pending.keys().next().value as string | undefined;
    if (!nextId) return;
    const payload = this.pending.get(nextId);
    this.pending.delete(nextId);
    this.running += 1;
    try {
      await this.run(nextId, payload);
    } catch (error: any) {
      this.logger.error(`时间线剪辑失败 ${nextId}: ${error?.message || error}`);
      await this.update(nextId, { status: "failed", error: String(error?.message || error).slice(0, 900) }).catch(() => undefined);
    } finally {
      this.running -= 1;
      void this.drain();
    }
  }

  private async run(jobId: string, payload: { clipFiles: string[]; voiceover: string | null; person: string | null; cues: TimelineCue[]; style: StyleOptions; totalDuration?: number; seed: number }) {
    const { clipFiles, voiceover, person, cues, style, seed } = payload;
    this.ensureDirs();
    await this.update(jobId, { status: "running", progress: 1, error: null });

    const clips: TimelineClip[] = [];
    for (const file of clipFiles) {
      const info = await probe(file, TMP_DIR());
      if (!info.hasVideo || info.duration < 0.3) continue;
      clips.push({ path: file, duration: info.duration });
    }
    if (!clips.length) throw new Error("没有可用素材（时长都太短）");

    let voiceDuration = 0;
    if (voiceover) {
      const v = await probe(voiceover, TMP_DIR());
      voiceDuration = v.duration;
    }
    const totalDuration = Number(payload.totalDuration || voiceDuration || 0);
    if (!totalDuration || totalDuration < 1) throw new BadRequestException("无法确认成片时长：请提供 totalDuration 或带时长信息的配音");
    if (totalDuration > 600) throw new BadRequestException("单次成片最长 10 分钟");

    const segments = buildSegments(totalDuration, cues);
    const shots = buildShotPlan(segments, clips, seed);

    // 字幕：只保留落在成片时长内的 cue
    const visibleCues = cues.filter((c) => c.start < totalDuration - 0.1).map((c) => ({ ...c, end: Math.min(c.end, totalDuration) }));
    const assPath = join(JOB_DIR(), `${jobId}.ass`);
    const hasAss = style.subtitles !== false && visibleCues.length > 0;
    if (hasAss) writeFileSync(assPath, buildAss(visibleCues, { width: style.width, height: style.height }), "utf8");
    const styleForRun: StyleOptions = { ...style, fontsDir: process.env.TIMELINE_FONTS_DIR || "C:/Windows/Fonts", assPath: hasAss ? assPath : undefined };

    // 输入顺序：唯一化后的素材 → 配音 → 画中画
    const uniqueFiles: string[] = [];
    const clipInputIndex: number[] = [];
    for (const clip of clips) {
      let idx = uniqueFiles.indexOf(clip.path);
      if (idx < 0) {
        uniqueFiles.push(clip.path);
        idx = uniqueFiles.length - 1;
      }
      clipInputIndex.push(idx);
    }
    const { filter, videoLabel, audioLabel } = buildFilterComplex(shots, clipInputIndex, styleForRun, {
      totalDuration,
      hasVoice: Boolean(voiceover),
      hasPip: Boolean(person),
    });

    const outPath = join(JOB_DIR(), `${jobId}.mp4`);
    const args: string[] = [];
    for (const file of uniqueFiles) args.push("-i", file);
    if (voiceover) args.push("-i", voiceover);
    if (person) args.push("-i", person);
    args.push(
      "-filter_complex", filter,
      "-map", `[${videoLabel}]`,
    );
    if (audioLabel) args.push("-map", `[${audioLabel}]`);
    args.push(
      "-t", totalDuration.toFixed(3),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", "-r", String(style.fps),
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-movflags", "+faststart",
      outPath,
    );

    let lastWrite = 0;
    const { code, stderr } = await runFfmpeg(args, {
      tmpDir: TMP_DIR(),
      tag: `job_${jobId}`,
      totalDuration,
      timeoutMs: 30 * 60 * 1000,
      onProgress: (ratio) => {
        const progress = Math.min(99, Math.round(3 + ratio * 96));
        if (progress - lastWrite >= 5) {
          lastWrite = progress;
          void this.update(jobId, { progress }).catch(() => undefined);
        }
      },
    });
    if (code !== 0) throw new Error(`ffmpeg 合成失败（exit ${code}）：${stderr.slice(-700)}`);

    await this.update(jobId, {
      status: "completed",
      progress: 100,
      resultUrl: `${PUBLIC_PREFIX}/jobs/${jobId}.mp4`,
      durationSeconds: Number(totalDuration.toFixed(2)),
      error: null,
    });
    this.logger.log(`时间线剪辑完成 ${jobId}（${shots.length} 个镜头 / ${totalDuration.toFixed(1)}s）`);
  }
}

