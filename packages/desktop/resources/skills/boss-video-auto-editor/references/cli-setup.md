# 视频CLI配置与数据格式

## 依赖

- 必需：`ffmpeg`、`ffprobe`
- 推荐：`whisper`命令行，用于带时间码的转写和SRT
- 可选：`auto-editor`，用于先按静音做口播粗剪

客户自行安装并确认这些命令能在终端直接运行。Skill不保存任何账号密钥。

## 自检

```bash
python .agents/skills/boss-video-auto-editor/scripts/video_cli.py check
```

## segments.json

时间接受秒数或 `HH:MM:SS.mmm`。

```json
[
  {
    "start": "00:00:12.500",
    "end": "00:00:48.000",
    "title": "客户为什么总说考虑一下",
    "output": "01-consider.mp4"
  }
]
```

## 渲染

```bash
python .agents/skills/boss-video-auto-editor/scripts/video_cli.py render-segments \
  --input /absolute/source.mp4 \
  --segments /absolute/segments.json \
  --output-dir /absolute/output \
  --format vertical
```

加入字幕时增加 `--subtitles /absolute/subtitles.srt`。整片字幕时间码在拆条后可能不匹配，优先为每个片段生成独立SRT。

## 自动删静音

```bash
python .agents/skills/boss-video-auto-editor/scripts/video_cli.py auto-cut \
  --input /absolute/source.mp4 \
  --output /absolute/output/rough.mp4
```

该命令调用客户已安装的`auto-editor`。生成的是粗剪，必须复核。
