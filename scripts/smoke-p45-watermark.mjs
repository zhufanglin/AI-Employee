#!/usr/bin/env node
// P45-1 媒体 AIGC 显式水印冒烟（零依赖，真跑 ffmpeg）
// 前置：packages/server 已 tsc 编译（读取 packages/server/dist/media/watermark.js）
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const wm = require("../packages/server/dist/media/watermark.js");

let pass = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass++; console.log("  ok   " + name); }
  else { failures.push(name + (extra ? " -> " + extra : "")); console.log("  FAIL " + name + (extra ? " -> " + extra : "")); }
}

function has(cmd) {
  const r = spawnSync(cmd, ["-hide_banner", "-version"], { encoding: "utf8" });
  return r.status === 0;
}
function ff(args) {
  return spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
}
function yStats(file) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", "signalstats,metadata=print:file=-", "-f", "null", "-"], { encoding: "utf8" });
  const text = (r.stdout || "") + (r.stderr || "");
  const pick = (k) => {
    const m = text.match(new RegExp("signalstats\\." + k + "=([\\d.]+)"));
    return m ? Number(m[1]) : null;
  };
  return { yavg: pick("YAVG"), ymax: pick("YMAX"), ymin: pick("YMIN") };
}

if (!has("ffmpeg")) {
  console.log("SKIP: 本机没有 ffmpeg，跳过水印实跑（生产环境由部署脚本保证）");
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "wm-smoke-"));
try {
  console.log("[1] 纯函数与开关");
  check("watermarkEnabled() 默认开", wm.watermarkEnabled() === true);
  check("watermarkText() 默认 AI生成", wm.watermarkText() === "AI生成", wm.watermarkText());
  const font = wm.pickFont();
  check("pickFont() 找到中文字体", typeof font === "string" && existsSync(font), String(font));
  check("canWatermarkExt(png)", wm.canWatermarkExt("png") === true);
  check("canWatermarkExt(mp4)", wm.canWatermarkExt("mp4") === true);
  check("canWatermarkExt(txt) 为假", wm.canWatermarkExt("txt") === false);
  check("watermarkOutputExt(mov) = mp4", wm.watermarkOutputExt("mov") === "mp4");
  check("watermarkOutputExt(jpeg) = jpg", wm.watermarkOutputExt("jpeg") === "jpg");
  check("watermarkOutputExt(png) = png", wm.watermarkOutputExt("png") === "png");

  console.log("[2] 图片水印（黑色底图 + 角标）");
  const imgPath = join(dir, "base.png");
  const r1 = ff(["-f", "lavfi", "-i", "color=c=black:s=480x270:d=1", "-frames:v", "1", imgPath]);
  check("生成测试底图", r1.status === 0 && existsSync(imgPath), r1.stderr);
  const baseBuf = readFileSync(imgPath);
  const baseStats = yStats(imgPath);
  check("底图是纯黑（YMAX 很低）", baseStats.ymax !== null && baseStats.ymax <= 30, JSON.stringify(baseStats));

  const out = await wm.applyAigcWatermark(baseBuf, "png");
  check("图片水印成功", out.watermarked === true, out.reason);
  check("图片水印文字 = AI生成", out.text === "AI生成", String(out.text));
  check("图片产物非空且不同", out.buffer.length > 0 && !out.buffer.equals(baseBuf));
  const outPath = join(dir, "marked.png");
  const { writeFileSync } = require("node:fs");
  writeFileSync(outPath, out.buffer);
  const outStats = yStats(outPath);
  check("角标真的画上去了（YMAX 变亮）", outStats.ymax !== null && outStats.ymax >= 200, JSON.stringify(outStats));
  check("画布尺寸未变", spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", outPath, "-f", "null", "-"], { encoding: "utf8" }).status === 0);

  console.log("[3] 视频水印（2 秒测试源 → mp4）");
  const vidPath = join(dir, "base.mp4");
  const r2 = ff(["-f", "lavfi", "-i", "testsrc=size=320x180:rate=15:duration=2", "-pix_fmt", "yuv420p", vidPath]);
  check("生成测试视频", r2.status === 0 && existsSync(vidPath), r2.stderr);
  const vidBuf = readFileSync(vidPath);
  const vout = await wm.applyAigcWatermark(vidBuf, "mp4", { timeoutMs: 120000 });
  check("视频水印成功", vout.watermarked === true, vout.reason);
  check("视频产物是 mp4（ftyp 头）", vout.buffer.includes(Buffer.from("ftyp")), "no ftyp");
  check("视频产物比原文件小/不同", !vout.buffer.equals(vidBuf));
  check("watermarkOutputExt(mp4) 一致", wm.watermarkOutputExt("mp4") === "mp4");

  console.log("[4] 开关关闭 / 不支持的扩展 / 空内容");
  process.env.MEDIA_WATERMARK = "0";
  const off = await wm.applyAigcWatermark(baseBuf, "png");
  check("MEDIA_WATERMARK=0 直接跳过", off.watermarked === false && off.reason === "disabled" && off.buffer.equals(baseBuf), off.reason);
  process.env.MEDIA_WATERMARK = "1";
  const txt = await wm.applyAigcWatermark(Buffer.from("hello"), "txt");
  check("不支持的扩展跳过", txt.watermarked === false && String(txt.reason).startsWith("unsupported-ext"), String(txt.reason));
  const empty = await wm.applyAigcWatermark(Buffer.alloc(0), "png");
  check("空内容跳过", empty.watermarked === false && empty.reason === "empty", String(empty.reason));

  console.log("[5] 自定义水印文字");
  process.env.MEDIA_WATERMARK_TEXT = "AI 生成 · 中科元晟";
  check("watermarkText() 读取 env", wm.watermarkText() === "AI 生成 · 中科元晟", wm.watermarkText());
  const custom = await wm.applyAigcWatermark(baseBuf, "png");
  check("自定义文字生效", custom.watermarked === true && custom.text === "AI 生成 · 中科元晟", String(custom.text));
  delete process.env.MEDIA_WATERMARK_TEXT;

  console.log("");
  if (failures.length) {
    console.log("WATERMARK SMOKE FAILED (" + failures.length + " failed, " + pass + " passed)");
    for (const f of failures) console.log("  - " + f);
    process.exitCode = 1;
  } else {
    console.log("WATERMARK SMOKE OK (" + pass + " checks, 0 failed)");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
