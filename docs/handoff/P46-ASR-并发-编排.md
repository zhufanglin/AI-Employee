# P46 语音转写（ASR）+ 并发 + 团队编排 + 资料引导

> 起因：用户 m22877 问「17 个员工的硬限制有什么解决方法」，我给了 8 条建议与顺序（1 ASR → 2 资料引导 → 3 team_run → 4 并发 + 离线补发），用户 m22881「执行」。本批攒成 0.1.29。
> 四个 subagent（A 技能样例 / B team_run / C 云端并发 / D 资料引导）并行，我负责 ASR 与集成。

## 一、语音转写（P1，最大硬限制）

### 1.1 为什么不用阿里云智能语音（否决）
- 生产 env 只有 `ALIYUN_SMS_*`（RAM 用户 power-application-user）、`OSS_*`、`ARK_API_KEY`、`RUNNINGHUB_*`、`TAVILY_API_KEY`，**没有任何 NLS/ASR key**。
- 用短信 AK/SK 做 RPC v1 签名（HMAC-SHA1，secret+"&"）调 `nls-meta.cn-shanghai.aliyuncs.com` 的 **CreateToken 成功**（200，Token 有效期到 1794628808），但：
  - `nls-meta` 只支持 CreateToken，`ListProjects/CreateProject/QueryProject/GetProject/ListTask` 全 404 `InvalidAction.NotFound`；
  - `nls-cloud-meta.cn-shanghai.aliyuncs.com` 在生产 **DNS ENOTFOUND**；
  - 真正转写要 `appkey`，只能在控制台建项目拿，没有 OpenAPI。
- ⇒ 结论：走阿里云必须人工去控制台建项目 + 拿 appkey，不可自动化；改用**本机 CPU 推理**，零凭证、零按量计费。

### 1.2 生产环境（已装好）
- `/opt/fcmediaagent/asr/venv`（Python 3.12 venv，需 apt `python3.12-venv`）
- 依赖：`faster-whisper==1.2.1`、**`av==12.3.0`**、requests、huggingface_hub、tokenizers、onnxruntime
- 模型：`small` + `compute_type=int8`，落在 `/opt/fcmediaagent/asr/models`（**464MB**）
- 版本实测：`FW 1.2.1 / AV 12.3.0 / CT2 4.9.0`
- **必须钉 av==12.3.0**：faster-whisper 调 `av.open(metadata_errors=...)`，av≥14 删了该参数 ⇒ 报 `open() got an unexpected keyword argument 'metadata_errors'`。踩了 3 轮（av 19.0.2 / 18 / 16 全失败）。
- 安装脚本 `_deploy/asr-install.sh`（已含 av pin 与注释）。

### 1.3 能力 transcribe
- 源码 `packages/server/src/capabilities/capabilities/asr.ts`（约 300 行），CLI `packages/server/tools/transcribe_cli.py`（生产副本 `/opt/fcmediaagent/asr/bin/transcribe_cli.py`）。
- 参数：`source`（工作区文件名/key 或 http(s) 链接）、`language`（默认 zh）、`timestamps`（bool）、`save`（默认 true）、`name`（保存文件名）。
- 流程：`prepareSource`（复用 media-tools，带 SSRF 守卫）→ `probeMedia` 校验有音轨与时长 → ffmpeg 抽 `-vn -ac 1 -ar 16000 -c:a pcm_s16le` → spawn python CLI → 读 JSON → 文本 >40000 字截断、segments 最多 400 → 默认写 `转写-<原名>.md`（元信息行 + 「## 全文」 + 可选「## 时间轴」）。
- env：`ASR_ENABLED`(1) `ASR_PYTHON`(默认 /opt/fcmediaagent/asr/venv/bin/python) `ASR_SCRIPT` `ASR_MODEL`(small) `ASR_MODEL_DIR` `ASR_THREADS`(4) `ASR_TIMEOUT_MS`(540000) `ASR_MAX_SECONDS`(1800)。
- 失败一律中文 BadRequestException；引擎缺失时「本机没有安装语音识别引擎（faster-whisper）…」。
- CLI 输出：`{ok,text,segments[{start,end,text}],durationSec,model,language,elapsedMs}`，失败 exit 2/3。

### 1.4 生产实测（2026-11-13 01:04）
```
POST /api/capabilities/run {"name":"transcribe","params":{"source":"asr-test.mp3","timestamps":true,"save":false}}
ELAPSED=19s  SUCCESS True
TEXT 大家好,这是一段用于测试语音转写的中文音频。我们明天下午三点在会议室讨论新品发布方案,请提前准备销售数据。
SEGMENTS 2  DURATION 13.47
```
13.47s 音频 → 19s（≈1.4× 实时，4 vCPU）；识别与原文逐字一致（含标点）。

### 1.5 技能侧接入
- `packages/worker/tool-loop.mjs`：CAPABILITIES 加 `transcribe`；INSTRUCTIONS 加「需要把音频/视频里的说话内容变成文字（听素材、出字幕、编剪辑点位、整理会议访谈录音）时用 transcribe（source 填工作区文件名或链接，timestamps=true 可拿到分段时间轴），有文字稿才能引用口播原话，没有转写就不要编造。」
- `boss-video-auto-editor/SKILL.md`：能做加「语音转写（本地 whisper，可带时间轴）」，不能做改「烧字幕进画面/自动卡点」，工具编排第 3 步改「有音轨就 transcribe(timestamps=true) 拿文字稿与时间轴再切语义段」，自检加「首句必须能在时间轴对上，没转写别编首句」。

## 二、并发（P4）

### 2.1 云端 worker
- `packages/worker/cloud-executor.mjs`：并发池 + `pump()`（仅在空闲槽位 pull）+ `startTask()`（领到即起 30s claimToken 心跳再排队，避免排队期被判失联重排）。
- `FCM_WORKER_CONCURRENCY` 默认 2，夹 1~4。
- **同账号并发**：`FCM_WORKER_USER_CONCURRENCY` 默认等于并发池（同账号也并行）。早期 subagent C 实现的是「同用户严格串行」，在单账号场景等于全串行、并发池形同虚设 ⇒ 改为仅当 `USER_CONCURRENCY<=1` 才 `SERIALIZE_PER_USER`（此时才传 `excludeUserIds`、才就地等前一任务）。`normalizeConcurrency(raw, fallback = 2)`。
- 服务端 `claimCloudTasks(userId, deviceId, excludeUserIds)` 单次认领上限 3→4，控制器 `POST /employee-execution/pull` 透传 body。
- 生产 unit 已加 `Environment=FCM_WORKER_CONCURRENCY=2` / `FCM_WORKER_USER_CONCURRENCY=2`；启动日志 `concurrency: 2, userConcurrency: 2`。

### 2.2 桌面执行器
- `packages/desktop/src/main/executor.ts`：`FCM_EXECUTOR_CONCURRENCY` 默认 2（上限 4）；`inFlightByEmployee` 保证**同一员工串行**（避免抢同一工作区/记忆）；`runOne()` 抽离；`status()` 返回 `{running,busy,inFlight,concurrency,startedAt,lastRun,pollMs}`。

## 三、团队编排 team_run（P3）

- `packages/server/src/capabilities/capabilities/employee-tools.ts`：descriptor `team_run`（title「团队协作编排」，category employee）+ handler。
- 参数：`jobs`（1–5 条 `{employeeSlug,input,title?}`，必填）、`maxWaitSeconds`（默认 180，上限 300）、`aggregate`（默认 true，模型汇总）、`parentEmployeeSlug`（与目标相同会被拒「不能给自己派活」）。
- 返回：`{ok,created,done,timedOut,elapsedMs,results[{employeeSlug,taskId,status,outputText≤800}],summary?}`。
- 复用 `employee.service.run` 的安装/购买校验；模型不可用时退回机械拼接。
- `employee_dispatch` 另加 `wait` / `maxWaitSeconds`。
- 生产实测（单任务、aggregate=false）：`CREATED 1 DONE 1 TIMED_OUT False ELAPSED_MS 15020`，员工正常返工 awaiting_approval 并有产出。
- 错误路径：`jobs: []` → `{"success":false,"error":"jobs 必填，需提供 1-5 条任务"}`。

## 四、企业资料引导 + 队列位置（P2）

- 员工办公区/工作区顶部「企业资料完整度」卡片：读本地 `<userData>/workspace/企业基础资料.md`，按 6 项判定（公司/品牌名、主营业务、目标客户、核心优势、话术口径、输出偏好），显示「已填 n/6」+ 缺失项 + 打开编辑/下载/上传同名/复制路径；6/6 时只显示绿字「资料已完整，员工产出会贴合你的业务」。
- 只认「条目标签 + 冒号后有内容」，空白模板 0/6、占位符 0/6，读不到内容显示「未读到资料内容」不谎报。
- 服务端 `employee.service.listTasks` 给 queued 任务加只读 `queuePosition`（同 userId 按 createdAt 升序 1..n，其余 null），桌面显示「排队中，前面还有 N 个任务」/「马上开始」。
- 17 份 SKILL.md 均新增「## 优秀交付样例」（150–170 字，总计 <7500B），`scripts/gen-skills-content.mjs` 重生成 `skills-content.ts`（89,453B / 17 entries）。

## 五、验证记录

| 项目 | 结果 |
| --- | --- |
| `scripts/smoke-p46-asr.mjs` | ASR SMOKE OK (14 checks) |
| `scripts/smoke-p46-team.mjs` | ALL PASS (6 checks) |
| `scripts/smoke-p46-concurrency.mjs` | ALL PASS (19 checks) |
| `scripts/check-desktop-p46.mjs` | 35 checks PASS |
| `scripts/check-skills-content.mjs` | SKILLS CONTENT OK (17 entries) |
| 本地全量 `verify.ps1 -Smoke` | **VERIFY GREEN**（含 P46 三个 smoke + check-desktop-p46） |
| 生产部署 `_deploy/p46-server.sh` | `P46_DEPLOY_DONE`，API/WORKER active，HEALTH=200 LEGAL=200 |
| 生产 transcribe | 19s，文本逐字正确，2 段 |
| 生产 team_run | created 1 / done 1 / 15.0s |

## 六、运维注意
- 生产备份：`/opt/fcmediaagent/app/dist.bak.20261113-005816`、`worker/*.bak.20261113-005816`、`fcmediaagent-worker.service.bak.20261113-005816`、`app/.env.bak.20261113-005816`。
- ASR 依赖不可随便升级：`av` 必须 12.3.0。重装用 `_deploy/asr-install.sh`。
- 无 GPU：4 vCPU 上 13s 音频约 19s；1 分钟音频约 1.5 分钟，长素材注意 `ASR_MAX_SECONDS=1800` 与 `ASR_TIMEOUT_MS`。
- 桌面端并发只影响员工任务；平台 RPA 仍按平台串行（`runExclusive`）。
- 冒烟脚本取验证码：生产/本地非白名单号码不回 `devCode` 时，从 `VerificationCode` 表按 phone 取最新一条（smoke-p46-team 已内置）。
