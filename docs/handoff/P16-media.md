# P16 音视频处理能力（media-tools）

## 为什么做

P16 之前员工只能"生成"视频（文生视频/图生视频），不能"处理"已有素材：拿到一段用户上传的 mp4 无法剪掉片头、无法抽音轨、无法转成 webm、无法截封面、无法把两段拼起来。本批补齐两个原子能力：

- `media_process`：对工作区素材或公网 URL 做探测、剪辑、抽音轨、转码、压缩、截图、拼接；
- `media_info`：读取音视频元数据，供员工在动手前判断时长/分辨率/编码。

全部通过本机 ffmpeg/ffprobe 子进程完成，参数以数组直传，不拼接 shell 命令；产物落回当前用户工作区，复用 P12 的 `saveWorkspaceFile` 与下载链接体系。

## 文件

| 文件 | 说明 |
| --- | --- |
| `packages/server/src/capabilities/capabilities/media-tools.ts` | 能力实现，导出 `descriptors` / `handlers` |
| `scripts/smoke-p16-media.mjs` | 单测（26 项断言） |
| `docs/handoff/P16-media.md` | 本文档 |

按分工要求，**没有**改 `capability.service.ts`。接入时需要把 `mediaDescriptors` 合并进 `descriptors`、把 `mediaHandlers` 展开进 `handlers`（与 files/docs 同样的两行）。

## 能力一：media_process

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `op` | 是 | `info` / `trim` / `extract_audio` / `transcode` / `compress` / `thumbnail` / `concat` |
| `source` | 非 concat 必填 | 工作区 key（`workspace/<userId>/...`）、工作区文件名，或 `http(s)` URL |
| `sources` | concat 必填 | 数组，2-10 个源，元素同 `source` |
| `start` | 否 | 起始秒数（trim/thumbnail/gif），默认 0，不能为负 |
| `duration` | trim 必填 | 截取秒数，需 >0 且 ≤600；其它 op 传入时同样校验 |
| `format` | 否 | `extract_audio`：`mp3`/`wav`/`m4a`，默认 `mp3`；`transcode`：`mp4`/`webm`/`mp3`/`wav`/`m4a`/`gif`，默认 `mp4` |
| `crf` | 否 | `compress` 画质 18-40，默认 28，非整数会被截断 |
| `time` | 否 | `thumbnail` 截图时间，默认 1 秒 |
| `name` | 否 | 输出基础名（不含扩展名）；默认"源文件名+后缀" |

行为：

- `info`：只探测，不产生文件，返回 `{ op, name, durationSec, sizeBytes, formatName, video?, audio? }`；
- `trim`：按 `start` + `duration` 重编码截取；有视频流输出 mp4，纯音频按源扩展名（mp3/wav/m4a）或回落 mp3；
- `extract_audio`：去掉视频轨，按 `format` 输出 mp3/wav/m4a；
- `transcode`：按 `format` 转码；`gif` 会按 `start`/`duration` 截取并转 10fps、480 宽动图；
- `compress`：libx264 + crf 重编码为 mp4（音频 aac 128k）；
- `thumbnail`：在 `start + time` 秒处截一帧 jpg（默认 1 秒），源无视频流直接报错；
- `concat`：先把每段归一成同分辨率/帧率/声道的中间 mp4（无音频补静音、无视频补黑场），再用 concat demuxer 无损拼接；全为音频时归一成 48kHz 立体声 wav 后拼接。纯视频拼接输出 mp4，纯音频拼接输出 wav。

成功返回 `{ op, name, bytes, key, url, durationSec? }`（thumbnail 与 info 无 durationSec）。

## 能力二：media_info

参数：`{ source }`，源解析规则同 `media_process`。内部执行：

`ffprobe -v error -print_format json -show_format -show_streams <临时文件>`

返回 `{ durationSec, sizeBytes, formatName, video?: { codec, width, height, fps }, audio?: { codec, channels, sampleRate } }`。文件不存在、越权、非音视频或 ffprobe 解析失败均抛 `BadRequestException`。

## 限制与安全边界

- **只读工作区自家文件**：源走 `resolveWorkspaceFile`，key 必须以 `workspace/<userId>/` 开头，否则 `localPathFor` 抛"无权访问该文件"；不会读取其他用户文件。
- **URL 源 SSRF 守卫**：复用 `web-extract.ts` 的 `pickPublicAddress`（内部用 `isDenied` 的 IPv4/IPv6 拒绝表），拒绝内网/回环/保留/组播地址；DNS 解析结果固定进 http(s) 请求的 `lookup`，防 DNS 重绑定；最多 3 次重定向，每一跳都重新校验；超时 60 秒；下载上限 200MB（Content-Length 与实际字节双重检查）。
- **输入/输出上限**：输入（工作区与 URL）≤200MB；ffmpeg 输出 ≤120MB，超过抛"输出文件超过 120MB 限制"。注意 `saveWorkspaceFile` 自身还受 `WORKSPACE_UPLOAD_MAX_BYTES`（默认 20MB）约束，生产需要处理大文件时应调高该环境变量。
- **执行隔离**：`spawn(二进制, 参数数组)`，不经过 shell；ffmpeg 单次超时 300 秒，超时 `SIGKILL`；临时目录为 `os.tmpdir()/p16-media-<uuid>`，每次调用结束 `rm -rf`，失败路径同样清理。
- **路径安全**：输出名由 `sanitizeBase` 清洗（去路径分隔符、控制字符、首尾点/横线，截断 60 字），最终仍由 `saveWorkspaceFile` 的 `checkName` 再校验；临时文件名全部由代码生成，不拼接用户输入。
- **文件名白名单缺口（需要 lead 知道）**：`files.ts` 的 `UPLOAD_EXTS` 目前没有 `.webm` 与 `.gif`，但本能力按需求要产出这两种格式。实现上先调用 `saveWorkspaceFile`，仅当错误为"不支持的文件类型"时，走本地兜底：仍写入 `workspace/<userId>/<uuid>-<文件名>`（路径由 `userDir`/`storedName` 生成），并尽力上传 OSS、返回 `ossPublicUrl`。若后续在 `files.ts` 补上 `.webm`/`.gif`，该兜底自动不再触发，无需改本文件。
- **未新增依赖**：只用 Node 内置模块、Nest `BadRequestException` 与已有 `files.ts` / `web-extract.ts`。
- **FFmpeg 定位**：`FFMPEG_PATH`（默认 `ffmpeg`）、`FFPROBE_PATH`（默认 `ffprobe`）。spawn ENOENT 时抛"服务器未安装 ffmpeg，可用 FFMPEG_PATH 指定路径"（ffprobe 缺失时文案提示 `FFPROBE_PATH`）。生产 Ubuntu 需自行安装 ffmpeg。

## 验证结果

环境：Windows，Node v24.22.1，ffmpeg/ffprobe 9.0.1-full_build。

1. 类型检查（仓库根）：

   `NODE node_modules\typescript\bin\tsc -p packages\server\tsconfig.json` → **exit 0**，无输出，产物写入 `packages/server/dist`。

2. 单测（仓库根）：

   `NODE scripts\smoke-p16-media.mjs` → **exit 0**，最后一行：

   `P16 media SMOKE OK (26 checks)`

   测试素材由 ffmpeg 现场合成：`testsrc` 2 秒 320x240 25fps + `sine` 440Hz 音频，H.264/AAC，31,978 字节；`WORKSPACE_DIR` 指向 `%TEMP%` 下临时目录，结束后删除。

   真实产物数字：

   | 操作 | 输出 | 体积 | 探测时长 |
   | --- | --- | --- | --- |
   | trim（start=0.5, duration=0.5） | fx-trim.mp4 | 14,669 B | 0.52 s |
   | extract_audio（mp3） | fx-audio.mp3 | 33,164 B | 2.0 s |
   | transcode（webm/vp9+opus） | fx-webm.webm | 60,345 B | 2.008 s |
   | compress（crf=35） | fx-compressed.mp4 | 38,634 B | 2.0 s |
   | thumbnail（time=0.5） | fx-thumb.jpg | 9,288 B | 320 宽图片 |
   | concat（2 段各 2s） | merged-concat.mp4 | 94,975 B | 4.021 s |

   覆盖的 26 项断言包括：info 时长≈2s、320x240、音频流/44100Hz、容器 mp4 与体积；trim 输出与 0.3-0.9s；mp3 抽取与编码识别；mp4→webm 落盘与容器识别；compress crf=35 成功且分辨率/时长保持；thumbnail jpg 与 320 宽图片；concat 输出名与 4s±1s；以及 op 非法、source 缺失、内网 URL、越权 key、concat 少于 2 源、duration>600、format 白名单、crf 越界、源文件不存在共 9 条错误路径。

   说明：本测试素材是合成测试图，crf=35 + veryfast 的体积（38,634 B）反而略大于默认参数生成的 31,978 B，因此单测只断言"压缩成功、分辨率与时长保持"，不断言"一定变小"；真实拍摄素材通常能明显缩小。

## 没做的事

- 未改 `capability.service.ts`，能力尚未注册进服务（按分工留给 lead 合并 `descriptors`/`handlers`）。
- 未改 `files.ts` 的 `UPLOAD_EXTS`（webm/gif 走本地兜底，见上）。
- 未支持字幕烧录、水印、变速、音频降噪、HLS 切片、URL 直传 OSS 等进阶剪辑。
- 未做 CPU/并发限流（高并发转码可能占满机器，建议在 worker 侧限制并发或排队）。
- 未在 Ubuntu 生产机实测 ffmpeg 9 之外的版本；依赖 libx264、libvpx-vp9、libopus、libmp3lame、aac，发行版 ffmpeg 的编译选项需包含这些编码器。
- 拼接对分辨率/帧率差异会归一化重编码（有画质损失与耗时），不做流级无损拼接。
