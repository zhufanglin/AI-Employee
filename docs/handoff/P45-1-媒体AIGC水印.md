# P45-1 媒体产出 AIGC 显式水印

> 法规依据：《人工智能生成合成内容标识办法》（2025-09-01 施行）要求生成内容带**显式标识**（用户可感知）与**隐式标识**（文件元数据）。
> 本文档记录服务端在媒体归档环节给图片/视频打水印的实现、验证方式与已知限制。

## 1. 结论

- 位置：`packages/server/src/media/media.service.ts` 的 `archiveResult()`，即 RunningHub 结果下载后、上传 OSS 前。
- 显式标识：右下角 "AI生成" 文字角标（黑底 35% 透明框）。
- 隐式标识：OSS 对象 metadata `aigc-generated=true`、`aigc-watermark=1|0`。
- 开关：`MEDIA_WATERMARK=1`（默认开，`0` 关闭）；文案 `MEDIA_WATERMARK_TEXT`（默认 "AI生成"）；字体 `MEDIA_WATERMARK_FONT`。
- 接口返回：`getTask()` / `webhook()` 的 `resultMeta` 会带 `watermark: { watermarked, text, reason? }`，前端可展示"已加 AI 标识"。

## 2. 实现（`packages/server/src/media/watermark.ts`）

导出函数：

| 函数 | 说明 |
| --- | --- |
| `watermarkEnabled()` | 读 `MEDIA_WATERMARK`，默认 `"1"` |
| `watermarkText()` | 读 `MEDIA_WATERMARK_TEXT`，默认 `"AI生成"` |
| `pickFont()` | `MEDIA_WATERMARK_FONT` → Noto CJK（`/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc`）→ wqy → `C:/Windows/Fonts/msyh.ttc` → `simhei.ttf` |
| `canWatermarkExt(ext)` | 图片 png/jpg/jpeg/webp/bmp；视频 mp4/mov/m4v/webm/mkv |
| `applyAigcWatermark(input, ext, opts?)` | 返回 `{ buffer, watermarked, text, reason? }`；**任何失败都返回原 buffer 不抛** |
| `watermarkOutputExt(ext)` | 视频统一输出 mp4 |

细节：

- 图片：`drawtext` 单帧重编码；`fontsize=h/22`。
- 视频：`fontsize=h/24`，重编码 `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a copy -movflags +faststart`；超过 200MB 直接跳过（`reason=too-large`）。
- 位置统一 `x=w-tw-20:y=h-th-20`，`box=1:boxcolor=black@0.35:boxborderw=8`。
- 找不到中文字体时降级为 "AI-GENERATED"（ASCII），保证角标一定画上。

### ffmpeg filter 转义（踩过的坑）

Windows 字体路径的盘符冒号会被 ffmpeg filter 解析器当参数分隔符，整条 filter 报
`No option name near '/Windows/Fonts/msyh.ttc:...'`。

实测四种写法（`_probe/wm-escape.mjs` 用 spawnSync 逐个跑）：

| 写法 | 结果 |
| --- | --- |
| `fontfile='C\:/path'`（单反斜杠 + 单引号） | exit 0 |
| `fontfile=C\\:/path`（双反斜杠、不加引号） | exit 0 |
| `fontfile=C\:/path` | 失败 |
| `fontfile='C\\\\:/path'` | 失败 |

最终实现 `escapeFilterValue()`（`\`→`\\`、`:`→`\:`、`,`→`\,`、去掉 `'`），filter 里写
`fontfile='${escapeFilterValue(font)}'`。

## 3. 验证

`node scripts/smoke-p45-watermark.mjs` → `WATERMARK SMOKE OK (26 checks, 0 failed)`

覆盖：

1. 纯函数（开关默认值、文字默认值、扩展名判定、输出扩展）；
2. 黑底测试图打水印后 **YMAX ≥ 200**（证明角标真的画上像素了，不是只返回 true）；
3. 2 秒测试视频 → 输出 `ftyp` 头为 mp4；
4. `MEDIA_WATERMARK=0` 时原样返回；
5. 不支持的扩展名、空内容、自定义文字。

无 ffmpeg 的环境脚本自动 `SKIP` 并 exit 0（服务器/CI 都能过）。

## 4. 生产环境要求

- 服务器装 ffmpeg（`ffmpeg -version` 可用）。
- **中文字体**：`apt-get install -y fonts-noto-cjk` → `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc`（19.4MB）。
  实测对比：Noto 输出 3024B / YAVG=24.11 / YMAX=235；无字体（DejaVu）1176B / YAVG=21.54 —— 中文会变方块，所以必须装。
- 部署脚本 `_deploy/p45e-server.sh` 第 8 步会检查 ffmpeg 与 Noto 字体是否在位。

## 5. 已知限制

- 视频重编码会增加 CPU 与耗时（短视频可接受；200MB 以上跳过并记 `reason`）。
- 只做"右下角文字角标"，不做不可见盲水印/数字指纹（《标识办法》的隐式标识通过 OSS metadata 满足元数据层面要求）。
- 历史已产出文件不会回溯补标。
