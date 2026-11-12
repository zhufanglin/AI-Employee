import { BadRequestException } from "@nestjs/common";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { CapabilityDescriptor, CapabilityHandler } from "../capability.types";
import { env } from "../../common/env";
import {
  extOf,
  ossClient,
  ossPublicUrl,
  readWorkspaceBytes,
  resolveWorkspaceFile,
  saveWorkspaceFile,
  storedName,
  userDir,
  userPrefix,
} from "./files";
import { pickPublicAddress } from "./web-extract";

/** 音视频处理：对工作区素材或公网 URL 做剪辑、转码、抽音轨、截图、拼接（ffmpeg 子进程，参数数组不经过 shell）。 */
export const descriptors: CapabilityDescriptor[] = [
  {
    name: "media_process",
    title: "音视频处理",
    category: "media",
    description: "对视频/音频做探测、剪辑、抽音轨、转码、压缩、截图与拼接；源可以是工作区文件或公网 URL，结果落回工作区",
    params: {
      op: "必填，操作：info | trim | extract_audio | transcode | compress | thumbnail | concat",
      source: "op 不是 concat 时必填，工作区 key、工作区文件名或 http(s) 地址",
      sources: "concat 时必填，2-10 个源，元素同 source",
      start: "可选，起始秒数（trim/thumbnail/gif），默认 0",
      duration: "trim 必填，截取秒数，需大于 0 且不超过 600",
      format: "extract_audio 可选 mp3|wav|m4a（默认 mp3）；transcode 可选 mp4|webm|mp3|wav|m4a|gif（默认 mp4）",
      crf: "compress 可选，画质 18-40，默认 28（数值越大文件越小、画面越糊）",
      time: "thumbnail 可选，截图时间秒，默认 1",
      name: "可选，输出基础名（不含扩展名）",
    },
  },
  {
    name: "media_info",
    title: "读取音视频信息",
    category: "media",
    description: "用 ffprobe 读取视频/音频的时长、体积、容器格式、编码、分辨率、帧率、声道与采样率",
    params: {
      source: "必填，工作区 key、工作区文件名或 http(s) 地址",
    },
  },
];

const OPS = ["info", "trim", "extract_audio", "transcode", "compress", "thumbnail", "concat"] as const;
type MediaOp = (typeof OPS)[number];

const AUDIO_FORMATS = ["mp3", "wav", "m4a"];
const TRANSCODE_FORMATS = ["mp4", "webm", "mp3", "wav", "m4a", "gif"];
const AUDIO_EXTS = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"];

const INPUT_MAX_BYTES = 200 * 1024 * 1024;
const OUTPUT_MAX_BYTES = 120 * 1024 * 1024;
const DURATION_MAX = 600;
const CONCAT_MAX = 10;
const FFMPEG_TIMEOUT_MS = 300 * 1000;
const FFPROBE_TIMEOUT_MS = 30 * 1000;
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const DOWNLOAD_REDIRECTS = 3;

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
};

function ffmpegBinary(): string {
  return env("FFMPEG_PATH", "").trim() || "ffmpeg";
}

function ffprobeBinary(): string {
  return env("FFPROBE_PATH", "").trim() || "ffprobe";
}

function spawnError(error: any, label: string): BadRequestException {
  if (error?.code === "ENOENT") {
    if (label === "ffprobe") return new BadRequestException("服务器未安装 ffmpeg（ffprobe 不可用），可用 FFPROBE_PATH 指定路径");
    return new BadRequestException("服务器未安装 ffmpeg，可用 FFMPEG_PATH 指定路径");
  }
  return new BadRequestException(label + " 启动失败：" + (error?.message || String(error)));
}

/** 执行一个外部二进制：参数数组直传，不经过 shell；超时直接 kill。 */
async function runBinary(bin: string, args: string[], timeoutMs: number, label: string): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    let child: any;
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(spawnError(error, label));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* 进程已退出 */ }
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 20000) stderr = stderr.slice(-10000);
    });
    child.on("error", (error: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(spawnError(error, label));
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new BadRequestException(label + " 处理超时（" + Math.trunc(timeoutMs / 1000) + " 秒），已终止"));
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300);
        reject(new BadRequestException(label + " 处理失败：" + (detail || ("退出码 " + code))));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseRate(raw: any): number | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const parts = text.split("/");
  const numerator = Number(parts[0]);
  const denominator = parts.length > 1 ? Number(parts[1]) : 1;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  const value = numerator / denominator;
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) / 1000 : null;
}

export interface MediaProbe {
  durationSec: number | null;
  sizeBytes: number;
  formatName: string;
  video?: { codec: string; width: number; height: number; fps: number | null };
  audio?: { codec: string; channels: number | null; sampleRate: number | null };
}

/** ffprobe 读取元数据；非音视频或损坏文件抛 BadRequestException。 */
async function probeMedia(path: string): Promise<MediaProbe> {
  const { stdout } = await runBinary(
    ffprobeBinary(),
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    FFPROBE_TIMEOUT_MS,
    "ffprobe",
  );
  let data: any;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new BadRequestException("无法解析媒体文件：ffprobe 输出不是合法 JSON");
  }
  const streams: any[] = Array.isArray(data?.streams) ? data.streams : [];
  const format: any = data?.format ?? {};
  const videoStream = streams.find((stream) => stream?.codec_type === "video" && stream?.disposition?.attached_pic !== 1);
  const audioStream = streams.find((stream) => stream?.codec_type === "audio");
  if (!videoStream && !audioStream) throw new BadRequestException("无法解析媒体文件，可能不是音视频文件");
  let sizeBytes = Number(format.size);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    try { sizeBytes = (await stat(path)).size; } catch { sizeBytes = 0; }
  }
  const duration = Number(format.duration ?? videoStream?.duration ?? audioStream?.duration);
  const result: MediaProbe = {
    durationSec: Number.isFinite(duration) && duration >= 0 ? Math.round(duration * 1000) / 1000 : null,
    sizeBytes,
    formatName: String(format.format_name ?? ""),
  };
  if (videoStream) {
    result.video = {
      codec: String(videoStream.codec_name ?? ""),
      width: Number(videoStream.width) || 0,
      height: Number(videoStream.height) || 0,
      fps: parseRate(videoStream.avg_frame_rate) ?? parseRate(videoStream.r_frame_rate),
    };
  }
  if (audioStream) {
    const channels = Number(audioStream.channels);
    const sampleRate = Number(audioStream.sample_rate);
    result.audio = {
      codec: String(audioStream.codec_name ?? ""),
      channels: Number.isFinite(channels) ? channels : null,
      sampleRate: Number.isFinite(sampleRate) ? sampleRate : null,
    };
  }
  return result;
}

type PreparedSource = { path: string; name: string; sizeBytes: number };

function sanitizeBase(raw: string, stripExt = true): string {
  let base = String(raw ?? "").trim().replace(/\\/g, "/");
  base = base.slice(base.lastIndexOf("/") + 1);
  if (stripExt) {
    const dot = base.lastIndexOf(".");
    if (dot > 0) base = base.slice(0, dot);
  }
  base = base.replace(/[^\w\u4e00-\u9fa5.-]+/g, "-").replace(/^[.\-]+|[.\-]+$/g, "");
  if (base.length > 60) base = base.slice(0, 60);
  return base;
}

function explicitBase(raw: string): string {
  const base = sanitizeBase(raw, false).replace(/\.(mp4|mov|webm|mkv|mp3|wav|m4a|aac|gif|jpg|jpeg)$/i, "");
  return base.replace(/[.\-]+$/g, "");
}

function buildOutputName(base: string, suffix: string, ext: string): string {
  const clean = (base || "output").slice(0, 64);
  return (clean + suffix).slice(0, 70) + ext;
}

async function ensureTempDir(): Promise<string> {
  const dir = join(tmpdir(), "p16-media-" + randomUUID());
  await mkdir(dir, { recursive: true });
  return dir;
}

async function resolvePublicTarget(input: string): Promise<{ url: URL; address: string; family: number }> {
  let url: URL;
  try { url = new URL(input); } catch { throw new BadRequestException("网址无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new BadRequestException("仅支持不含凭据的 http(s) 地址");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host);
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = literal ? [{ address: host, family: literal }] : await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new BadRequestException("域名解析失败：" + host);
  }
  const chosen = pickPublicAddress(addresses);
  return { url, address: chosen.address, family: chosen.family };
}

function urlFileName(url: URL): string {
  try {
    const name = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf("/") + 1));
    return sanitizeBase(name, false) || "download";
  } catch {
    return "download";
  }
}

/** 公网 URL 下载到临时文件：固定解析结果防 DNS 重绑定，禁内网/保留地址，上限 200MB、超时 60s。 */
async function downloadToTemp(input: string, dir: string, index: number): Promise<PreparedSource> {
  let current = input;
  for (let hop = 0; hop <= DOWNLOAD_REDIRECTS; hop += 1) {
    const target = await resolvePublicTarget(current);
    const url = target.url;
    const dest = join(dir, "download-" + index + ".bin");
    const outcome = await new Promise<{ location?: string; bytes?: number }>((resolve, reject) => {
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = send(
        url,
        {
          method: "GET",
          family: target.family,
          headers: { "user-agent": "Mozilla/5.0 (compatible; fcmediaagent-capability/1.0)" },
          lookup: (_host: string, _options: any, callback: any) => callback(null, target.address, target.family),
        },
        (res) => {
          const status = res.statusCode || 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            const location = res.headers.location;
            res.resume();
            if (!location) { reject(new BadRequestException("下载失败：重定向缺少 Location")); return; }
            resolve({ location: new URL(location, url).href });
            return;
          }
          if (status < 200 || status >= 300) {
            res.resume();
            reject(new BadRequestException("下载失败：HTTP " + status));
            return;
          }
          const declared = Number(res.headers["content-length"]);
          if (Number.isFinite(declared) && declared > INPUT_MAX_BYTES) {
            res.resume();
            reject(new BadRequestException("源文件超过 200MB 限制"));
            return;
          }
          let bytes = 0;
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > INPUT_MAX_BYTES) req.destroy(new BadRequestException("源文件超过 200MB 限制"));
          });
          pipeline(res, createWriteStream(dest)).then(() => resolve({ bytes })).catch(reject);
        },
      );
      req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => req.destroy(new BadRequestException("下载超时（60 秒）")));
      req.on("error", reject);
      req.end();
    });
    if (outcome.location) {
      if (hop === DOWNLOAD_REDIRECTS) throw new BadRequestException("下载重定向次数过多");
      current = outcome.location;
      continue;
    }
    return { path: dest, name: urlFileName(url), sizeBytes: outcome.bytes ?? 0 };
  }
  throw new BadRequestException("下载重定向次数过多");
}

/** 把 source 参数（URL / 工作区 key / 工作区文件名）落到临时文件；key 越权与内网 URL 在此被拦。 */
async function prepareSource(userId: string, raw: any, dir: string, index: number): Promise<PreparedSource> {
  const source = String(raw ?? "").trim();
  if (!source) throw new BadRequestException("source 必填，可填工作区 key、工作区文件名或 http(s) 地址");
  if (/^https?:\/\//i.test(source)) {
    const downloaded = await downloadToTemp(source, dir, index);
    if (downloaded.sizeBytes > INPUT_MAX_BYTES) throw new BadRequestException("源文件超过 200MB 限制");
    if (!downloaded.sizeBytes) throw new BadRequestException("下载的源文件为空");
    return downloaded;
  }
  const file = source.startsWith("workspace/")
    ? await resolveWorkspaceFile(userId, { key: source })
    : await resolveWorkspaceFile(userId, { name: source });
  if (!file) throw new BadRequestException("源文件不存在或无权访问：" + source);
  const buffer = await readWorkspaceBytes(userId, file);
  if (buffer.byteLength > INPUT_MAX_BYTES) throw new BadRequestException("源文件超过 200MB 限制");
  if (!buffer.byteLength) throw new BadRequestException("源文件为空");
  const ext = file.ext || extOf(file.name) || ".bin";
  const path = join(dir, "input-" + index + ext);
  await writeFile(path, buffer);
  return { path, name: file.name, sizeBytes: buffer.byteLength };
}

function audioEncodeArgs(ext: string): string[] {
  if (ext === ".wav") return ["-vn", "-c:a", "pcm_s16le"];
  if (ext === ".m4a") return ["-vn", "-c:a", "aac", "-b:a", "128k"];
  if (ext === ".mp3") return ["-vn", "-c:a", "libmp3lame", "-b:a", "128k"];
  return ["-vn", "-c:a", "aac", "-b:a", "128k"];
}

function videoEncodeArgs(ext: string, crf = 23): string[] {
  if (ext === ".webm") {
    return ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(crf), "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus", "-b:a", "96k"];
  }
  return ["-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-c:a", "aac", "-b:a", "128k"];
}

function gifEncodeArgs(): string[] {
  return ["-an", "-vf", "fps=10,scale=480:-1:flags=lanczos", "-loop", "0"];
}

function even(value: number, fallback: number): number {
  const base = Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
  return Math.max(2, base - (base % 2));
}

async function writeConcatList(dir: string, paths: string[]): Promise<string> {
  const list = join(dir, "concat.txt");
  const lines = paths.map((item) => "file '" + item.replace(/\\/g, "/").replace(/'/g, "'\\''") + "'");
  await writeFile(list, lines.join("\n") + "\n", "utf8");
  return list;
}

/** 拼接：先把每段归一成同分辨率/帧率/声道的中间文件，再用 concat demuxer 无损拼接。 */
async function concatSources(sources: PreparedSource[], dir: string): Promise<{ path: string; ext: string }> {
  const probes: MediaProbe[] = [];
  for (const source of sources) probes.push(await probeMedia(source.path));
  const firstVideo = probes.find((item) => item.video)?.video;
  if (firstVideo) {
    let width = even(firstVideo.width, 640);
    let height = even(firstVideo.height, 360);
    if (width > 1920 || height > 1080) {
      const scale = Math.min(1920 / width, 1080 / height);
      width = even(width * scale, 640);
      height = even(height * scale, 360);
    }
    const normalizeFilter = "scale=" + width + ":" + height + ":force_original_aspect_ratio=decrease,pad=" + width + ":" + height + ":(ow-iw)/2:(oh-ih)/2,setsar=1";
    const normalized: string[] = [];
    for (let i = 0; i < sources.length; i += 1) {
      const probe = probes[i];
      if (!probe.video && !probe.audio) throw new BadRequestException("sources 第 " + (i + 1) + " 项没有可用的音视频流");
      const out = join(dir, "norm-" + i + ".mp4");
      const args: string[] = ["-y"];
      if (!probe.video) {
        args.push("-f", "lavfi", "-i", "color=c=black:s=" + width + "x" + height + ":r=30", "-i", sources[i].path, "-map", "0:v:0", "-map", "1:a:0");
      } else if (!probe.audio) {
        args.push("-i", sources[i].path, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-map", "0:v:0", "-map", "1:a:0");
      } else {
        args.push("-i", sources[i].path, "-map", "0:v:0", "-map", "0:a:0");
      }
      args.push("-vf", normalizeFilter, "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-shortest", out);
      await runBinary(ffmpegBinary(), args, FFMPEG_TIMEOUT_MS, "ffmpeg");
      normalized.push(out);
    }
    const list = await writeConcatList(dir, normalized);
    const out = join(dir, "concat-out.mp4");
    await runBinary(ffmpegBinary(), ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out], FFMPEG_TIMEOUT_MS, "ffmpeg");
    return { path: out, ext: ".mp4" };
  }
  const normalized: string[] = [];
  for (let i = 0; i < sources.length; i += 1) {
    if (!probes[i].audio) throw new BadRequestException("sources 第 " + (i + 1) + " 项没有音频流，无法拼接");
    const out = join(dir, "norm-audio-" + i + ".wav");
    await runBinary(ffmpegBinary(), ["-y", "-i", sources[i].path, "-vn", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", out], FFMPEG_TIMEOUT_MS, "ffmpeg");
    normalized.push(out);
  }
  const list = await writeConcatList(dir, normalized);
  const out = join(dir, "concat-out.wav");
  await runBinary(ffmpegBinary(), ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out], FFMPEG_TIMEOUT_MS, "ffmpeg");
  return { path: out, ext: ".wav" };
}

/** 落工作区：统一走 saveWorkspaceFile（files.ts 的 UPLOAD_EXTS 已收录 webm/gif）。 */
async function saveOutput(userId: string, name: string, buffer: Buffer): Promise<{ file: any; url: string | null }> {
  if (!buffer.byteLength) throw new BadRequestException("输出文件为空，可能是源文件没有可处理的流");
  if (buffer.byteLength > OUTPUT_MAX_BYTES) throw new BadRequestException("输出文件超过 120MB 限制，请缩短时长或降低画质");
  return await saveWorkspaceFile(userId, name, buffer);
}

function numberParam(value: any, fallback: number, label: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new BadRequestException(label + " 必须是数字");
  return parsed;
}

function normalizeFormat(raw: any): string {
  return String(raw ?? "").trim().toLowerCase().replace(/^\./, "");
}

export const handlers = {
  media_process: async ({ userId, params }: any) => {
    const p = params ?? {};
    const op = String(p.op ?? "").trim() as MediaOp;
    if (!OPS.includes(op)) throw new BadRequestException("op 非法，可选：" + OPS.join(" | "));
    const dir = await ensureTempDir();
    try {
      if (op === "info") {
        const source = await prepareSource(userId, p.source, dir, 0);
        const info = await probeMedia(source.path);
        return { op, name: source.name, ...info };
      }

      if (op === "concat") {
        if (!Array.isArray(p.sources)) throw new BadRequestException("sources 必填，且必须是 2-10 个源的数组");
        if (p.sources.length < 2) throw new BadRequestException("concat 至少需要 2 个源文件");
        if (p.sources.length > CONCAT_MAX) throw new BadRequestException("concat 最多支持 10 个源文件");
        const prepared: PreparedSource[] = [];
        for (let i = 0; i < p.sources.length; i += 1) {
          const item = String(p.sources[i] ?? "").trim();
          if (!item) throw new BadRequestException("sources 第 " + (i + 1) + " 项为空");
          prepared.push(await prepareSource(userId, item, dir, i));
        }
        const merged = await concatSources(prepared, dir);
        const base = p.name ? explicitBase(p.name) : sanitizeBase(prepared[0].name, true);
        const name = buildOutputName(base, "-concat", merged.ext);
        const saved = await saveOutput(userId, name, await readFile(merged.path));
        const result: any = { op, name: saved.file.name, bytes: saved.file.bytes, key: saved.file.key, url: saved.url };
        const info = await probeMedia(merged.path).catch(() => null);
        if (info?.durationSec != null) result.durationSec = info.durationSec;
        return result;
      }

      const sourceRaw = String(p.source ?? "").trim();
      if (!sourceRaw) throw new BadRequestException("source 必填，可填工作区 key、工作区文件名或 http(s) 地址");

      const durationProvided = p.duration !== undefined && p.duration !== null && p.duration !== "";
      const duration = numberParam(p.duration, 0, "duration");
      if (durationProvided) {
        if (duration <= 0) throw new BadRequestException("duration 必须大于 0 秒");
        if (duration > DURATION_MAX) throw new BadRequestException("duration 不能超过 600 秒");
      }
      if (op === "trim" && !durationProvided) throw new BadRequestException("trim 需要 duration（截取时长，秒）");
      const start = numberParam(p.start, 0, "start");
      if (start < 0) throw new BadRequestException("start 不能为负数");

      const source = await prepareSource(userId, p.source, dir, 0);
      let outExt = ".mp4";
      let args: string[] = [];
      let suffix = "";
      let skipDuration = false;

      if (op === "trim") {
        const probe = await probeMedia(source.path);
        outExt = probe.video ? ".mp4" : (AUDIO_EXTS.includes(extOf(source.name)) ? extOf(source.name) : ".mp3");
        const encode = probe.video ? videoEncodeArgs(outExt, 23) : audioEncodeArgs(outExt);
        args = ["-y", "-i", source.path, "-ss", String(start), "-t", String(duration), ...encode, join(dir, "out" + outExt)];
        suffix = "-trim";
      } else if (op === "extract_audio") {
        const format = normalizeFormat(p.format) || "mp3";
        if (!AUDIO_FORMATS.includes(format)) throw new BadRequestException("extract_audio 的 format 可选：" + AUDIO_FORMATS.join(" | "));
        outExt = "." + format;
        args = ["-y", "-i", source.path, ...audioEncodeArgs(outExt), join(dir, "out" + outExt)];
        suffix = "-audio";
      } else if (op === "transcode") {
        const format = normalizeFormat(p.format) || "mp4";
        if (!TRANSCODE_FORMATS.includes(format)) throw new BadRequestException("transcode 的 format 可选：" + TRANSCODE_FORMATS.join(" | "));
        outExt = "." + format;
        const encode = format === "gif"
          ? gifEncodeArgs()
          : (AUDIO_FORMATS.includes(format) ? audioEncodeArgs(outExt) : videoEncodeArgs(outExt, 23));
        args = ["-y", "-i", source.path];
        if (format === "gif" && start > 0) args.push("-ss", String(start));
        if (format === "gif" && durationProvided) args.push("-t", String(duration));
        args.push(...encode, join(dir, "out" + outExt));
        suffix = "-" + format;
      } else if (op === "compress") {
        const crf = Math.trunc(numberParam(p.crf, 28, "crf"));
        if (crf < 18 || crf > 40) throw new BadRequestException("crf 必须是 18-40 的整数");
        outExt = ".mp4";
        args = ["-y", "-i", source.path, "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-c:a", "aac", "-b:a", "128k", join(dir, "out.mp4")];
        suffix = "-compressed";
      } else if (op === "thumbnail") {
        const time = numberParam(p.time, 1, "time");
        if (time < 0) throw new BadRequestException("time 不能为负数");
        const probe = await probeMedia(source.path);
        if (!probe.video) throw new BadRequestException("源文件没有视频流，无法截图");
        outExt = ".jpg";
        args = ["-y", "-i", source.path, "-ss", String(start + time), "-frames:v", "1", "-q:v", "2", join(dir, "out.jpg")];
        suffix = "-thumb";
        skipDuration = true;
      }

      await runBinary(ffmpegBinary(), args, FFMPEG_TIMEOUT_MS, "ffmpeg");
      const outPath = join(dir, "out" + outExt);
      const saved = await saveOutput(userId, buildOutputName(p.name ? explicitBase(p.name) : sanitizeBase(source.name, true), suffix, outExt), await readFile(outPath));
      const result: any = { op, name: saved.file.name, bytes: saved.file.bytes, key: saved.file.key, url: saved.url };
      if (!skipDuration) {
        const info = await probeMedia(outPath).catch(() => null);
        if (info?.durationSec != null) result.durationSec = info.durationSec;
      }
      return result;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  },

  media_info: async ({ userId, params }: any) => {
    const dir = await ensureTempDir();
    try {
      const source = await prepareSource(userId, params?.source, dir, 0);
      return await probeMedia(source.path);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  },
} as Record<string, CapabilityHandler>;

/** 供 transcribe（asr.ts）等能力复用：临时目录、源解析（工作区/公网 URL + SSRF 守卫）、探测、ffmpeg 执行。 */
export { ensureTempDir, ffmpegBinary, prepareSource, probeMedia, runBinary };
