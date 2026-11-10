# 任务看板（自动生成，勿手改）

> 生成时间 2026-11-10T08:08:56.248Z · 单一事实源 `docs/handoff/state.json`

**当前阶段**：P10（先能用三件事）派工完成，看板 29/33 —— 用户要求先能用、定价后置：T-31 桌面端出图出片 / T-32 员工多步干活 / T-33 成本护栏 已派 Codex；dsh-lead 推主线（生产可用性收口 + 复核），T-11 渠道仍 blocked(env)。

| ID | 任务 | 状态 | 负责人 | 心跳 | 写作用域 |
|---|---|---|---|---|---|
| T-01 | 服务端骨架（NestJS11 + Prisma + 短信/JWT 登录 + 站点配置 + health） | done | dsh-lead | - | packages/server/src |
| T-02 | 模型代理 + 按次计费（compute 代理、proxy-token、额度/积分、用量流水） | done | dsh-lead | - | packages/server/src/compute, packages/server/src/billing, packages/server/src/providers |
| T-03 | 桌面端骨架 + 聊天链路 + openclaw 网关接入 | done | dsh-lead | - | packages/desktop |
| T-04 | F2 契约基线矩阵（路由/IPC/表/字段/文案） | done | dsh-lead | - | docs/fidelity-matrix.md, scripts/audit |
| T-05 | M6.5 员工域后端 W4（5 表 + 17 员工 seed + 11 API + 冒烟） | done | dsh-lead | - | packages/server/src/employee, packages/server/prisma |
| T-06 | 原版资产考古（预装技能/提示词/插件/语音/离线缓存） | done | dsh-lead | - | docs/assets-inventory.md |
| T-07 | W5：定时器 + 补跑 + 任务看板后端（EmployeeCron 落地） | done | codex | - | packages/server/src/employee |
| T-08 | W5：团队套餐授权（兑换码 traffic/private-domain/flagship）+ 员工订单 + 到期失效 | done | dsh-lead | 11-04 13:21 | packages/server/src/employee, packages/server/src/orders |
| T-09 | 桌面端「办公区」员工 UI（目录/安装/运行/任务流/审批） | done | codex | 11-04 13:41 | packages/desktop/src |
| T-10 | P3：预装 11 技能落地 + AGENTS/TOOLS 提示词注入 + bundles 技能市场 | done | dsh-lead | 11-05 09:07 | packages/desktop/resources, packages/desktop/src/main |
| T-11 | P4：渠道接入（企微 / 公众号 / 个人微信自研 UIAutomation） | blocked(env) | codex | 11-04 21:39 | packages/server/src/channels, packages/desktop/src/main |
| T-12 | P5：微信支付 V3 + 订单 + 兑换码 + 最小后台（admin 路由子集） | done | dsh-lead | 11-05 06:38 | packages/server/src/payments, packages/server/src/orders, packages/server/src/admin |
| T-13 | P6：NSIS 安装包 + 自动更新（含 asar 热更）+ 首启引导 | done | dsh-lead | 11-05 08:14 | packages/desktop/electron-builder.yml, scripts |
| T-14 | P7：F2 契约收口（路由/IPC/表三张 diff 打到约定线）+ 文案对齐 | done | dsh-lead | 11-05 08:34 | docs/fidelity-matrix.md |
| T-15 | P8：媒体链路（数字人/对口型/混剪）走第三方云 API | done | codex | 11-04 20:43 | packages/server/src/media |
| T-16 | toolapi 私域销售助手（32 路由 / 8 表） | done | codex | 11-04 14:28 | packages/server/src/toolapi |
| T-17 | 定价批注：积分包 + 媒体计价（原版为占位价） | done | dsh-lead | 11-05 07:05 | packages/server/prisma/seed.ts |
| T-18 | 协作基础设施：coord 总线 + AGENTS.md + dev/verify 脚本 | done | dsh-lead | - | AGENTS.md, scripts/coord.mjs, docs/handoff |
| T-19 | T-19 云端任务执行器 + 桌面心跳离线判定（承接 codex T-07 遗留） | done | dsh-lead | 11-05 09:05 | packages/server/src/employee |
| T-20 | 模型接口 JWT 签名与过期验证修复 | done | codex | 11-04 12:44 | packages/server/src/compute |
| T-21 | README 当前决策更新与原版拆解覆盖评估 | done | codex | 11-04 13:06 | README.md |
| T-22 | 原版关键流程证据台账、改进计划与执行提示词 | done | codex | 11-04 13:17 | docs/execution |
| T-23 | 模型流式扣费风险隔离复现与修复 | done | dsh-lead | 11-05 06:28 | packages/server/src/compute, packages/server/src/billing |
| T-24 | 短信验证码生成与并发核销安全修复 | done | codex | 11-04 13:25 | packages/server/src/auth |
| T-25 | 协作快照支持文件路径作用域 | done | codex | 11-04 13:52 | scripts |
| T-26 | 修正F2审计器的混淆IPC和路由归一化处理 | done | codex | 11-04 14:08 | scripts/audit |
| T-27 | 补齐公开鉴权状态探针 | done | codex | 11-04 14:41 | packages/server/src/auth |
| T-28 | T-28 能力重写：原版 7 个 .pyc 技能的明文本地实现（agent-tool-box 36 能力中优先 8-10 个） | done | dsh-lead | 11-05 14:45 | packages/server/src |
| T-29 | T-29 管理后台 Web 控制台（零构建静态 SPA） | done | dsh-lead | 11-05 09:12 | packages/server/public,packages/server/src/main.ts,scripts/smoke-admin-ui.mjs |
| T-30 | W5 媒体编排补齐：compose-videos 状态机 + clone-records + audio-materials + 桌面「数字人」「音色克隆」两页 | done | dsh-lead | 11-05 13:41 | packages/server/src/media, packages/server/src/compose-videos, packages/server/src/clone-records, packages/server/src/audio-materials, packages/desktop/src, packages/server/prisma, scripts |
| T-31 | 桌面端：文生图与图生视频两个创作 tab（接 MediaStudio + 服务端已通的 /api/media/images/generations 与 /api/media/video/generations） | done | dsh-lead | 11-05 18:09 | packages/desktop/src |
| T-32 | 员工执行链路接入能力层与媒体生成（能力层 /api/capabilities + 媒体出图出片，支持多步任务） | done | codex | 11-05 19:10 | packages/desktop/src/main, packages/server/src/employee, packages/worker |
| T-33 | 成本护栏：账号级媒体与模型限额、单日上限、余额封顶与超额提示、成本核算口径 | done | codex | 11-05 18:30 | packages/server/src/media, packages/server/src/billing, packages/server/prisma |
| T-34 | T-34 web_extract 抓取守卫修复（生产全量误拦） | done | dsh-lead | 11-05 19:54 | packages/server/src/capabilities |
| T-35 | T-35 员工工具循环 JSON 容错（减少 invalid 步浪费） | done | dsh-lead | 11-05 20:05 | packages/worker |
| T-36 | T-36 员工技能注入（服务端）：AiEmployee.skillMd + 生成脚本 + seed + DTO | done | dsh-lead | 11-05 20:36 | packages/server/prisma |
| T-37 | T-37 员工执行器读取 skillMd + 步数上限 4->10 | done | dsh-lead | 11-05 20:36 | packages/worker |
| T-38 | T-38 技能内容生成器（SKILL.md -> skills-content.ts） | done | dsh-lead | 11-05 20:23 | scripts |
| T-39 | T-39 云端技能注入复核及修复 | done | codex | 11-05 20:53 | packages/worker, packages/server/src/employee, scripts |
| T-40 | P11-A F2 缺口分级与取舍（Codex） | done | codex | 11-07 05:29 | docs/handoff/F2-缺口分级与取舍.md |
| T-41 | P11-B 17 员工 SKILL.md 工具需求映射 | done | skill-tool-mapper | 11-07 05:05 | docs/handoff/P11-技能需求映射.md |
| T-42 | 工作区静态目录匿名访问本地阻断与回归 | done | codex | 11-07 07:24 | packages/server/src/main.ts, packages/server/src/common/workspace-static-guard.ts, scripts/test-workspace-static-guard.mjs |
| T-43 | 工作区文件鉴权下载及桌面接入 | done | codex | 11-07 07:28 | packages/server/src/workspace, packages/desktop/src/main/index.ts, packages/desktop/src/preload/index.ts, packages/desktop/src/renderer/src/pages/EmployeeOffice.tsx, packages/desktop/src/renderer/src/types.ts, scripts/test-workspace-download.mjs |
| T-44 | 员工文本产物安全交付及私有对象写入 | done | codex | 11-07 07:33 | packages/server/src/capabilities/capabilities/files.ts, packages/worker/tool-loop.mjs, packages/worker/cloud-executor.mjs, packages/desktop/src/main/executor.ts, packages/desktop/src/renderer/src/pages/EmployeeOffice.tsx, scripts/test-workspace-artifacts.mjs |
| T-45 | P17 工具第三批：image_understand 看图 + 员工派活/查任务 + 定时任务创建/列表/删除 | done | dsh-lead | 11-07 14:26 | packages/server/src/capabilities, packages/worker, scripts |
| T-46 | P18 长期记忆检索（记忆保存/搜索/列表/删除） | done | dsh-lead | 11-07 14:48 | packages/server/src/capabilities/capabilities/memory-tools.ts |
| T-47 | P19 记忆语义检索（扩展+候选补齐+重排，关思考提速） | done | dsh-lead | 11-07 15:57 | packages/server/src/capabilities |
| T-48 | P20 记忆自动去重/合并 + 多轮追问改写 | done | dsh-lead | 11-08 09:09 | packages/server/src/capabilities |
| T-49 | P21 存量重复记忆清理（报告/执行两段式，保留较早条目） | done | dsh-lead | 11-08 09:30 | packages/server/src/capabilities |
| T-50 | P22 记忆清理定时任务（每周日 03:00 自动 apply + 管理端状态/手动触发） | done | dsh-lead | 11-08 09:57 | packages/server/src/capabilities |
| T-51 | P23 记忆管理页（服务端 REST + 桌面页面） | done | dsh-lead | 11-08 10:24 | packages/server/src/memory |
| T-52 | P24 平台发布 RPA（抖音/小红书/视频号，本机 Electron 自动化） | done | dsh-lead | 11-08 11:09 | packages/desktop/src/main |
| T-53 | P25 平台作品数据快照 + P27 桌面文件/定时任务接线（0.1.11） | done | dsh-lead | 11-08 19:37 | packages/desktop |
| T-54 | T-54 P26 定时发布（客户端本地队列 + 到点自动发 + 桌面页） | done | dsh-lead | 11-08 21:09 | - |
| T-55 | T-55 发布前置登录态预检 + 0.1.13 | done | dsh-lead | 11-08 21:53 | - |
| T-56 | P28 登录态检查缓存（切页不重查） | done | dsh-lead | 11-09 04:38 | packages/desktop/src/main/platform.ts, packages/desktop/src/renderer/src/pages/PlatformPublish.tsx |
| T-57 | T-57 P29 窗口复用+协议守卫 + P30 取数接线 + P31 多平台分发（0.1.15） | done | dsh-lead | 11-09 07:27 | - |
| T-58 | T-58 P32 平台评论回复（读评论+回复）+ 0.1.16 发布 | done | dsh-lead | 11-09 08:26 | - |
| T-59 | P34 抖音/小红书真机发布校准 + 0.1.17 | done | dsh-lead | 11-09 11:58 | - |
| T-60 | P35 评论真机校准（视频号读+回复）+ 0.1.18 | done | dsh-lead | 11-09 16:51 | - |
| T-61 | P35 视频号发布真机校准（语法错误/shadow 按钮/successUrlHints）+ 0.1.19 | done | dsh-lead | - | - |
| T-62 | P36 修 platform:status 报 Object has been destroyed（含抖音 cookie 误判）+ 0.1.20 | done | dsh-lead | 11-10 06:24 | - |
| T-63 | P37 修「点平台发布弹出视频号助手」（0 透明度渲染）+ 抖音冷启动误报「打开页面失败」+ 0.1.21 | doing | dsh-lead | 11-10 08:08 | packages/desktop/src/main/platform.ts, scripts/check-desktop-p24.mjs, scripts/check-desktop-p25.mjs, docs/handoff/P37-平台页弹窗与冷启动误报.md |

**未完成任务详情**

### T-11 · P4：渠道接入（企微 / 公众号 / 个人微信自研 UIAutomation）
- 状态：blocked · 负责人：codex
- 验收：至少一条外部 IM 消息走通 网关→agent→计费→回复
- 写作用域：packages/server/src/channels, packages/desktop/src/main
- 断点：`docs/handoff/checkpoints/T-11.md`

### T-63 · P37 修「点平台发布弹出视频号助手」（0 透明度渲染）+ 抖音冷启动误报「打开页面失败」+ 0.1.21
- 状态：doing · 负责人：dsh-lead
- 验收：-
- 写作用域：packages/desktop/src/main/platform.ts, scripts/check-desktop-p24.mjs, scripts/check-desktop-p25.mjs, docs/handoff/P37-平台页弹窗与冷启动误报.md
