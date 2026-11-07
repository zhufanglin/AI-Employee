# 媒体链路（RunningHub）与素材存储

更新时间：2026-11-05　生产：https://ai.fcmediaagent.com

## 1. 链路形状

```
桌面端/后台 → POST /api/media/files/upload        （base64 → RunningHub 上传，拿到 1 天有效 URL）
           → POST /api/media/apps/{taskType}/submit（建任务 + 预扣积分 + 调 RunningHub run/ai-app）
           → GET  /api/media/tasks/{taskId}       （轮询 RunningHub query，SUCCESS 时把结果转存到自己域名）
           → POST /api/media/webhook/{taskId}     （RunningHub 主动回调的同一条落库逻辑）
```

- taskType：`lipsync`（数字人对口型）、`indextts`（音色克隆）、`smart_clip`（混剪）、`image_gen`、`video_gen`。
- apiId 走 env 覆盖：`RUNNINGHUB_API_ID_LIPSYNC` 等，默认 `RUNNINGHUB_API_ID=2031016553440878594` 是 lipsync 的 AI App。
- 计费：`MediaPricing` 表；`per_input_second` 按 `ceil(秒数 × pricePerInputSecond)`；**媒体任务不吃每月免费额度，直接扣积分**，余额不足 402「算力不足，请充值」。
- 失败退款：submit 阶段抛错会把预扣的积分退回。

## 2. lipsync 节点号（AI App 2031016553440878594）

| 用途 | nodeId | 接口字段 |
|---|---|---|
| 人像图 | 444 | `image` |
| 音频 | 1755 | `audio` |
| 时长（秒） | 1583 | `seconds` |
| 起始秒 | 1776 | `start` |
| 提示词 | 1624 | `prompt`（默认「角色面向镜头深情的说话，固定镜头。」） |
| 分辨率 | 1606 | `resolution`（720 / 1080） |
| 帧率 | 1586 | `fps` |

节点号可用 env 覆盖：`RUNNINGHUB_NODE_IMAGE/AUDIO/SECONDS/START/PROMPT/RESOLUTION/FPS`。
其它 taskType 目前必须由调用方直接传 `nodeInfoList`（复刻只实现了 lipsync 的默认映射）。

## 3. 结果转存（重要）

RunningHub 返回的结果 URL **只有 24 小时有效**，所以任务转 SUCCESS 时会自动下载结果并转存：

- **优先 OSS**（`OSS_ACCESS_KEY_ID/SECRET/BUCKET/REGION/ENDPOINT` 齐全时）：`media/auto/<taskId>.<ext>`，`resultUrl` 直接是 OSS URL；客户端用 `secure: true`（https），曾遇到 http 偶发 socket hang up。
- OSS 不可用时**兜底本机**：`<cwd>/uploads/media/<taskId>.<ext>`（300MB 上限），`resultUrl` = `${PUBLIC_BASE_URL}/uploads/media/...`。
- 原始上游地址保留在 `resultMeta.sourceUrl`，字节数在 `resultMeta.archivedBytes`。
- 关掉转存：`ARCHIVE_MEDIA_RESULTS=false`；已转存任务（`resultMeta.archivedBytes` 存在且 SUCCESS）再次轮询不会重复下载。

实测（生产，2026-11-05）：
1. 手动转存接口：`POST /api/media/files/oss-transfer`（sourceUrl 限 runninghub/myqcloud/xiaoyaoyou 域）→ `https://zhongke001.oss-cn-beijing.aliyuncs.com/media/...` HEAD 200。
2. 自动 OSS 归档：任务 2118316830364094466（128x128.png + clone-female.wav，3 秒 720p，扣 4 积分）SUCCESS 后 `resultUrl` 自动 = `https://zhongke001.oss-cn-beijing.aliyuncs.com/media/auto/2118316830364094466.mp4`（HEAD 200，174575B，video/mp4）。

## 4. OSS（已启用）

- 桶 `zhongke001`（oss-cn-beijing），RAM 用户 Stu 的 AccessKey（用户提供，策略名「ai员工」），对桶 PUT/GET/DELETE 实测通过；`ListObjects/GetBucketInfo` 未授权（不需要）。
- 生产 `.env`（/opt/fcmediaagent/app/.env）已配 `OSS_*` 五项；本地 `packages/server/.env` 已同步为有效 key（原版解密的旧 key `LTAI5t75...` 已失效弃用）。
- 无效输入会得到上游 FAILED：如 44 字节空 wav → `PreviewAudio: input audio is None (source video may have no audio track)`；测试请用真实媒体文件（clone-female.wav 1.1MB 可复用）。
- 预扣积分在 FAILED 时**已自动退回**（submit catch 分支 addCredits refund）。

## 5. 未做

- RunningHub webhook 未验证（代码路径已写好 `POST /api/media/webhook/:taskId`，env `RUNNINGHUB_WEBHOOK_URL`），目前靠轮询。
- indextts / smart_clip / image_gen / video_gen 缺 RunningHub AI App 的 apiId 与节点表（env 位已留：`RUNNINGHUB_API_ID_*`）。
- OSS 对象无清理策略（当前只增不删）。
## 6. 音色克隆与混剪（2026-11-05 补齐，用户提供了两个 AI App）

### 音色克隆 indextts（appId 1965614643077070850）

| 节点 | 字段 | 含义 | env 覆盖 |
| --- | --- | --- | --- |
| 13 | audio | 要模仿的音色（主） | RUNNINGHUB_NODE_TTS_AUDIO |
| 15 | audio | 情感参考音频（次，默认同 13） | RUNNINGHUB_NODE_TTS_EMOTION |
| 14 | value | 要合成的文本 | RUNNINGHUB_NODE_TTS_TEXT |

- 业务入参：`POST /api/clone-records { sourceUrl, text }`（sourceUrl 必须是 `openapi/...` 文件名或 http(s) URL；文本必填）
- 实测：clone-female.wav（1.1MB 样本）→ 文本「你好，我是你的 AI 数字员工，今天也要一起把客户签下来。」→ 约 30 秒完成，产出 5.19 秒 mp3（62901B），归档到 `/uploads/media/<taskId>.mp3`

### 混剪 smart_clip（appId 2096795601945350145）

| 节点 | 字段 | 含义 | env 覆盖 |
| --- | --- | --- | --- |
| 114 | image | 参考人像 | RUNNINGHUB_NODE_CLIP_IMAGE |
| 224 | value | 混剪提示词 | RUNNINGHUB_NODE_CLIP_PROMPT |
| 115 | aspect_ratio | 画幅（默认 `16:9 (Widescreen)`） | RUNNINGHUB_NODE_CLIP_ASPECT |
| 115 | megapixels | 像素（默认 0.9） | 同上 |
| 135 | value | 时长秒（默认 15） | RUNNINGHUB_NODE_CLIP_SECONDS |

- 业务入参：`POST /api/compose-videos { composeType: "mixcut", image, prompt, seconds }`；也支持传统 `nodeInfoList` 直传
- 节点号全部可用 `RUNNINGHUB_NODE_CLIP_*` 覆盖，换工作流不用改代码

### 计费
- 音色克隆 `indextts`：10 积分/次（MediaPricing `per_request`）
- 混剪 `smart_clip`：0.5 积分/输入秒（15 秒 ≈ 8 积分）
- 参数校验失败在上游提交前拒绝，**不会扣费**；上游失败自动退款（smoke-t30 覆盖）

### 未做 / 注意
- 混剪单任务耗时较长（15 秒成片实测 >30 分钟仍在 RUNNING，属上游排队+渲染），前端轮询需放宽到 30 分钟以上
- indextts 返回多个 results（多个 mp3），当前取第一条
## 7. 文生图与图生视频（2026-11-06 补齐，用户提供了两个 AI App）

### 文生图 image_gen（appId 1980546294345285634）

| 节点 | 字段 | 含义 | env 覆盖 | 默认 |
| --- | --- | --- | --- | --- |
| 6 | text | 提示词 | RUNNINGHUB_NODE_IMG_PROMPT | 6 |
| 625 | value | 尺寸档位（示例 7） | RUNNINGHUB_NODE_IMG_SIZE | 7 |

- 业务入参：`POST /api/media/images/generations { prompt, size }`（`size` 不传默认 7）
- 实测（本地）：一条赛博朋克人像提示词 → 上游 taskCostTime 215s、consumeCoins 157 → SUCCESS → 归档 `/uploads/media/<taskId>.jpg`（2.59MB）

### 图生视频 video_gen（appId 1950219582398185474）

| 节点 | 字段 | 含义 | env 覆盖 | 默认 |
| --- | --- | --- | --- | --- |
| 135 | image | 首帧图（`openapi/...` 文件名或 http(s)） | RUNNINGHUB_NODE_VID_IMAGE | 135 |
| 107 | value | 时长秒 | RUNNINGHUB_NODE_VID_SECONDS | 5 |
| 153 | select | 高清 / 速度版本 | RUNNINGHUB_NODE_VID_VERSION | 2 |
| 113 | select | 设置比例 | RUNNINGHUB_NODE_VID_RATIO | 2 |
| 247 | select | 画幅下标（1:1=0 4:3=1 3:4=2 16:9=3 9:16=4） | RUNNINGHUB_NODE_VID_ASPECT | 4（9:16） |
| 272 | index | 文本输入方式 | RUNNINGHUB_NODE_VID_TEXTMODE | 2 |
| 116 | text | 提示词（不传用 `RUNNINGHUB_VIDEO_DEFAULT_PROMPT`） | RUNNINGHUB_NODE_VID_PROMPT | Time-lapse photography |

- 业务入参：`POST /api/media/video/generations { image, prompt, seconds, aspectRatio }`；`aspectRatio` 支持 `9:16` / `16:9` / `1:1` / `4:3` / `3:4`，也接受数字直接当 select 下标
- 首帧图先走 `POST /api/media/files/upload { fileName, mime, base64 }` 上传，拿到 `openapi/xxx.jpg` 再提交

### 计费
- `image_gen` / `video_gen` 走 `MediaPricing`（当前占位价 20 积分/次）
- 参数校验失败在上游提交前拒绝，不扣费；提交抛错自动退款（`media.service.submit` 的 catch）

### 修正上一节的旧结论
- 混剪「15 秒成片 >30 分钟仍 RUNNING」是当时查询方式错误（脚本读 `rows[0]`，命中了别的任务）。实际 task 2118361198026379266 已在 15:26 completed：15.08 秒 / 1280×736 / h264+aac / 9.15MB，归档 `packages/server/uploads/media/2118361198026379266.mp4`。上游给的 `taskCostTime=704` 秒。
- 上游结果 URL 只有 24 小时有效，所以每次 SUCCESS 必须立刻归档（已做：OOS 优先，失败回落本地 `uploads/media/`）。
