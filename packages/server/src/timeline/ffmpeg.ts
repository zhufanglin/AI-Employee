import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * 注意：本机沙箱里 Node 无法用管道（stdio:"pipe"）拉起子进程（spawn EPERM），
 * 所以这里一律把 stdout/stderr 重定向到临时文件。这也是 Windows 生产机上最稳的写法。
 */

export interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

/** 跑一个子进程，stdout/stderr 落文件；返回 { code, stdout, stderr } */
export function runToFile(
  bin: string,
  args: string[],
  tmpDir: string,
  tag: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const outPath = join(tmpDir, `${tag}.out.log`);
  const errPath = join(tmpDir, `${tag}.err.log`);
  return new Promise((resolve) => {
    const outFd = openSync(outPath, "w");
    const errFd = openSync(errPath, "w");
    let settled = false;
    const done = (code: number, message?: string) => {
      if (settled) return;
      settled = true;
      try { closeSync(outFd); } catch { /* ignore */ }
      try { closeSync(errFd); } catch { /* ignore */ }
      const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
      resolve({ code, stdout: read(outPath), stderr: message || read(errPath) });
    };
    const child = spawn(bin, args, { stdio: ["ignore", outFd, errFd], windowsHide: true });
    child.on("error", (error: any) => done(-1, String(error?.message || error)));
    child.on("close", (code) => done(code ?? -1));
  });
}

/** ffprobe 取时长/分辨率/有无音轨 */
export async function probe(file: string, tmpDir: string): Promise<ProbeResult> {
  if (!existsSync(file)) throw new Error(`文件不存在：${file}`);
  const res = await runToFile(
    FFPROBE,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    tmpDir,
    `probe_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
  );
  if (res.code !== 0) throw new Error(`ffprobe 失败：${res.stderr.slice(-400)}`);
  const info = JSON.parse(res.stdout || "{}");
  const streams: any[] = info.streams || [];
  const v = streams.find((s) => s.codec_type === "video");
  const hasAudio = streams.some((s) => s.codec_type === "audio");
  if (!v && !hasAudio) throw new Error("素材里没有音视频轨");
  const duration = Number(v?.duration || info.format?.duration || 0);
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    width: Number(v?.width || 0),
    height: Number(v?.height || 0),
    hasAudio,
    hasVideo: Boolean(v),
  };
}

export interface RunOptions {
  tmpDir: string;
  tag: string;
  /** 成片总时长（秒），用于把 ffmpeg out_time 换算成 0-1 进度 */
  totalDuration?: number;
  onProgress?: (ratio: number) => void;
  timeoutMs?: number;
}

/** 跑 ffmpeg：-progress 写文件、定时读（不用管道）；失败时回传 stderr 尾部 */
export function runFfmpeg(args: string[], opts: RunOptions): Promise<{ code: number; stderr: string }> {
  const progressPath = join(opts.tmpDir, `${opts.tag}.progress.log`);
  const errPath = join(opts.tmpDir, `${opts.tag}.ffmpeg.err.log`);
  const outPath = join(opts.tmpDir, `${opts.tag}.ffmpeg.out.log`);
  const fullArgs = ["-hide_banner", "-y", "-nostats", "-progress", progressPath, ...args];
  return new Promise((resolve) => {
    const outFd = openSync(outPath, "w");
    const errFd = openSync(errPath, "w");
    let settled = false;
    let killer: NodeJS.Timeout | null = null;
    let ticker: NodeJS.Timeout | null = null;

    const done = (code: number, message?: string) => {
      if (settled) return;
      settled = true;
      if (ticker) clearInterval(ticker);
      if (killer) clearTimeout(killer);
      try { closeSync(outFd); } catch { /* ignore */ }
      try { closeSync(errFd); } catch { /* ignore */ }
      let stderr = message || "";
      if (!stderr) { try { stderr = readFileSync(errPath, "utf8"); } catch { /* ignore */ } }
      for (const p of [progressPath, outPath]) {
        try { if (statSync(p).isFile() && statSync(p).size === 0) unlinkSync(p); } catch { /* ignore */ }
      }
      resolve({ code, stderr });
    };

    const child = spawn(FFMPEG, fullArgs, { stdio: ["ignore", outFd, errFd], windowsHide: true });
    child.on("error", (error: any) => done(-1, String(error?.message || error)));
    child.on("close", (code) => done(code ?? -1));

    if (opts.onProgress && opts.totalDuration) {
      ticker = setInterval(() => {
        try {
          if (!existsSync(progressPath)) return;
          const text = readFileSync(progressPath, "utf8");
          const matches = [...text.matchAll(/out_time_ms=(\d+)/g)];
          if (!matches.length) return;
          const us = Number(matches[matches.length - 1][1]);
          const ratio = Math.min(0.99, us / 1e6 / (opts.totalDuration as number));
          if (Number.isFinite(ratio)) opts.onProgress!(Math.max(0, ratio));
        } catch { /* 读取竞态，忽略 */ }
      }, 1000);
    }
    if (opts.timeoutMs) {
      killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, opts.timeoutMs);
    }
  });
}
