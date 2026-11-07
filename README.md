# 中科元晟 AI 员工 · 复刻工程

> 来源：`fcmediaagent 0.4.29`（客户端）+ `server 2026-10-27`（服务端）逆向拆解
> 目标：参考原版构建 Windows 客户端、服务端和管理能力；原版契约对齐与兼容范围按最新用户决策逐项确认。

## 当前产品方向与状态（2026-11-04）

- 对外销售预先组合的 AI 员工团队；平台以 17 个 Skill 为员工库。首个团队暂称“获客成交团队”，包含 AI获客线索雷达（`boss-lead-radar`）、私域客户分层跟进官（`boss-private-lead-manager`）、AI销售跟进销冠（`boss-sales-followup`）。名称、价格、有效期、体验和开通方式待用户确定。
- 数字人、对口型和混剪使用第三方云服务（如 RunningHub 一类平台）；不自建 GPU。具体服务商与存储方案待定。
- Windows 桌面端、服务端与最小管理能力共同构成产品；个人微信采用自研 UIAutomation（不注入、不挂钩）。用户的阿里云美国 ECS 是否用于测试或部署尚未确定。
- 原版路由、IPC、数据库与行为是对照基线；17 员工团队和用户确认的变更按新产品决策处理。旧文档中“全新协议”和“完全对齐原版”不能简单合并为一项已完成事实，兼容范围需逐项明确。
- 当前仅具备开发环境骨架和部分已记录的历史链路验证，尚未完成首个三人团队实际执行、商业授权、支付及可对外发布验收。正式短信尚未接入；流式计费、授权续期、任务领取和补跑仍有已知问题。
- 最近一次模型接口 JWT 签名和过期校验修复已完成单元测试与代码审查（T-20）；其他安全项仍需验证。最新任务状态以 [任务看板](docs/handoff/BOARD.md) 为准。

## 逆向拆解覆盖评估（人工估计）

**约 55/100，合理范围约 40–65；这是依据现有证据的主观判断，不是测量值或复刻完成率。** 分数衡量“是否掌握支撑行为复刻的证据”，不是已提取的接口名比例。尚无完整行为覆盖清单，不能对覆盖率作精确计算。

- 原版安装包、Electron ASAR、服务端编译产物、数据库模型、IPC/路由清单、字符串和资源清单已有记录；`contracts/`、[契约差异](docs/fidelity-matrix.md)及[资产清单](docs/assets-inventory.md)可供核对。
- 路由/通道名称或 schema 可枚举，不证明请求与响应、权限、错误、运行顺序、真实行为或第三方效果已验证。旧报告中 237/238 路由存在重复与路径末尾斜杠口径差异；147 主进程 handle 与 222 preload 通道属于不同统计对象，尚未逐条建立对应，不应相加或视为等价覆盖率。
- 待补证据：原版关键用户流程与失败路径的运行记录；IPC 的入参、返回值、事件和调用链；混淆主进程与渲染层组件语义；客户端与服务端版本配对；支付、计费、兑换与授权状态变化；渠道登录/重连/消息流程；技能与定时任务实际协作；媒体第三方任务/回调/文件生命周期；管理后台操作、安装更新与恢复行为。
- 静态分析不能证明运行行为；原始 TypeScript 及部分商业组件实现不可得。历史资料曾报告完整主包分析超时；本次对原版 preload 的 REA 抽查也未取得结果，不能据此宣称分析成功。
- 评分并非代码完成比例或上线成熟度：当前员工协作、支付、渠道、正式短信、部署等尚未构成可对外销售的完整产品。

## 目录

```
fcmediaagent-replica/
├── contracts/                  # 逆向产出的契约基线（只读）
│   ├── http_routes_238.txt     # 原版 238 条 HTTP 路由
│   ├── ipc_handles_147.tsv     # 原版 147 条 IPC 通道
│   └── schema_original_47.prisma
├── packages/
│   ├── server/                 # NestJS 11 + Prisma 6 + MySQL 8
│   │   ├── prisma/schema.prisma  # 当前数据模型，以文件为准
│   │   └── prisma/seed.ts        # 由生产库配置快照生成
│   ├── desktop/                # Electron + React 19 + electron-vite
│   └── shared/                 # 共享类型与 IPC 通道常量
└── docs/
```

## 历史裁剪说明（初期记录，非当前实际表数）

删除：`FeishuDocument / FeishuConfig / FeishuOAuthState / BitableRecord / WechatOaConfig / WechatLoginSession / PendingSubscribe / SubscriptionPlan / UserSubscription / SubscriptionOrder / UserMonthlyUsage / RecorderBinding / RecorderContent / SceneVideo`

理由见 [复刻-范围对齐-v2.md](C:/Users/30290/Desktop/部署文件/复刻-范围对齐-v2.md)。

## 历史进度记录（2026-10-29，非当前验收结论）

- ✅ W1-1 工程骨架（npm workspaces）
- ✅ W1-2 Prisma 33 表迁移（MySQL 8.0，docker 容器 `fcm-mysql`，库 `fcmediaagent_v2`）
- ✅ W1-3 seed：站点配置 / 11 模型定价 / 6 媒体定价 / 2 积分包 / 短信 / OSS / 微信支付
- ✅ W1-4 登录鉴权：短信验证码登录、账号密码登录、管理员登录、JWT 守卫、改密、`/api/site/config`
- ✅ 冒烟通过：health / site/config / sms send+login / me / admin login

## 历史开发验证记录

> 以下 W2/W3 是当时的开发环境记录；未覆盖后来发现的流式计费及授权问题，也不能作为正式上线证明。

### W2 — 模型代理 + 按次计费（历史链路测试，计费有待修复）

- ✅ W2-1 Provider 注册表：`ModelPricing.provider/upstreamModelId` → `ALIAS_MAP` → 上游真实 id（例：`doubao-seed-2.0-pro` → `doubao-seed-2-1-pro-260628`）
- ✅ W2-2 官方直连：火山方舟 `https://ark.cn-beijing.volces.com/api/v3`（配置状态需在本地环境核实），DeepSeek / Moonshot / SiliconFlow 备用通道
- ✅ W2-3 `POST /api/compute/chat/completions`：非流式 + SSE 流式（`res.status(200)` + 自动补 `stream_options.include_usage`）
- ✅ W2-4 `GET /api/compute/models`、`GET|POST /api/volcengine/proxy-token`（`rrclaw-proxy-` 前缀，7 天）、`/api/volcengine-proxy/v3/*`（网关直连用）
- ✅ W2-5 Billing：免费额度按「调用次数」（`UserMonthlyUsage`）→ 用尽后按 `ModelPricing` 扣积分 → 写 `AiUsageRecord` + `CreditTransaction`；不足返回 402 `INSUFFICIENT_CREDITS`
- ✅ W2-6 查询：`/api/credits/{balance,transactions,ai-usage-records,ai-usage-stats}`
- ✅ 冒烟：登录 → proxy-token → 模型列表 → 非流式（真实豆包回复 total 831 tok）→ 流式（45 个 data 块）→ 额度内 0 积分 → 额度用尽实扣 1 积分并写流水 → 余额清零返回 402
- 脚本：`scripts/smoke-w2.mjs`、`scripts/smoke-w2-billing.mjs`

### W3 — 桌面端 + openclaw 网关（历史链路测试）

- ✅ W3-1 Electron 38 + React 19 + electron-vite 4 骨架：登录 / 对话 / 积分与用量 / 渠道网关 / 设置 五个页面
- ✅ W3-2 `chat:send` 走主进程 fetch → SSE 逐块经 `chat:chunk` 推给渲染层；桌面端实测流式回复 + usage 显示
- ✅ W3-3 GatewayManager：写 `userData/openclaw/openclaw.json`（provider `fcm` → `<apiBase>/volcengine-proxy/v3`）、spawn `ELECTRON_RUN_AS_NODE=1` 跑 openclaw gateway（端口 18789、token 鉴权、`/health` 探活）
- ✅ W3-4 端到端验证：`openclaw agent --message …` → 网关 → `/api/volcengine-proxy/v3/chat/completions` → 火山方舟 → 回复「网关链路正常」；用量 22410/36 tok 已写入 `AiUsageRecord`
- ✅ W3-5 脚本：`scripts/e2e-gateway.ps1`（登录 → 取代理令牌 → 改 openclaw.json → 起网关 → 跑 agent → 停网关）
- 关键坑 1：openclaw 只把**已知** `*_API_KEY` 环境变量名当标记解析，自定义名（如 `FCM_PROXY_TOKEN`）会被当字面量发出去导致上游 401 → 直接写代理令牌字面量进 `openclaw.json`（每次启动重写，令牌 7 天有效期由服务端刷新）
- 关键坑 2：`/volcengine-proxy/v3` 必须同时接受 JWT 与 `rrclaw-proxy-` 令牌 → 改为 `@Public() + ComputeAuthGuard`
- 关键坑 3：openclaw 首启要 30–80s（插件预加热），`/health` 轮询窗口需 ≥ 120s（已改为 50×2s）
- 桌面端启动：`electron-vite build` 后 `node_modules\electron\dist\electron.exe packages\desktop`；打包用 `electron-builder --win nsis`

## 历史手动启动记录（Windows，执行前核对工作目录）

> 不要盲目执行迁移或 seed；优先参考 `AGENTS.md`。`scripts/dev-up.ps1` 会终止命令行匹配 `dist/main.js` 的 Node 进程，启动前应检查影响。

```powershell
# 1. 数据库（首次）
docker start fcm-mysql

# 2. 依赖（已装）
& "$NODE_DIR\npm.cmd" install

# 3. 迁移 + 种子
& "$NODE_DIR\node.exe" node_modules\prisma\build\index.js migrate deploy
& "$NODE_DIR\node.exe" node_modules\tsx\dist\cli.mjs prisma\seed.ts

# 4. 编译 + 启动（必须走 tsc，tsx 不产出装饰器元数据，Nest DI 会拿到 undefined）
& "$NODE_DIR\node.exe" node_modules\typescript\bin\tsc -p tsconfig.json
& "$NODE_DIR\node.exe" dist\main.js
```

> `$NODE_DIR` = `C:\Users\30290\Desktop\REA逆向\toolchain\node-v24.22.1-win-x64`

服务：http://127.0.0.1:3000/api ・ Swagger：http://127.0.0.1:3000/api/docs

## 常用命令

```bash
npm install                      # 工作区安装（registry 走 npmmirror）
npm -w packages/server run prisma:generate
npm -w packages/server run prisma:migrate
npm -w packages/server run prisma:seed
npm run dev:server
```

## 环境变量

复制 `packages/server/.env.example` 为 `.env`，填入密钥；所有密钥**不入库、不进代码**。

## 历史排期（8 周，已过时；不作为承诺）

| 周 | 交付 |
|---|---|
| W1 | 骨架 + 33 表迁移 + seed + 登录鉴权（✅） |
| W2 | 聊天主链路 + 模型接入 + 按次计费（✅） |
| W3 | 桌面端 + 聊天 + openclaw 网关（✅） |
| **W4** | **M6.5 AI 员工团队域（一）：17 员工目录 + 技能安装到 openclaw + 单次运行 + 任务记录（重点项）** |
| **W4 进度** | ✅ 后端完成：5 张表（AiEmployee 扩字段 + Install/EmployeeCron/EmployeeTask/EmployeeTaskArtifact）+ 17 员工 seed + 11 条 API + 冒烟全绿（`scripts/smoke-m65.mjs`）；F2 基线 `docs/fidelity-matrix.md`、资产考古 `docs/assets-inventory.md` 已交付 |
| **W5** | **M6.5 AI 员工团队域（二）：云端调度 + 定时器 + 补跑 + 任务看板 + 产物验收 + 套餐授权（重点项）** |
| W6 | 渠道接入（Telegram/企微/飞书，按凭证到位情况）+ 个人微信自研（UIAutomation）+ 会话持久化 |
| W7 | 积分充值 + 微信支付 + 最小后台（admin 88 路由裁剪版） |
| W8 | 安装包 + 自动更新 + 设置 + 联调验收 |
| 待定 | 媒体链路（数字人/对口型/混剪）——**不自建 GPU，改为调用第三方云端生成 API**（用户 m01410），暂不排期，只留 `MediaTask` 接口 + 回调 |

## 总纲（2026-11-04）

完全忠实复刻按**五层忠实度**（F4 架构 / F3 行为 / F2 契约 / F1 文案 / F0 视觉）验收，阶段 P1–P8 与多 Agent 分工见 [docs/复刻-总纲-v3.md](docs/复刻-总纲-v3.md)。

## 历史决策补充（2026-10-30；与当前方向冲突时以上方为准）

1. **员工体系从 12 换成 17**：采用《老板必装的17个AI员工Skill-新手交付版》（sha256 d881454d…），已复制到 `packages/desktop/resources/skills/`（17 个技能目录 + `skill-manifest.json` + `templates/` 6 个导入模板）。
2. **员工域从 M9 拆出，独立为 M6.5**，排期提前到 W4/W5，列为**重点开发项**。设计见 [docs/M6.5-AI员工团队域.md](docs/M6.5-AI员工团队域.md)。
3. **历史记录**：当时媒体链路暂缓；后续已确定采用第三方云平台，不自建 GPU。
4. **验收标准改变**：员工能力需逐一验证实际产物；原版契约差异和用户明确的变更也须逐项核对，不能以任一单项代替全面验收。
5. 渠道接入只接有凭证的（Telegram 需 bot token；企微需 corpId+应用 Secret+AgentId；飞书需 appId+appSecret），无凭证的只留配置位。
6. **媒体链路改为第三方云平台 API**（用户 m01410）：数字人/对口型/混剪均调云端生成服务（如火山 OmniHuman/Seedance、可灵、即梦、腾讯智影、剪映类混剪 API），不自建 GPU、不做 media-agent。服务端工作量从"GPU 运维 + PyTorch 服务"降为"API 适配 + 任务轮询/回调 + 结果转 OSS"，预计 4–6 人日，等进入该节点再定选型。
7. 员工模型定为 **agent 做壳、skill 做能力**：每个员工 = 一个 openclaw agent（workspace + SOUL.md + skills 白名单）+ 绑定对应 skill，兼顾"人格呈现"与"能力包复用"。

## W5 进度（T-08 已完成）
- 团队套餐授权：兑换码 traffic/private-domain/flagship、`UserPackageGrant`、`GET /packages/mine`
- 员工按天订单：`POST /employee-orders`（1/7/30/90/365 天，= price × days），管理员 `mark-paid` 手工开通（微信支付留 T-12）
- 授权硬化：install 拒绝客户端自定期限；run 实时以购买记录为准；到期 install/run 均 403
- 冒烟：`scripts/smoke-t08.mjs`（25 项全绿）、`scripts/smoke-m65.mjs` 回归通过
- env：`PACKAGE_VALID_DAYS`（默认 30）

## W7 进度（T-12 已完成，2026-11-05）
- 微信支付 V3 Native：`packages/server/src/payments/wechat-pay.service.ts`（RSA 签名、回调验签 + 5 分钟防重放、AES-256-GCM 解密、mock 模式）
- 积分订单：`POST /api/payments/orders` → 返回 `weixin://` code_url；`markPaid` 事务内条件更新幂等入账（重复回调 credited=0）；金额不符单独落库 `amount_mismatch` 并 400（事务外预检，避免回滚）
- 最小后台 API：概览 / 套餐 CRUD（元入参、分存储）/ 订单查询与人工确认 / 用户与积分流水
- 回调：`main.ts` 对 `/api/payments/wechat/notify` 注册 `raw({type:"*/*"})` 保留原始报文
- 冒烟：`scripts/smoke-t12.mjs` 30/30；`verify.ps1 -Smoke` 全绿
- 文档：`docs/handoff/T12-支付与后台.md`（含微信商户后台配置清单）

## 定价（重要：当前全是占位价）
库内积分包/模型/媒体计价均为原版联调占位值（999 积分=1 分钱），**不可对外售卖**。事实批注、成本对照与改价通路见 [docs/定价-占位与待批注.md](docs/定价-占位与待批注.md)。

## W8 进度（T-13 已完成，2026-11-05）
- 安装包：`packages/desktop/release/中科元晟 AI员工-0.1.0-win-x64.exe`（**127.7 MB**）+ `.blockmap` + `latest.yml`；免安装目录 434.7 MB / 20152 文件
- 配置：`packages/desktop/electron-builder.yml`（NSIS 可改目录、快捷方式、`signExecutable: false` 保留图标与版本信息、图标取自原版 `build/icon.ico`、publish generic → `https://updates.fcmediaagent.com/desktop/latest`）
- 自动更新：`src/main/update.ts`（electron-updater，启动 15s 静默检查、手动确认下载、`quitAndInstall`；dev 态 disabled）+ 设置页「检查更新 / 下载新版本 / 重启并安装」
- 首启引导：`pages/Onboarding.tsx` 三步（欢迎 → 服务端地址+测试连接 → 完成），完成后不再出现
- 构建卡点解法：必须设置 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`（否则 GitHub 拉 7zip/NSIS 600s 超时）；一键脚本 `scripts/release-desktop.ps1`
- 实测：静默安装 `/S /D=<dir>` 成功（解压 2–4 分钟）、安装版 GUI 冒烟通过、`verify.ps1 -Smoke` GREEN
- 待补：代码签名证书（用户后补）、更新源部署后才能验升级链路、卸载流程待人工确认
- 文档：`docs/handoff/T13-安装包与更新.md`

## F2 契约收口（T-14 已完成，2026-11-05）
- 管理端扩展 API 落地：`packages/server/src/admin/admin-extra.{service,controller}.ts`，覆盖站点/AI 接口/OSS/短信/微信支付配置、模型与媒体定价、兑换码管理、用户与员工管理、上传、用量与统计
- 新增路由 77 条 `/admin/*`（含原版路径别名 `POST /admin/login`、`PUT /admin/users/:id/credits`）
- 契约命中：HTTP 130/237（54.9%，T-14 前 73）；admin 模块 59/88 精确命中
- 缺口处置台账：`docs/fidelity-matrix.md` 第 7 节（机器生成，重跑不丢）；剩余 29 条 admin 路由逐子域标 CUT/BLOCKED 并写依据
- 冒烟 `scripts/smoke-t14.mjs` **58 项全绿**，已并入 `verify.ps1 -Smoke`
- 已知偏差：上传接口由原版 multipart+ali-oss 改为 **base64 JSON + 本地落盘**（`PUBLIC_BASE_URL/uploads/...`）；管理后台仍只有 API，无 Web 控制台
- 文档：`docs/handoff/T14-契约收口.md`

## T-19 员工执行器（本机 + 云端，2026-11-05 已完成）
- 桌面端执行器：`packages/desktop/src/main/executor.ts`（poll 8s，认领 `POST /employee-tasks/pull` → 调模型 → 回写 `awaiting_approval` + 产物落 `<userData>/employee-output/<taskId>.md`），办公区显示执行器状态徽标
- 云端执行器：`packages/worker/cloud-executor.mjs`（零依赖，心跳 + 拉取 `executor=cloud` 任务），已部署到隔离测试机 **154.64.255.36**（systemd `fcmediaagent-staging.service` :3100 + `fcmediaagent-worker.service`，MySQL 容器 `fcm-staging-db` 仅 127.0.0.1:3307）
- 失联兜底：`recoverStalledTasks()` 把超时 `running` 任务重新排队（最多 2 次）后置 failed，env `EMPLOYEE_TASK_STALL_MINUTES`（默认 10）
- 实测：云端任务 claimed→done 130s 回写结构化产出；桌面端 `FCM_SMOKE_EXECUTOR=1` 冒烟 claimed→done 且 artifacts=2；`scripts/smoke-t19.mjs` 12/12
- 文档：`docs/handoff/T19-云端执行器与隔离机.md`（含隔离机部署/运维/边界）

## T-29 运营后台 Web 控制台（2026-11-05 已完成）
- 零构建静态 SPA：`packages/server/public/admin/{index.html,styles.css,app.js}`，Nest 同源托管 `/admin/`（`main.ts` 里 `serveStatic(join(__dirname, "..", "public", "admin"))`）
- 8 个视图：概览（9 卡 + 模型用量）/ 订单（筛选+确认收款）/ 用户（调积分、启停、重置密码）/ 积分套餐（新建改价下架）/ 兑换码（批量生成、禁用删除）/ AI 员工（17 个，改价上下架）/ 模型与媒体定价 / 站点配置（通用表单 + AI 接口）
- 登录 `POST /api/auth/admin/login`（默认 admin/admin），token 存 localStorage；后端字段自动成表单，密钥字段 `****` 原样提交即不改
- 验证：`scripts/smoke-admin-ui.mjs` 11 项并入 verify；`scripts/shot-admin.mjs` 用 CDP 驱动 Edge headless 逐页截图，实测**0 JS 异常**
- 文档：`docs/handoff/T29-运营后台.md`

## T-30 媒体编排（数字人 / 音色克隆 / 素材库，2026-11-05 已完成）
- 服务端三模块：`compose-videos`（lipsync/mixcut/news 状态机 + 轮询推进 + 回调 + 转存）、`clone-records`（indextts 音色克隆）、`audio-materials`（音频素材库），全部 `imports: [MediaModule]`，复用 media 的提交/计费/OSS 归档
- 状态机：lipsync/realman_mix → `cloning_audio` →（轮询到上游 RUNNING）`composing` → `completed`/`failed`；mixcut/news → `composing` → `completed`/`failed`
- 归属键沿用原版 `phone`（`common/owner.ts` 的 `resolvePhone`），跨用户访问一律 404
- 计费：提交即按 `MediaPricing` 预扣（lipsync 1.2 积分/秒、indextts 10/次），上游失败自动退款；媒体任务不吃免费额度
- 桌面端：`pages/MediaStudio.tsx` 数字人页（上传人像图+音频 → 提交 → 8s 轮询状态 → 成片/转存/删除）与音色克隆页（样本上传 + 克隆记录 + 音频素材库）；11 个 IPC `media:*`
- 上游：RunningHub 三个 AI App 均已配（lipsync 2031016553440878594 / indextts 1965614643077070850 / smart_clip 2096795601945350145），节点号全部 env 可覆盖（`RUNNINGHUB_NODE_TTS_*`、`RUNNINGHUB_NODE_CLIP_*`）；未配置时提交返回 400 并退款
- 实测：音色克隆 5.19 秒 mp3（约 30 秒完成）；混剪 15.08 秒 1280×736 mp4（约 12 分钟完成，建议前端提示「渲染中」）
- 契约修复：完成后 `resultUrl` 与 `videoUrl` 同步回填（原版前端读 videoUrl，否则「任务完成但看不到成片」）
- 验证：`scripts/smoke-t30.mjs` 27 项全绿并并入 verify；`verify.ps1 -Smoke` GREEN
- 文档：`docs/handoff/T30-媒体编排.md`

## 派工：先能用三件事（2026-11-06，Codex 执行）
- **T-31** 桌面端「文生图 / 图生视频」两个创作 tab —— ✅ 已完成并 GUI 验收（**2026-11-06 用户决定把这些入口折叠进「🧪 高级 / 实验」，默认收起**：原版客户端并没有这两个一级入口，见 `docs/handoff/界面偏差登记.md` D-01）（真实出图、扣 20 积分、结果链接可下载；截图 `docs/handoff/T31-文生图验收.png`，记录 `docs/handoff/T31-文生图-图生视频.md`）
- **T-33** 成本护栏：账号级媒体次数/秒数/并发上限 + 上游 consumeCoins 汇总与亏损标记
- **T-32** 员工执行链路接入能力层与媒体（受控工具循环，让员工能查数据→出稿→出图出片）
- 任务书：`docs/handoff/T31-T33-任务书.md`；看板 `docs/handoff/BOARD.md`
- 生产验收基线：`docs/handoff/生产验收-2026-11-06.md`（登录 7.6s 对话 / 文生图 274s / 图生视频 232s，均归档 OSS）
## T-28 本地能力层（原版 .pyc 技能的明文实现，2026-11-05 首批完成）
- 原版 11 个预装技能里 7 个自研技能是 CPython 3.13 字节码且无 LICENSE → 已裁决不随包（`docs/决策-预装技能分发.md`），改为明文重写其原子能力
- 首批 7 个能力：`web_extract` / `content_save` / `content_query` / `distribution_save` / `customer_save` / `customer_query` / `llm_text`，返回结构与原版 `tool_box.py` 同构（`{success,data,error,error_code}`）
- 入口：`GET /api/capabilities`（清单）、`POST /api/capabilities/run {name,params}`、`POST /api/capabilities/:name`；未鉴权 401
- 顺手修真 bug：`toolapi.aiText()` 原先把 phone 当 userId 传给计费链路 → AI 早报/话术/代理全部「失败且无原因」；现按 phone 解析 User 再计费
- 验证：`scripts/smoke-capabilities.mjs` 13 项全绿并并入 verify；生产已部署（`https://ai.fcmediaagent.com/api/capabilities`）
- 文档：`docs/handoff/T28-能力层.md`

## 媒体限额（2026-11-06 口径定稿：只保留全局上限）
- 生效三项：`MEDIA_DAILY_LIMIT`（默认 50 次/日）、`MEDIA_DAILY_SECONDS_LIMIT`（600 秒/日）、`MEDIA_CONCURRENT_LIMIT`（并发 3 个）；检查与预扣同事务，被拒不产生扣费
- **不加按类型的次数上限**（曾实现「图 2 次/视频 1 次」后按用户决定撤回）：分类额度属于产品口径，随定价/套餐一起定
- 内测期要整体收紧只需调小 `MEDIA_DAILY_LIMIT`
- 文档：`docs/handoff/媒体日限额.md`

## 跨 Agent 协作（Codex / WorkBuddy / DeepSeek Harness）

三个 Agent 在不同应用里干活，靠**磁盘即总线**衔接，不靠聊天记录。

- 入口：仓库根 `AGENTS.md`（开工契约）→ `docs/handoff/README.md`（协议）→ `docs/handoff/BOARD.md`（看板）
- 单一事实源：`docs/handoff/state.json`；流水账：`JOURNAL.md`；点对点留言：`inbox/<agent>.md`
- CLI：`node scripts/coord.mjs resume|claim|done|note|msg|status`（零依赖，任一 Agent 的 shell 都能跑）
- 一键环境：`scripts/dev-up.ps1`（Docker+MySQL+服务端，等 /api/health）、`scripts/dev-down.ps1`
- 完成闸门：`scripts/verify.ps1`（服务端 tsc + 桌面端 build，`-Smoke` 追加接口冒烟），绿灯才算 done
- 增量交接：每个 Agent 有 `marks/<agent>.json`，"上次看之后发生的事"由 `resume` 直接列出
- Codex 侧：`~/.codex/AGENTS.md` 已写入本项目入口指引（该文件原为空）
- WorkBuddy 侧：`.codebuddy/` 已放入项目入口说明与当前计划

分工原则：**同一写作用域同一时刻只有一个 Agent 写**；schema 与 `.env` 为独占资源；跨域修改先 `msg`。
## 媒体链路（RunningHub 数字人/对口型，2026-11-05 已跑通）

- 生产已可调用：上传素材 → 提交任务 → 轮询 → 结果转存到自己域名。
- 实测：3 秒 720p 对口型，`taskId 2118298192458375170`，94 秒出片，扣 4 积分（3×1.2 向上取整），
  结果 `https://ai.fcmediaagent.com/uploads/media/2118298192458375170.mp4`（HTTP 200，273KB，video/mp4）。
- 上游结果 URL 只有 24 小时有效 ⇒ 转 SUCCESS 时自动下载到 `uploads/media/<taskId>.<ext>` 并改写 `resultUrl`，
  原始地址留在 `resultMeta.sourceUrl`；关掉用 `ARCHIVE_MEDIA_RESULTS=false`。
- lipsync 节点号：image 444 / audio 1755 / seconds 1583 / start 1776 / prompt 1624 / resolution 1606 / fps 1586（可用 env 覆盖）。
- 媒体任务**不消耗每月免费额度**，直接扣积分；余额不足返回 402。
- OSS 已启用（桶 zhongke001，用户提供的 RAM key）：成片 SUCCESS 后**自动归档 OSS**（`media/auto/<taskId>.<ext>`，OSS 优先、本机 uploads 兜底），详见 `docs/handoff/媒体链路-RunningHub.md`。