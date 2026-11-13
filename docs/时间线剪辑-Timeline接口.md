# 时间线剪辑（Timeline）——复刻版新增能力

> 原版「中科元晟 AI员工 0.4.29」没有时间线剪辑：内置的智能混剪（`smart_clip`）只能吃「1 张参考图 + 一段提示词」生成一段 AI 画面，拿不了几十段实拍素材 + 一整段口播。
> 为了做出与对标视频同形态的成片（实拍 B-roll 混剪 + 顶部圆形数字人画中画 + 底部大字幕），复刻版新增了本模块：**素材上传 → 创建任务 → 轮询 → 取成片**，剪辑在服务端用 ffmpeg 完成。
>
> 这是**新增域**，`contracts/` 基线里没有对应条目；路由前缀自定为 `/api/timeline`。

## 1. 路由

| 方法 | 路由 | 说明 |
|---|---|---|
| POST | `/api/timeline/sources` | 上传一段素材（base64 JSON），返回可复用的 `/uploads` 引用 + 时长/分辨率 |
| POST | `/api/timeline/jobs` | 创建剪辑任务（异步，立即返回 id） |
| GET | `/api/timeline/jobs` | 列任务（`?limit=`，≤100，默认 20） |
| GET | `/api/timeline/jobs/:id` | 查任务状态/进度/成片地址 |

全部需要 `Authorization: Bearer <token>`（`AuthGuard`），按手机号隔离数据。

## 2. 上传素材

```
POST /api/timeline/sources
{ "fileName": "154528_416.mp4", "mime": "video/mp4", "base64": "<...>" }
```

- 兼容 `data:video/mp4;base64,` 前缀；也接受 `data`/`name` 字段（与 `media/files/upload` 同一套入参习惯）。
- 允许扩展名：`mp4 mov m4v mkv webm jpg jpeg png mp3 m4a wav aac`；单文件 ≤ 200MB。
- 落盘到 `packages/server/uploads/timeline/sources/<uuid>.<ext>`，公开地址 `/uploads/timeline/sources/<uuid>.<ext>`。
- 返回：`{ id, url, path, fileName, kind: "video"|"audio", duration, width, height, hasAudio }`。
- 错误文案：`缺少 base64 文件内容` / `文件内容为空` / `文件超过 200MB` / `不支持的素材格式：xxx` / `素材里没有音视频轨`。

## 3. 创建剪辑任务

```
POST /api/timeline/jobs
{
  "title": "第二步-克隆音色+克隆人+工厂素材",
  "clips": ["/uploads/timeline/sources/a.mp4", "/uploads/timeline/sources/b.mp4"],
  "voiceover": "/uploads/timeline/sources/voice.mp3",
  "person": "/uploads/timeline/sources/person.mp4",
  "totalDuration": 27.18,
  "seed": 7,
  "cues": [
    { "start": 0, "end": 4.7, "text": "模具和注塑，为什么要从一开始就一起考虑？", "keyword": "模具和注塑" }
  ],
  "style": { "width": 720, "height": 1280, "fps": 25, "pip": { "size": 240, "x": 240, "y": 70 }, "loudnorm": true }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `clips` | 是 | B-roll 素材，1–200 段；元素可为 `/uploads/...` 字符串或 `{path|url|fileId}` |
| `voiceover` | 否 | 配音（口播/克隆音色音频）；不给则成片无声 |
| `person` | 否 | 画中画用的数字人视频（lipsync 产物）；不给则无画中画 |
| `totalDuration` | 否 | 成片时长；缺省用配音时长 |
| `cues` | 否 | 字幕条：`{start,end,text,keyword?}`；`keyword` 会渲染成黄色高亮 |
| `style` | 否 | 见下 |
| `seed` | 否 | 选片洗牌种子，默认 7（同输入同输出，便于复现） |

`style` 默认值（`DEFAULT_STYLE`）：`width 720 / height 1280 / fps 25`；`pip {size 240, x 240, y 70, frac 0.35, topFrac 0.55}`；调色 `contrast 1.05 / saturation 1.07 / sharpness 0.3`；`fadeIn 0.35 / fadeOut 0.55`；`loudnorm true`。

错误：`请至少提供 1 段视频素材` / `单次最多 200 段素材` / `素材不存在：<ref>` / `无法确认成片时长：请提供 totalDuration 或带时长信息的配音` / `单次成片最长 10 分钟`。

返回：`{ id, status: "queued", progress: 0, title }`。

## 4. 剪辑逻辑（`src/timeline/edl.ts`）

1. **分段**：把整条配音按 cue 切；单条 cue 超过 `targetShot`（3.2s）就等分成多个镜头（`Math.round(len / 3.2)`），避免一个长句只挂一个镜头。
2. **选片（`buildShotPlan`）**：先用得最少的优先，同次数用 `hash(seed*31+i*977+idx)` 洗牌，从前 4 名里挑一支；**不连着用同一支素材**；素材不够长就 `speed = usable / need`（最低 0.65 慢放）+ 末帧 `tpad=stop_mode=clone` 补齐。
3. **画面**：`trim` → `setpts=(PTS-STARTPTS)/speed` → `scale` 铺满再 `crop` → `setsar=1` → `fps` → `concat` → `eq` + `unsharp`。
4. **画中画**：从数字人视频按 `iw*frac` 裁正方形（纵向圆心 = `ih*topFrac`），`geq` 做圆形 alpha + 白色描边环，双 overlay 到 `(x, y)`。
5. **字幕**：生成 ASS（微软雅黑、`fontSize = width/12`、白字黑描边 + 投影、`MarginV = height*0.137`、`WrapStyle 2`），按 `maxChars = (width-100)/fontSize` 切行，**优先切在标点后**（`splitByLength`），关键词染黄。
6. **输出**：`libx264 -preset veryfast -crf 19 -pix_fmt yuv420p -r 25`，音频 `loudnorm=I=-15:TP=-1.5:LRA=11` + `aac 192k 48k`，`-movflags +faststart`。成片落 `uploads/timeline/jobs/<id>.mp4`，DB 写 `resultUrl`。

同机并发上限 1（`maxConcurrent = 1`），排队在内存 `Map` 里。

## 5. 数据表（新增）

`prisma/migrations/20261113154500_add_timeline_job/migration.sql`：

```sql
CREATE TABLE `TimelineJob` (
  `id` VARCHAR(191) NOT NULL,
  `phone` VARCHAR(191) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'queued',   -- queued | running | completed | failed
  `progress` INTEGER NOT NULL DEFAULT 0,
  `spec` JSON NULL,                                -- 创建时的入参快照
  `resultUrl` MEDIUMTEXT NULL,
  `error` MEDIUMTEXT NULL,
  `durationSeconds` DOUBLE NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `TimelineJob_phone_idx`(`phone`),
  INDEX `TimelineJob_status_idx`(`status`),
  INDEX `TimelineJob_createdAt_idx`(`createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

> 读写用 `$executeRawUnsafe` / `$queryRawUnsafe` 原生 SQL（本机 `prisma generate` 被运行中的服务锁住 DLL，CLI 在沙箱里 spawn 会 EPERM）。服务停止后跑一次 `prisma generate` 即可改用委托。

## 6. 实测（2026-11-13）

输入：克隆音色 27.18s + 数字人 576×1024 + 39 段工厂实拍（合计 259.1s）。

| 指标 | 结果 |
|---|---|
| 创建 → 完成 | 约 28s（27.2s 成片） |
| 文件 | 720×1280 / 25fps / 27.20s / 10.15MB |
| 音量 | mean −16.1dB / max −1.5dB（loudnorm 生效） |
| 镜头数 | 12 个（cue 4 条，细分后 12 段） |
| 字幕 | 12 条 Dialogue，断句落在标点，无溢出 |

产物：`_work/成片/第二步-克隆人+克隆音色+工厂混剪-27s.mp4`、`_work/成片/第二步-封面.jpg`。

## 7. 已知限制

- **没有 ASR**：`packages/server/prisma/skills-content.ts:923` 明确写「不能自动做：语音转写、烧录字幕、自动判断语义断点」。`cues` 必须由调用方给（按字数比例铺时间码），不是从音频自动对齐。
- 画中画位置是固定参数（`pip.x/y/topFrac`），不做人脸跟踪。
- 单机串行渲染，长素材（>3 分钟）会明显排队。
- 桌面端 UI 暂时没有入口，目前只有 HTTP API（下一步接 `MediaStudio`）。
