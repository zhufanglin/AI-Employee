#!/usr/bin/env node
/**
 * P16 音视频处理能力单测：
 * media_info 元数据、media_process 的 info/trim/extract_audio/transcode/compress/thumbnail/concat，
 * 以及参数校验、SSRF 守卫与工作区越权隔离。
 * 素材由本机 ffmpeg 现场合成（testsrc + sine），不联网下载。
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

const DEFAULT_FFMPEG = "C:\\Users\\30290\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.1-full_build\\bin\\ffmpeg.exe";
const FFMPEG = process.env.FFMPEG_PATH || DEFAULT_FFMPEG;
const FFPROBE = process.env.FFPROBE_PATH || path.join(path.dirname(FFMPEG), "ffprobe.exe");

if (!fs.existsSync(FFMPEG) || !fs.existsSync(FFPROBE)) {
  console.log("[FAIL] 找不到 ffmpeg/ffprobe：" + FFMPEG);
  process.exit(1);
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "p16-media-ws-"));
process.env.WORKSPACE_DIR = workspace;
process.env.WORKSPACE_UPLOAD_MAX_BYTES = "52428800";
process.env.PUBLIC_BASE_URL = "https://api.example.com";
process.env.FFMPEG_PATH = FFMPEG;
process.env.FFPROBE_PATH = FFPROBE;
process.env.OSS_ACCESS_KEY_ID = "";
process.env.OSS_ACCESS_KEY_SECRET = "";
process.env.OSS_BUCKET = "";
process.env.OSS_REGION = "";
process.env.OSS_ENDPOINT = "";

const media = require("../packages/server/dist/capabilities/capabilities/media-tools.js");
const files = require("../packages/server/dist/capabilities/capabilities/files.js");

const USER = "user-a";
const OTHER = "user-b";
let pass = 0;

function ok(name) { pass += 1; console.log("[PASS] " + name); }
function bad(name, detail) { console.log("[FAIL] " + name + " :: " + detail); process.exitCode = 1; }
function assert(condition, message) { if (!condition) throw new Error(message); }
function expectNear(actual, expected, tolerance, label) {
  assert(typeof actual === "number" && Number.isFinite(actual), label + " 不是数字：" + actual);
  assert(Math.abs(actual - expected) <= tolerance, label + " 期望 " + expected + "±" + tolerance + " 实际：" + actual);
}
async function check(name, fn) {
  try { await fn(); ok(name); } catch (error) { bad(name, error && error.message ? error.message : error); }
}
async function rejects(name, fn, needle) {
  try {
    await fn();
    bad(name, "未抛错");
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (needle && !message.includes(needle)) bad(name, "错误文案不含「" + needle + "」实际：" + message);
    else ok(name);
  }
}

async function main() {
  const fixturePath = path.join(workspace, "_fixture.mp4");
  const generated = spawnSync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=25",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    fixturePath,
  ], { encoding: "utf8" });
  if (generated.status !== 0) {
    console.log("[FAIL] 合成测试素材失败：" + String(generated.stderr || "").slice(-400));
    process.exitCode = 1;
    return;
  }

  const fixture = fs.readFileSync(fixturePath);
  const uploaded = await files.saveWorkspaceFile(USER, "测试素材.mp4", fixture);
  const second = await files.saveWorkspaceFile(USER, "测试素材B.mp4", fixture);
  const KEY = uploaded.file.key;
  const NAME = uploaded.file.name;

  await check("media_info 时长约 2 秒", async () => {
    const info = await media.handlers.media_info({ userId: USER, params: { source: KEY } });
    expectNear(info.durationSec, 2, 0.5, "durationSec");
  });

  await check("media_info 分辨率 320x240", async () => {
    const info = await media.handlers.media_info({ userId: USER, params: { source: NAME } });
    assert(info.video && info.video.width === 320 && info.video.height === 240, "分辨率不对：" + JSON.stringify(info.video));
  });

  await check("media_info 识别音频流与采样率", async () => {
    const info = await media.handlers.media_info({ userId: USER, params: { source: KEY } });
    assert(info.audio && info.audio.codec, "缺少音频流");
    assert(info.audio.sampleRate === 44100, "采样率不对：" + info.audio.sampleRate);
  });

  await check("media_info 返回容器格式与体积", async () => {
    const info = await media.handlers.media_info({ userId: USER, params: { source: KEY } });
    assert(info.formatName.includes("mp4"), "容器格式不对：" + info.formatName);
    assert(info.sizeBytes === fixture.byteLength, "sizeBytes 不对：" + info.sizeBytes);
  });

  await check("media_process op=info 返回同样的元数据", async () => {
    const info = await media.handlers.media_process({ userId: USER, params: { op: "info", source: KEY } });
    assert(info.op === "info", "op 不对：" + info.op);
    expectNear(info.durationSec, 2, 0.5, "info.durationSec");
  });

  let trimmed = null;
  await check("trim 截取 0.5s 输出存在且非空", async () => {
    trimmed = await media.handlers.media_process({ userId: USER, params: { op: "trim", source: KEY, start: 0.5, duration: 0.5 } });
    assert(trimmed.bytes > 0, "bytes 为 0");
    assert(trimmed.key.startsWith("workspace/" + USER + "/"), "key 前缀不对：" + trimmed.key);
  });

  await check("trim 输出时长落在 0.3-0.9 秒", async () => {
    const info = await media.handlers.media_info({ userId: USER, params: { source: trimmed.key } });
    assert(info.durationSec >= 0.3 && info.durationSec <= 0.9, "时长不在区间：" + info.durationSec);
  });

  let audio = null;
  await check("extract_audio 产出 mp3 且非空", async () => {
    audio = await media.handlers.media_process({ userId: USER, params: { op: "extract_audio", source: KEY, format: "mp3" } });
    assert(audio.bytes > 0, "bytes 为 0");
    assert(audio.name.endsWith(".mp3"), "文件名不是 mp3：" + audio.name);
  });

  await check("extract_audio 产物可被 ffprobe 识别为 mp3", async () => {
    const info = await media.handlers.media_info({ userId: USER, params: { source: audio.key } });
    assert(info.audio && info.audio.codec === "mp3", "音频编码不对：" + JSON.stringify(info.audio));
  });

  let webm = null;
  await check("transcode mp4→webm 成功且非空", async () => {
    webm = await media.handlers.media_process({ userId: USER, params: { op: "transcode", source: KEY, format: "webm" } });
    assert(webm.bytes > 0, "bytes 为 0");
    assert(webm.name.endsWith(".webm"), "文件名不是 webm：" + webm.name);
    const stored = path.join(workspace, USER, webm.key.slice(webm.key.lastIndexOf("/") + 1));
    assert(fs.existsSync(stored), "webm 没有落盘：" + stored);
  });

  await check("transcode 产物可被 ffprobe 识别为 webm", async () => {
    const info = await media.handlers.media_info({ userId: USER, params: { source: webm.key } });
    assert(info.formatName.includes("webm"), "容器格式不对：" + info.formatName);
    assert(info.video && info.video.codec, "缺少视频流");
  });

  let compressed = null;
  await check("compress crf=35 成功且非空", async () => {
    compressed = await media.handlers.media_process({ userId: USER, params: { op: "compress", source: KEY, crf: 35 } });
    assert(compressed.bytes > 0, "bytes 为 0");
    assert(compressed.name.endsWith(".mp4"), "文件名不是 mp4：" + compressed.name);
  });

  await check("compress 产物时长保持约 2 秒", async () => {
    const info = await media.handlers.media_info({ userId: USER, params: { source: compressed.key } });
    expectNear(info.durationSec, 2, 0.5, "压缩后时长");
    assert(info.video && info.video.width === 320, "压缩后分辨率不对：" + JSON.stringify(info.video));
  });

  let thumb = null;
  await check("thumbnail 截图输出 jpg 且非空", async () => {
    thumb = await media.handlers.media_process({ userId: USER, params: { op: "thumbnail", source: KEY, time: 0.5 } });
    assert(thumb.bytes > 0, "bytes 为 0");
    assert(thumb.name.endsWith(".jpg"), "文件名不是 jpg：" + thumb.name);
  });

  await check("thumbnail 产物是 320 宽的图片", async () => {
    const info = await media.handlers.media_info({ userId: USER, params: { source: thumb.key } });
    assert(info.video && info.video.width === 320, "图片宽度不对：" + JSON.stringify(info.video));
  });

  let merged = null;
  await check("concat 拼接两段 2 秒素材成功且非空", async () => {
    merged = await media.handlers.media_process({ userId: USER, params: { op: "concat", sources: [KEY, second.file.key], name: "拼接结果" } });
    assert(merged.bytes > 0, "bytes 为 0");
    assert(merged.name === "拼接结果-concat.mp4", "输出名不对：" + merged.name);
  });

  await check("concat 输出时长约等于两段之和（4s±1s）", async () => {
    const info = await media.handlers.media_info({ userId: USER, params: { source: merged.key } });
    expectNear(info.durationSec, 4, 1, "拼接后时长");
  });

  await rejects("op 非法被拒", () => media.handlers.media_process({ userId: USER, params: { op: "explode", source: KEY } }), "op 非法");
  await rejects("source 缺失被拒", () => media.handlers.media_process({ userId: USER, params: { op: "trim", duration: 1 } }), "source 必填");
  await rejects("内网 URL 被 SSRF 守卫拒绝", () => media.handlers.media_process({ userId: USER, params: { op: "info", source: "http://127.0.0.1:1/x.mp4" } }), "禁止访问内网或保留地址");
  await rejects("越权读取他人工作区 key 被拒", () => media.handlers.media_info({ userId: OTHER, params: { source: KEY } }), "无权访问");
  await rejects("concat 少于 2 个源被拒", () => media.handlers.media_process({ userId: USER, params: { op: "concat", sources: [KEY] } }), "至少需要 2 个源");
  await rejects("trim duration 超过 600 秒被拒", () => media.handlers.media_process({ userId: USER, params: { op: "trim", source: KEY, duration: 601 } }), "不能超过 600 秒");
  await rejects("extract_audio format 不在白名单被拒", () => media.handlers.media_process({ userId: USER, params: { op: "extract_audio", source: KEY, format: "aac" } }), "format 可选");
  await rejects("compress crf 超出 18-40 被拒", () => media.handlers.media_process({ userId: USER, params: { op: "compress", source: KEY, crf: 50 } }), "crf 必须是 18-40");
  await rejects("thumbnail 不存在的源文件被拒", () => media.handlers.media_process({ userId: USER, params: { op: "thumbnail", source: "不存在.mp4" } }), "源文件不存在");
}

try {
  await main();
} catch (error) {
  console.log("[FAIL] 未捕获异常 :: " + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}

if (process.exitCode) {
  console.log("P16 media SMOKE FAILED (" + pass + " checks passed)");
  process.exit(1);
} else {
  console.log("P16 media SMOKE OK (" + pass + " checks)");
  process.exit(0);
}
