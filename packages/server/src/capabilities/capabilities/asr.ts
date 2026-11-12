import { BadRequestException } from "@nestjs/common";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CapabilityDescriptor, CapabilityHandler } from "../capability.types";
import { env } from "../../common/env";
import { saveWorkspaceFile } from "./files";
import { ensureTempDir, ffmpegBinary, prepareSource, probeMedia } from "./media-tools";

/**
 * 语音转写：把音频/视频转成中文文字稿（faster-whisper CPU，本机推理，不依赖外部付费接口）。
 * 剪辑类员工用它「听懂素材」，运营类员工用它把会议/访谈/直播录音变成可编辑的文字。
 */
export const descriptors: CapabilityDescriptor[] = [
  {
    name: "transcribe",
    title: "语音转文字（听素材/出字幕）",
    category: "media",
    description: "把工作区或公网地址里的音频/视频转成文字稿（可带时间轴），用于听懂素材、生成口播字幕、整理会议与访谈",
    params: {
      source: "必填，工作区 key、工作区文件名或 http(s) 地址（音频或视频都可以）",
      language: "可选，zh | en | auto，默认 zh",
      timestamps: "可选，是否返回分段时间轴，默认 false",
      save: "可选，是否把文字稿存回工作区（转写-xxx.md），默认 true",
      name: "可选，保存的文件基础名（不含扩展名）",
    },
  },
];

const MAX_SECONDS = Number(env("ASR_MAX_SECONDS", "1800")) || 1800;
const TIMEOUT_MS = Number(env("ASR_TIMEOUT_MS", "540000")) || 540000;
const MAX_TEXT_CHARS = 40000;
const MAX_SEGMENTS = 400;

function enabled(): boolean {
  const raw = String(env("ASR_ENABLED", "1") ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

function pythonPath(): string {
  return String(env("ASR_PYTHON", "") ?? "").trim() || "/opt/fcmediaagent/asr/venv/bin/python";
}

function scriptPath(): string {
  return String(env("ASR_SCRIPT", "") ?? "").trim() || "/opt/fcmediaagent/asr/bin/transcribe_cli.py";
}

function modelName(): string {
  return String(env("ASR_MODEL", "") ?? "").trim() || "small";
}

function modelDir(): string {
  return String(env("ASR_MODEL_DIR", "") ?? "").trim() || "/opt/fcmediaagent/asr/models";
}

function threads(): number {
  const parsed = Number(env("ASR_THREADS", "4"));
  if (!Number.isFinite(parsed) || parsed < 1) return 4;
  return Math.min(16, Math.trunc(parsed));
}

/** 跑了外部 python，参数数组直传不过 shell；超时 kill。 */
async function runPython(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let child: any;
    try {
      child = spawn(pythonPath(), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error: any) {
      reject(new BadRequestException("语音识别引擎启动失败：" + (error?.message || String(error))));
      return;
    }
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    }, TIMEOUT_MS);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 20000) stderr = stderr.slice(-10000);
    });
    child.stdout?.resume();
    child.on("error", (error: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error?.code === "ENOENT") {
        reject(new BadRequestException("本机没有语音识别引擎（" + pythonPath() + " 不存在）。生产环境已内置，可用 ASR_PYTHON / ASR_SCRIPT 指定路径"));
        return;
      }
      reject(new BadRequestException("语音识别引擎启动失败：" + (error?.message || String(error))));
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new BadRequestException("语音识别超时（" + Math.trunc(TIMEOUT_MS / 1000) + " 秒），请缩短素材或调高 ASR_TIMEOUT_MS"));
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300);
        reject(new BadRequestException("语音识别失败：" + (detail || "退出码 " + code)));
        return;
      }
      resolve();
    });
  });
}

function normalizeBase(raw: any, fallback: string): string {
  let base = String(raw ?? "").trim().replace(/\\/g, "/");
  base = base.slice(base.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot > 0) base = base.slice(0, dot);
  base = base.replace(/[^\w\u4e00-\u9fa5.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  if (!base) base = fallback;
  return base.slice(0, 60);
}

function stamp(seconds: number): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : pad(m) + ":" + pad(s);
}

function buildMarkdown(title: string, data: any, withTimeline: boolean): string {
  const lines: string[] = [];
  lines.push("# 转写：" + title);
  lines.push("");
  const meta: string[] = [];
  if (data.durationSec) meta.push("时长 " + stamp(data.durationSec));
  if (data.model) meta.push("模型 " + data.model);
  if (data.language) meta.push("语言 " + data.language);
  meta.push("字数 " + String(data.text || "").length);
  lines.push("> " + meta.join(" · "));
  lines.push("");
  lines.push("## 全文");
  lines.push("");
  lines.push(String(data.text || "").trim() || "（没有识别到语音内容）");
  if (withTimeline && Array.isArray(data.segments) && data.segments.length) {
    lines.push("");
    lines.push("## 时间轴");
    lines.push("");
    for (const seg of data.segments.slice(0, MAX_SEGMENTS)) {
      lines.push("- [" + stamp(seg.start) + " - " + stamp(seg.end) + "] " + String(seg.text || "").trim());
    }
  }
  lines.push("");
  return lines.join("\n");
}

export const handlers = {
  transcribe: async ({ userId, params }: any) => {
    const p = params ?? {};
    const sourceRaw = String(p.source ?? "").trim();
    if (!sourceRaw) throw new BadRequestException("source 必填，可填工作区 key、工作区文件名或 http(s) 地址");
    if (!enabled()) throw new BadRequestException("语音转写能力已关闭（ASR_ENABLED=0）");
    const python = pythonPath();
    const script = scriptPath();
    if (!existsSync(python) || !existsSync(script)) {
      throw new BadRequestException("本机没有安装语音识别引擎（faster-whisper），可用 ASR_PYTHON / ASR_SCRIPT 指定路径；生产环境已内置");
    }

    const withTimeline = p.timestamps === true || String(p.timestamps ?? "").toLowerCase() === "true";
    const shouldSave = !(p.save === false || String(p.save ?? "").toLowerCase() === "false");
    const rawLanguage = String(p.language ?? "zh").trim().toLowerCase();
    const language = ["zh", "en", "auto"].includes(rawLanguage) ? rawLanguage : "zh";

    const dir = await ensureTempDir();
    try {
      const source = await prepareSource(userId, sourceRaw, dir, 0);
      const probe = await probeMedia(source.path);
      if (!probe.audio) throw new BadRequestException("源文件没有音频轨，无法转写");
      if (probe.durationSec && probe.durationSec > MAX_SECONDS) {
        throw new BadRequestException("素材时长 " + stamp(probe.durationSec) + " 超过单次转写上限 " + stamp(MAX_SECONDS) + "，请先用 media_process 切成小段");
      }

      const wav = join(dir, "asr-input.wav");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(ffmpegBinary(), ["-y", "-i", source.path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); if (stderr.length > 8000) stderr = stderr.slice(-4000); });
        child.on("error", (error: any) => reject(new BadRequestException("ffmpeg 启动失败：" + (error?.message || String(error)))));
        child.on("close", (code: number | null) => {
          if (code === 0) { resolve(); return; }
          reject(new BadRequestException("提取音轨失败：" + (stderr.trim().split(/\r?\n/).slice(-2).join(" ").slice(0, 300) || "退出码 " + code)));
        });
      });

      const outJson = join(dir, "asr-result.json");
      const args = [
        script,
        "--input", wav,
        "--out", outJson,
        "--model", modelName(),
        "--model-dir", modelDir(),
        "--language", language,
        "--threads", String(threads()),
      ];
      await runPython(args);

      const parsed = JSON.parse(await readFile(outJson, "utf8"));
      if (!parsed || parsed.ok !== true) {
        throw new BadRequestException("语音识别失败：" + String(parsed?.error || "未知错误"));
      }
      const text = String(parsed.text || "").trim();
      const result: any = {
        ok: true,
        text: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) + "…（文字过长已截断）" : text,
        chars: text.length,
        durationSec: Number(parsed.durationSec) || probe.durationSec || 0,
        model: String(parsed.model || modelName()),
        language: String(parsed.language || language),
        elapsedMs: Number(parsed.elapsedMs) || null,
      };
      if (withTimeline) {
        result.segments = (Array.isArray(parsed.segments) ? parsed.segments : []).slice(0, MAX_SEGMENTS).map((seg: any) => ({
          start: Number(seg.start) || 0,
          end: Number(seg.end) || 0,
          text: String(seg.text || ""),
        }));
      }
      if (!text) result.note = "没有识别到语音内容，可能素材里没有人声";

      if (shouldSave) {
        const base = normalizeBase(p.name, normalizeBase(source.name, "素材"));
        const name = "转写-" + base + ".md";
        const saved = await saveWorkspaceFile(userId, name, Buffer.from(buildMarkdown(source.name, { ...parsed, text, model: result.model, language: result.language }, withTimeline), "utf8"));
        result.file = { name: saved.file.name, key: saved.file.key, bytes: saved.file.bytes, url: saved.url };
      }
      return result;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  },
} as Record<string, CapabilityHandler>;
