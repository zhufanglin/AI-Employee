import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * P45-1：《人工智能生成合成内容标识办法》显式标识。
 * 媒体产物（文生图 / 图生视频 / 口播 / 混剪）在归档到 OSS 之前烧一个角标，
 * 让用户把文件发给别人时标识不会丢。隐式标识（元数据）在 OSS 对象 meta 里另写。
 *
 * 用 ffmpeg drawtext 而不是引入 sharp/canvas：生产已有 ffmpeg（P16 media_process 同一条链路），
 * 少一个 npm 依赖就少一次「--no-save 被 prune」事故。
 */

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "bmp"]);
/** 视频只处理这几种容器：重新编码到 mp4 最稳；webm/mkv 走同一路径也转 mp4。 */
const VIDEO_EXT = new Set(["mp4", "mov", "m4v", "webm", "mkv"]);

/** 中文字体候选：生产 Linux 用 Noto CJK（apt fonts-noto-cjk 装），开发机 Windows 用微软雅黑。 */
const FONT_CANDIDATES = [
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
  "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
  "/usr/share/fonts/truetype/arphic/uming.ttc",
  "C:/Windows/Fonts/msyh.ttc",
  "C:/Windows/Fonts/msyhbd.ttc",
  "C:/Windows/Fonts/simhei.ttf",
];

export type WatermarkResult = {
  buffer: Buffer;
  watermarked: boolean;
  /** 实际烧进画面的文字（没烧成时为 null） */
  text: string | null;
  /** 跳过/失败原因，便于排查 */
  reason?: string;
};

export function watermarkEnabled(): boolean {
  return String(process.env.MEDIA_WATERMARK ?? "1") !== "0";
}

export function watermarkText(): string {
  return String(process.env.MEDIA_WATERMARK_TEXT || "AI生成").slice(0, 24);
}

/** 找到可用的字体文件；都没有返回 null（此时会退化成无中文字体的 ASCII 标识或不水印）。 */
export function pickFont(): string | null {
  const custom = String(process.env.MEDIA_WATERMARK_FONT || "").trim();
  if (custom && existsSync(custom)) return custom;
  for (const f of FONT_CANDIDATES) {
    if (f && existsSync(f)) return f;
  }
  return null;
}

export function canWatermarkExt(ext: string): boolean {
  const e = String(ext || "").toLowerCase();
  return IMAGE_EXT.has(e) || VIDEO_EXT.has(e);
}

/** ffmpeg filter 参数值转义：反斜杠、冒号、逗号、单引号都要处理（Windows 字体路径 C:/... 就靠它）。 */
function escapeFilterValue(value: string): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/'/g, "");
}

function isImageExt(ext: string) {
  return IMAGE_EXT.has(String(ext || "").toLowerCase());
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e: any) {
      resolve({ ok: false, stderr: "spawn failed: " + String(e?.message || e) });
      return;
    }
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);
    child.stderr?.on("data", (d) => {
      if (stderr.length < 8000) stderr += String(d);
    });
    child.on("error", (e: any) => {
      clearTimeout(timer);
      resolve({ ok: false, stderr: "error: " + String(e?.message || e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stderr });
    });
  });
}

/**
 * 把「AI生成」角标烧到右下角。
 * 失败时返回原 buffer（watermarked=false），绝不因为水印失败把用户结果弄丢。
 */
export async function applyAigcWatermark(
  input: Buffer,
  ext: string,
  opts: { timeoutMs?: number; maxVideoBytes?: number } = {},
): Promise<WatermarkResult> {
  const e = String(ext || "").toLowerCase();
  const skip = (reason: string): WatermarkResult => ({ buffer: input, watermarked: false, text: null, reason });
  if (!watermarkEnabled()) return skip("disabled");
  if (!input?.length) return skip("empty");
  if (!canWatermarkExt(e)) return skip("unsupported-ext:" + e);

  const image = isImageExt(e);
  const maxVideoBytes = Number(opts.maxVideoBytes ?? process.env.MEDIA_WATERMARK_MAX_VIDEO_BYTES ?? 200 * 1024 * 1024);
  if (!image && input.length > maxVideoBytes) return skip("video-too-large:" + input.length);

  const font = pickFont();
  const text = watermarkText();
  // 没有中文字体时退化成 ASCII 标识：宁可标识不完美，也不能让产物完全无标识。
  const useText = font ? text : "AI-GENERATED";
  const style = [
    // Windows 字体路径里的冒号是 ffmpeg filter 的参数分隔符，必须转义，否则整条 filter 解析失败。
    `fontfile='${escapeFilterValue(font ?? "")}'`,
    `text='${escapeFilterValue(useText)}'`,
    "fontcolor=white@0.88",
    image ? "fontsize=h/22" : "fontsize=h/24",
    "x=w-tw-20",
    "y=h-th-20",
    "box=1",
    "boxcolor=black@0.35",
    "boxborderw=8",
  ];
  if (!font) style.shift(); // 无字体文件时交给 fontconfig 默认字体
  const filter = "drawtext=" + style.join(":");

  const dir = await mkdtemp(join(tmpdir(), "aigcwm-"));
  try {
    const inPath = join(dir, "in." + e);
    const outExt = image ? (e === "jpeg" ? "jpg" : e) : "mp4";
    const outPath = join(dir, "out." + outExt);
    await writeFile(inPath, input);

    const args = image
      ? ["-hide_banner", "-loglevel", "error", "-y", "-i", inPath, "-vf", filter, "-frames:v", "1", outPath]
      : [
          "-hide_banner", "-loglevel", "error", "-y", "-i", inPath,
          "-vf", filter,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
          "-c:a", "copy", "-movflags", "+faststart",
          outPath,
        ];
    const timeoutMs = Number(opts.timeoutMs ?? (image ? 60000 : 600000));
    const res = await runFfmpeg(args, timeoutMs);
    if (!res.ok) return skip("ffmpeg-failed:" + res.stderr.replace(/\s+/g, " ").slice(0, 240));
    const out = await readFile(outPath);
    if (!out.length) return skip("empty-output");
    return { buffer: out, watermarked: true, text: useText };
  } catch (err: any) {
    return skip("error:" + String(err?.message || err).slice(0, 240));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 视频水印后容器变成 mp4，扩展名要跟着改，否则 OSS 上的 Content-Type 会骗客户端。 */
export function watermarkOutputExt(ext: string): string {
  const e = String(ext || "").toLowerCase();
  if (isImageExt(e)) return e === "jpeg" ? "jpg" : e;
  if (VIDEO_EXT.has(e)) return "mp4";
  return e;
}
