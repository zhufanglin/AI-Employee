# B 域｜员工域 · 提示词注入 · 工具调用循环 · 定时/队列/审批 · 工作流

## 1. 本域范围
员工目录/安装/我的、任务状态机与队列租约、验收审批、定时任务调度、派活、system prompt 分层与截断、工具 JSON 协议容错、toolapi 32 条语义、员工到期与订单状态推进。

## 2. 对照表

| 行为点 | 原版证据 | 复刻实现 | 判定 | 说明 |
|---|---|---|---|---|
| 市场/详情是否公开 | employee.controller.js:56-62（:slug 无 guard）、:41-47（marketplace 无 guard，可选 req.user） | employee.controller.ts:15-18/30-33 + app.module.ts:53 全局 JwtAuthGuard | DIVERGENT | 复刻未加 @Public，游客浏览员工详情/市场一律 401；原版这两个接口匿名可访问 |
| marketplace 购买态字段 | employee.service.js:21-48（purchased / userExpiresAt / userPurchaseStatus） | employee.service.ts:67-86（catalog 原样返回，无 purchased） | DIVERGENT | 前端无法直接渲染"已购/剩余 N 天"，只能与 mine 对比；字段名 baseline 对不上 |
| 列表排序 | employee.service.js:24 sortOrder asc + createdAt desc | employee.service.ts:81 sortOrder asc + createdAt asc | DIVERGENT | 同 sortOrder 员工顺序相反 |
| 不存在文案 | employee.service.js:55,64 'AI员工不存在或已下架'；:132 'AI员工不存在' | employee.service.ts:90 '员工不存在或已下架' | DIVERGENT | 文案丢"AI"，命中文案基线差 1 字 |
| 详情返回内容 | employee.service.js:50-58 返回整行（含 soulContent/agentConfig/systemLogs） | employee.service.ts:170-173 serialize + skillMd | PARTIAL | 字段在但 soulContent 为空且无人读（见下） |
| 安装/授权模型 | employee.service.js:59-93 免费员工 upsert purchase + downloads+1 | employee.service.ts:95-136 独立 aiEmployeeInstall + assertAccess + 忽略客户端 days | INTENTIONAL | 安装制/兑换码改造；授权到期由服务端唯一决定，实现正确 |
| 卸载语义 | employee.service.js:127-147 purchase.status='cancelled'（软删） | employee.service.ts:138-142 deleteMany 物理删除 | DIVERGENT | 安装历史不可追溯，重复安装无痕迹；购买记录仍在，重装即恢复 |
| 预装员工移除 | employee.service.js:133-135 '预装员工无法移除' | employee.service.ts:138-142 无 isBundled 拦截 | DIVERGENT | 预装员工可被"移除"，从我的员工中消失、需重装才能再跑；原版明确禁止 |
| 关键文案命中 | employee.service.js:70 '付费员工请通过订单购买'、:76 '您已购买过该员工'；toolapi.service.js:255 '没有符合条件的潜在客户' | 全仓 grep 均无对应文案 | DIVERGENT | 4 条原版中文错误文案缺失，用户侧错误提示与原文案基线不一致 |
| 我的员工来源 | employee.service.js:94-125 bundled 全量 + active 未过期 purchase，slug 去重 | employee.service.ts:144-168 只读 install 表 | PARTIAL | 已付款未安装的员工不出现在"我的"；原版买完即在列表 |
| 我的员工到期字段位置 | employee.service.js:108-117 顶层 expiresAt/durationDays/pricePerDay | employee.service.ts:158-161 嵌在 install.* | DIVERGENT | 前端取值路径不同，易静默 undefined |
| 任务数据源 | 原版 47 表无任务表（schema.prisma 全表清单）；看板靠 gateway session + cron-executions + 本地 SQLite（renderer_0429_strings.txt:9543） | prisma/schema.prisma:732-764 EmployeeTask | INTENTIONAL | 新增能力；但状态集合是自造，非原版移植 |
| 任务状态取值 | 看板 5 文案：工作中/创建中/执行中/已完成/待执行（renderer_0429_strings.txt:9502-9506）；全库无"待验收/审批/needs_input" | employee.service.ts:8-15 六态含 needs_input/awaiting_approval | INTENTIONAL | needs_input 全仓无写入点，属死状态；审批态为新增 |
| 状态回写权限 | 无对应（原版无该接口） | employee.service.ts:376-392 只要值在 TASK_STATUSES 内就接受，含 succeeded | DIVERGENT | 任何持 token 客户端可把 running/awaiting_approval 直接改 succeeded，绕过 :420-446 审批 |
| 无令牌回写 | — | employee.service.ts:400-418 未带 claimToken 时直接 tx.update，无 status/令牌约束 | DIVERGENT | 第二台设备或重放可覆盖他人产出；带令牌分支才有 running+令牌双条件 |
| 抢任务/租约 | 原版 gateway 自行调度，无 claimToken | employee.service.ts:312-367 + employee-execution.service.ts:37-81 原子 updateMany + UUID | INTENTIONAL | 实现正确（status:'queued' 条件更新，双设备不会双领） |
| 卡死回收 | 原版 gateway 用 job.state.runningAtMs 跳过运行中（main_deob.js@1179469 附近） | employee.service.ts:271-309 10 分钟无心跳→requeue×2→failed | INTENTIONAL | 机制合理；但 recover 只在 pull 时触发，无人拉取则永不回收 |
| 节点心跳与任务租约 | — | employee-execution.service.ts:15-18 90s 判 offline；任务要 10min 才回收 | PARTIAL | 同一时刻 UI 显示节点离线、任务仍"执行中"，用户感知矛盾 |
| 回写失败兜底 | — | desktop/src/main/executor.ts:198-205、worker/cloud-executor.mjs:174 仅 log 'report-failed' | PARTIAL | PATCH 失败后任务停在 running，等 10 分钟回收重跑，产生重复产出 |
| 任务积分字段 | workflow.controller.js:38-45 + workflow.service.js:42-57 服务端权威扣减接口 | employee.service.ts:392-395 creditsCharged 由客户端上报，仅校验非负 | DIVERGENT | 统计字段可伪造；实际扣费走 compute.service.ts:82 预扣，无双重扣费 |
| 审批流 | 原版不存在（全库无审批/待验收文案） | employee.service.ts:420-446 approve/reject | INTENTIONAL | 新增；approve→succeeded、reject→failed+reason，落地正确 |
| 审批超时与重跑 | — | 无超时、无自动通过、reject 后不重跑 | PARTIAL | 用户不点则任务永久挂起，且不计入失败统计 |
| 定时调度位置 | OpenClaw gateway cron（main_0429_strings.txt:3903 cron.list/3907 cron.add/3855 update/3856 remove/3858 run） | employee-cron.service.ts:64-95 服务端 15s tick + 乐观锁 | INTENTIONAL | 架构替换；乐观锁占位 updateMany 正确，一档任务只发一次 |
| cron IPC 面 | ipc_handles_0429.tsv:106-111 六条 list/create/update/delete/toggle/trigger | cron-ops.ts:204-207 注册 4 条；preload/index.ts:92-95 只暴露 3 条 | MISSING | 无 cron:update/toggle/trigger → 渲染层无法暂停、改时间、立即执行；Scheduled.tsx 只有发布开关 |
| 错过补跑语义 | main_deob.js catchUpMissedSchedules：24h 窗口内 cron.run 强制补跑，窗口外跳过，disabled/running 跳过 | employee-cron.service.ts:77 missed=now-runAt≥60s → 额外建 status:'failed', error:'missed_schedule' 占位任务 | DIVERGENT | 服务重启超 1 分钟即多出假失败记录，污染成功率/失败 Top5；原版不写失败记录 |
| cron 时区/表达式 | gateway job 带 tz字段；UI 默认本地时区 | cron-ops.ts:40/124-126、employee-cron.service.ts:37-39 默认 Asia/Shanghai + 5 段校验 | ALIGNED | 时区语义与表达式校验一致，异常文案中文可读 |
| cron 去重 | team-cron 先 remove 再 create（main_0429_strings.txt:4598 '[team-cron] Removed existing job before recreate'） | capabilities/employee-tools.ts:271-303 无同名/同表达式去重 | DIVERGENT | 重复创建同表达式任务 → 到点重复执行、重复计费 |
| 员工失效时 cron | cron-disabled-heal 自动停用并记录（main_0429_strings.txt:4694/4700） | employee-cron.service.ts:82 只推进 nextRunAt 静默跳过 | PARTIAL | 用户看不到"为什么没跑" |
| system prompt 分层 | workspace bootstrap：AGENTS.clawx.md(5行)+TOOLS.clawx.md+SOUL.md（soulContent 经 /api/team/write-soul 写入，main_deob.js 命中该路由） | tool-loop.mjs:108-133 INSTRUCTIONS→能力说明→needs→SKILL.md→战略→人设；executor.ts:91-120 岗位 system | PARTIAL | 顺序与预算自洽，但 soulContent 全仓死字段（schema.prisma:407 唯一定义，无读写），人设只剩 personaText 1500 字 |
| AGENTS/TOOLS 上下文 | 原版每会话自动注入 AGENTS.clawx.md（5 行 554B）+ TOOLS.clawx.md（17 行 1400B） | desktop/resources/context/AGENTS.md 由 workspace-assets.ts:54 写入，但 tool-loop.mjs 不读 | MISSING | 文件落地但未参与提示词；"先查工具再拒绝/不可逆先确认"等硬约束实际不生效 |
| 截断预算 | 原版无显式预算（交 OpenClaw/模型窗口） | tool-loop.mjs:48 SKILL 8000、:57-58 战略 6000 / 人设 1500、能力说明 12000 | EXTRA | 预算合理；6000 字符战略会截断长文档，截断提示存在 |
| 工具协议 | 原生 function calling | tool-loop.mjs:4 单 JSON {"tool","params"}，:6-33 围栏/深度扫描容错，:35-46 三键兼容 | INTENTIONAL | provider 限制下的合理替代；非法 JSON 回灌纠偏（:187-188） |
| 循环终止 | 模型自然结束即完成 | tool-loop.mjs:190 未调 finish 走满 8 步 → '达到执行步数上限，任务尚未完成' | PARTIAL | 模型直接给正文（不包 JSON）会判失败，原版不会 |
| toolapi 32 条路径 | server1027_routes.txt:195 起（/toolapi/ai/chat 等） | toolapi.controller.ts:8-39 | ALIGNED | 32/32 路径与返回包裹一致 |
| 今日沟通生成 | toolapi.service.js:229-272 按 3天/7天筛客户 + AI 生成 1-5 条话术，空集抛 '没有符合条件的潜在客户' | toolapi.service.ts:32 全量 20 客户 + 固定文案"根据客户资料生成首轮跟进建议" | DIVERGENT | 核心功能空心化：无筛选、无 AI、无 NotFound 分支 |
| 每日分发 | toolapi.service.js:134-160 早报+海报+飞书写入 | toolapi.service.ts:23 仅早报落库 | PARTIAL | 缺海报；飞书按 INTENTIONAL 不接 |
| AI 代理计费 | ai-api.service.js:84-112 平台 token 直连、不扣积分、错误 'AI API Token 未配置…' | toolapi.service.ts:25 走 compute 预扣积分 + 账号状态校验 | DIVERGENT | 计费口径 INTENTIONAL；但错误码改为 '未配置可用模型'/'账号已被禁用'，文案基线不命中 |
| 海报/个人微信 | toolapi.service.js:130-133 出图；:459-503 代理 wxauto | toolapi.controller.ts:13 poster('','')、:37-39 三条 BadRequest 占位 | PARTIAL | 海报 INTENTIONAL 折叠到媒体；wxauto 由自研网桥替代，但接口返回体不同 |
| 派活父子链 | 原版无派活（parentSlug 是员工层级） | capabilities/employee-tools.ts:190-256 建任务但不落 parentTaskId、不回传父任务 | MISSING | 派活链不可追溯，父任务无法汇总子结果；并发上限 5 为自造约束 |
| 员工到期推进 | employee-expiry.scheduler.js:44-55 @Cron('0 * * * *')/('*/5 * * * *') 自动 | 无 @Cron；仅 package.controller.ts:129 手动 admin expire-scan | MISSING | purchase.status 长期停在 active，后台"有效会员"统计虚高；运行侧靠 expiresAt 兜底，不会错放行 |
| 订单状态轮询 | server1027_routes.txt:91 GET /employee-orders/:id/status | package.controller.ts:47 段 GET :id/status 把 id 当 orderNo 查询 | DIVERGENT | 前端拿创建返回的 order.id 轮询必然 '订单不存在' |
| 续费天数 | employee-order.service.js:160-166 baseDate + order.durationDays，durationDays 累加 | employee-order.service.ts:99-154 durationDays 覆盖为本次天数 | DIVERGENT | 续费后"购买天数"显示变小，与原版累加口径不同 |

## 3. 高价值差异

| # | 差异 | 影响 | 建议修法 | 优先级 | 预估 |
|---|---|---|---|---|---|
| 1 | updateTask 接受 succeeded，可绕过审批 | 验收形同虚设；任何客户端可自审通过 | TASK_STATUSES 拆分为"执行器可写集合"（仅 running/awaiting_approval/failed/needs_input），succeeded 只能由 approve 写 | P0 | 0.5d |
| 2 | 无 claimToken 的 PATCH 无状态约束 | 两台设备/重放互相覆盖产出 | 强制 claimToken，缺失直接 400 | P1 | 0.2d |
| 3 | 无 @Public：/employees/:slug、marketplace 需登录 | 游客/落地页 401，原版匿名可浏览 | 两个 GET 加 @Public，marketplace 内部按可选 user 补 purchased | P1 | 0.3d |
| 4 | marketplace 缺 purchased/userExpiresAt/userPurchaseStatus | 市场页购买态与剩余天数不可渲染 | 按 slug 查 purchase+install 补三字段，字段名对齐原版 | P1 | 0.5d |
| 5 | cron 缺 update/toggle/trigger（IPC+UI） | 定时任务不能暂停/改时间/立即执行 | preload 补 update/toggle、main 注册 cron:update、Scheduled 加开关与"立即执行"（复刻 cron_update 能力已存在） | P1 | 1d |
| 6 | missed_schedule 假失败任务 | 每次重启污染成功率与失败 Top5 | 改为只建一条 catch-up 任务并写 missed=true，不再造 failed 记录 | P1 | 0.3d |
| 7 | dispatch 无 parentTaskId | 派活链断，父任务无法汇总/取消子任务 | EmployeeTask 加 parentTaskId，dispatch 落库，task_status 回带子任务摘要 | P1 | 1d |
| 8 | 员工到期无自动调度 | 后台会员/续费统计长期失真 | employee.module 加 @Cron，每小时 expireEmployees、每 5 分钟关过期订单（对齐原版两条表达式） | P1 | 0.3d |
| 9 | GET /employee-orders/:id/status 用 id 查 orderNo | 前端轮询订单状态必失败 | status 支持 id 或 orderNo（先 findUnique id，再 orderNo） | P1 | 0.2d |
| 10 | generateTodayCommunications 空心化 | "AI 沟通策略"卖点失效 | 恢复 3天/7天+interaction 筛选与 AI 生成，空集抛原版文案 | P1 | 1d |
| 11 | soulContent 不注入（死字段） | 员工人设只剩 1500 字账号人设，与原版 SOUL.md 注入不等价 | seed 填 soulContent；executor 在 skill 之后注入并给预算（如 3000 字符） | P1 | 1d |
| 12 | 审批无超时、驳回不重跑 | 任务永久挂起；驳回后只能手动重派 | awaiting_approval 超时（如 24h）自动提醒/归档；reject 支持 autoRetry 生成新 queued 任务 | P1 | 1d |
| 13 | AGENTS.md/TOOLS.md 未注入 | 原版硬约束（先试工具、不可逆先确认）实际不生效 | tool-loop 读 resources/context/*.md 拼到 INSTRUCTIONS 后（各限 2000 字符） | P2 | 0.5d |
| 14 | cron 无去重 | 重复点击生成多条同表达式任务，重复执行扣费 | cron_create 前按 userId+employeeId+cronExpr 查重，命中则复用/报错 | P2 | 0.2d |
| 15 | 预装员工可移除、4 条错误文案缺失 | 误操作与提示不一致 | uninstall 判 isBundled 直接报原版文案；补齐 4 条原文案 | P2 | 0.3d |
| 16 | needs_input 死状态、finish 强制、物理删除、排序差异 | 一致性细节 | 各自小改 | P2 | 1d 合计 |

## 4. 已确认一致的点
1. toolapi 32 条路径与 {success,data} 返回结构 32/32 命中（toolapi.controller.ts:8-39 vs server1027_routes.txt:195 起）。
2. 抢任务/租约实现正确：updateMany 以 status:'queued' 为条件 + UUID claimToken，双设备不会双领（employee.service.ts:340-360）。
3. cron 表达式 5 段校验、时区默认 Asia/Shanghai 与异常中文文案一致（cron-ops.ts:124-126、employee-cron.service.ts:37-39）。
4. '预装员工无需购买'（employee-order.service.ts:41 vs employee.service.js:67）与'没有可用的内容数据'（toolapi.service.ts:21 vs toolapi.service.js:99-129）逐字一致。
5. 时区语义与"安装有效期由服务端唯一决定"（忽略客户端 days/expiresAt，employee.service.ts:99-113）口径正确，无客户端延长授权漏洞。

## 5. 存疑 / 无法验证
1. 原版任务看板的"创建中/工作中"数据源未见服务端接口，判断来自 gateway session 与本地 cron-executions.json（main_0429_strings.txt:4498、5416），未能在渲染层确认字段级映射，故状态机对比只能按文案口径。
2. 原版 SOUL.md 是否由 soulContent 全量写入：main_deob.js 只确认存在 /api/team/write-soul 与 strings 'No soul template found'，未能定位 write-soul 的 body 组装点，人设注入宽度按"存在 SOUL.md bootstrap"判定。
3. agent-plan（原版 2 路由，routes:59-60）属代理分成计费，复刻未实现，已在 fidelity-matrix 标 BLOCKED，本域未计入偏差。
4. 原版 toolapi poster/wxauto 的真实返回体（图片 URL 字段名、wxauto 响应结构）只能从代码推断，未跑过运行时抓包。
5. 复刻 compute 预扣是否覆盖全部工具调用（media 生成、doc_write）未逐条验证，creditsCharged 与 AiUsageRecord 的汇率关系无契约文档。