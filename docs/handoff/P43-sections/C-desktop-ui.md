# C 域 · 桌面客户端（页面 / 导航 / 交互流 / IPC）对照报告

> 路径缩写：`R` = C:/Users/30290/Desktop/部署文件/_extract/renderer_0429_strings.txt（行号即证据）；`IO` = .../_extract/ipc_handles_0429.tsv（行号=通道序号）；`D` = packages/desktop/src。原版主/渲染层 `renderer_deob.js` 为单行混淆，渲染层实际调用某命名空间以其字面量出现次数为证（下称「命中数」）。

## 1. 本域范围
桌面客户端的一级页面/侧栏导航项集合、登录与引导流、对话流（模型切换/流式/中断/会话）、员工办公区与任务、媒体生成与历史、积分与兑换入口、设置项、以及 147 条 IPC 契约中「UI 真正用到的通道」在复刻侧的能力映射。

## 2. 对照表

| 行为点 | 原版证据 | 复刻实现 | 判定 | 说明 |
|---|---|---|---|---|
| 一级导航项集合 | R:8566-8574（新对话/定时任务/素材管理/广告投放/Agents/工作台/仪表盘/开发者控制台）+R:6356-6370 | D/renderer/src/pages/Shell.tsx:60-86（13 项） | PARTIAL | 原版 9 项中「素材管理/广告投放/工作台·仪表盘/Agents 市场」无对应页；新增数字人/音色/记忆/战略/平台发布/文件属批准新增 |
| 侧栏退出登录确认 | R:8586「确定要退出登录吗？退出后需要重新验证手机号登录。」 | D/renderer/src/pages/Shell.tsx:97 → D/renderer/src/App.tsx:32 直接 logout | DIVERGENT | 无二次确认，误点即掉线且需重新收码 |
| 对话会话持久化/列表 | R:14804/14811/14852 + R:13962 sessions.messages.subscribe + 会话删除 ipc | D/renderer/src/pages/Chat.tsx 全文无 session 调用；preload 无 session 命名空间 | MISSING | 复刻对话仅内存态，关窗即丢，无法回看/删除 |
| 流式输出 | 原版 chat 流（R:36195 stream-thinking 等） | D/main/index.ts:592-633 逐行 `data:` 解析发 `chat:chunk`(627)，结束 `chat:done`(631) | ALIGNED | 逐 token 增量渲染等价 |
| 中断生成 | R:36378 abortRun、R:40659「已请求停止」、R:10247「已停止」 | D/main/index.ts:592-633 无 AbortController/reader.cancel；Chat.tsx:99 仅「发送/生成中」 | MISSING | 长回答只能等，不发停止事件 |
| 思考/工具调用过程可见 | R:6989/6993 thinkingLabel、R:36183 Thinking | Chat.tsx:19-27 只渲染 delta 文本 | MISSING | 原版展示 thinking/tool calls/handoff 三段状态 |
| 模型切换 | R:8915「选择模型」、R:8917「模型切换失败：{{error}}」、R:8609「未选择模型」 | Chat.tsx:15 `models[0]` 固定，无选择器 | PARTIAL | 用户无法选模型，也无切换失败文案 |
| 登录方式 | R:10164 账号登录 / R:10274 验证码登录 / R:10267 微信登录（R:10268-10269 扫码关注确认） | D/renderer/src/pages/Login.tsx:42-45 两 tab（短信/密码） | PARTIAL | 缺微信扫码登录；原版无图形验证码/协议勾选，复刻亦无=一致 |
| 手机号校验文案 | R:10252「手机号格式不正确」、R:10251「请输入手机号」 | Login.tsx:55 仅 `length<11` 禁用取码 | PARTIAL | 无格式错误提示，非 11 位手机号静默禁用按钮 |
| 验证码发送反馈 | R:10259「验证码已发送」、R:10260「验证码发送失败」 | Login.tsx:57 明文回显 devCode，失败直抛后端 message | PARTIAL | 无「已发送」成功态文案；devCode 明文仅联调用 |
| 登出后强制重新验证 | R:8602、R:8601 语义 | App.tsx:32 logout 清 token；App.tsx:20-22 启动即 auth.me() 失败则 logout | ALIGNED | 登录态判定链等价 |
| 新手引导步骤 | R:9694-9716「第 {{current}} / {{total}} 步」(9717)、「跳过教程」(9714)、「上一步」(9715)、「开始使用」(9716)+「一键创建 AI 团队」(9702) | D/renderer/src/pages/Onboarding.tsx:5 三步（欢迎/服务端/完成）、76-78 无跳过 | PARTIAL | 引导结束不安装任何员工，落地即空办公区；无「教程」可重入 |
| 引导默认服务端 | 原版为本地 gateway/openclaw（R:8597「网关未运行」、R:8599） | Onboarding.tsx:9 默认 `https://ai.fcmediaagent.com/api` | INTENTIONAL | 云服务端架构（批准改造），云端 base 概念原版无 |
| 设置页 tab 集合 | settings_keys.tsv:132-139 六 tab（飞书/公众号/VX机器人/账号登录/文案策略/IP口播），账号登录含抖音/小红书/视频号/B站「打开浏览器登录」(222-229) | D/renderer/src/pages/Settings.tsx:18-37 仅服务器地址+版本+更新 | MISSING | 渠道登录态/文案策略/口播/公众号配置项在设置页全缺（部分散落到平台发布页） |
| 主题/语言/开机自启 | R:6443-6450 theme/Light/Dark/System/Language/launchAtStartup；R:8606/8684 开机自启与计划任务 | 无 | MISSING | 三项设置项均无 |
| 定时任务开关/立即执行 | IO:110-111 cron:toggle、cron:trigger（渲染层 cron: 命中 18 次） | preload cron 仅 list/create/remove；D/renderer/src/pages/Scheduled.tsx 无开关/立即跑 | PARTIAL | 建好的任务只能删，不能暂停或立刻触发一次 |
| 文件管理操作集 | IO:120-129 file:*(8)+media:getThumbnails；渲染层 file: 命中 20 | D/main/file-ops.ts:321-334 files:* 8 条 + D/renderer/src/pages/Workspace.tsx（面包屑/200KB 预览/删除确认 285-297） | ALIGNED | 名称不同能力等价：listTree↔list、readText↔read、writeText↔write、listDir/stat↔list、readBinary↔open |
| 打开外链 / 在文件夹显示 / 打开文件 | IO:71-73 shell:openExternal/showItemInFolder/openPath | D/main/index.ts:174、file-ops.ts:330、file-ops.ts:336 | ALIGNED | 三条能力全命中 |
| 原生对话框 | IO:74-76 dialog:open/save/message | D/main/index.ts:477/519/540（open/save） | ALIGNED | 无 dialog:message，确认类交互统一用 window.confirm |
| 积分与用量 | IO:100 usage:recentTokenHistory + R:18873/18880/36027 会员与充值 | preload credits:balance/usage-records + D/renderer/src/pages/Credits.tsx:16-34 | INTENTIONAL | 订阅→积分钱包（批准改造）；仅余额与流水，无充值入口 |
| 兑换码激活入口 | R:9665-9681「请输入兑换码…兑换成功：{{name}}（{{count}} 个角色）」；服务端 packages/server/src/employee/package.controller.ts:29-43 | 全仓 `*.tsx` 对 redeem/兑换/redemption 命中 **0**；preload 无 packages/redeem | MISSING | 服务端校验文案齐备（package.service.ts:117-140），客户端无入口 |
| 广告投放（腾讯广告） | R:8569「广告投放」、R:6362-6363；渲染层 tads: 命中 21 | 无 | MISSING | 整个垂直无对应页/IPC |
| 素材管理 | R:8568、R:6360-6361、R:17469 /materials | 无独立素材库页（Workspace + media 列表部分替代） | PARTIAL | 无按素材维度检索/复用 |
| 员工安装与派活 | R:9667/9702「一键创建 AI 员工/团队」、R:9507「任务看板」 | D/renderer/src/pages/EmployeeOffice.tsx:98-110 安装团队、144-155 提交任务、66-81 6s 轮询 | PARTIAL | 首团队 3 人（与 docs/M6.5-AI员工团队域.md:13 一致，非 bug）；无跨员工任务看板/团队大脑视图 |
| 未读消息/通知 | R:17275 sidebar.unreadMessages | 无 | MISSING | 侧栏无未读角标 |
| 网关控制台入口 | R:8573「开发者控制台」、R:8764、R:17592 /api/gateway/control-ui | D/renderer/src/pages/Gateway.tsx:48 `gateway.controlUrl()` 后 window.open | ALIGNED | 同名 gateway:status/start/stop/restart（15 条同名通道之一） |

## 3. 高价值差异

| # | 差异 | 影响 | 建议修法 | 优先级 | 预估 |
|---|---|---|---|---|---|
| 1 | 客户端无兑换码入口（服务端 POST /packages/redeem 已有） | 用户买到码却无法激活，等于收不到钱 | preload 增 `packages.redeem`；Shell 积分页加「兑换码激活」卡；失败态直接透传 package.service.ts:117-140 五条中文 | P0 | 0.5d |
| 2 | 对话无会话持久化/列表 | 关窗即丢上下文，用户会认为「聊天记录丢了」 | 加 `sessions:*`（服务端无 sessions 模块，grep 命中 0，需先补增删查接口或客户端本地落盘）；Chat 增左栏会话列表+新建+删除 | P0 | 2d |
| 3 | 无法中断生成 | 长回答/错方向只能等满 | main 用 AbortController 持有 reader，preload 加 `chat.cancel`，Chat 按钮切「停止」 | P1 | 0.5d |
| 4 | 无模型切换器 | 用户无法按成本/能力选模型 | Chat 顶部加 `models` 下拉，默认与 `compute:models` 首项一致，失败显示「模型切换失败：{{error}}」 | P1 | 0.5d |
| 5 | 退出登录无二次确认 | 误点掉线，重登需重新收码 | `window.confirm('确定要退出登录吗？…')` 包在 App.tsx:32 | P1 | 10min |
| 6 | 定时任务无 toggle/trigger | 任务只能删，无法暂停或立刻验证一次 | cron-ops 补 `cron:toggle`/`cron:trigger`（服务端 employee.controller.ts:97 已有 PATCH :id 可承载 enabled；「立即运行」复用 employees/run），Scheduled 行内加开关与「立即运行」 | P1 | 0.5d |
| 7 | 引导不落建队 | 引导宣称「装完即用」，完成后办公区空 | Onboarding 末步加「安装获客成交团队」(复用 EmployeeOffice.installTeam 逻辑) 或直接跳员工办公区并预选团队 | P1 | 0.5d |
| 8 | 设置页缺渠道/文案策略/口播/公众号配置 | 用户找不到渠道登录与策略阈值 | 设置页补四 tab（渠道登录态复用自建 RPA 登录；文案策略落 Prisma 全局配置） | P1 | 2d |
| 9 | 手机号格式校验缺失 | 输错号只会看到按钮禁用，不知所措 | Login.tsx:55 前置 `/^1[3-9]\d{9}$/` 校验并提示「手机号格式不正确」 | P2 | 10min |
| 10 | 无主题/语言/开机自启 | 与原版设置心智不符 | 设置页加三项，开机自启用 `app.setLoginItemSettings` | P2 | 0.5d |
| 11 | 无未读消息/任务看板 | 员工跑完无提醒，需手动轮询发现 | 侧栏未读角标 + 任务完成 Toast（员工任务已有 approval 态） | P2 | 1d |
| 12 | 无「素材管理」「广告投放」页 | 原版一级入口缺失（广告投放另需腾讯资质） | 素材页复用 media 列表做素材库；广告投放先不宣称，或在矩阵文档注明不做 | P2 | 素材 1d / 广告 待定 |
| 13 | token 为空仍发 `Bearer null` | 未登录调 chat 时错误信息为 401 而非「请先登录」 | D/main/index.ts:114-129 统一在无 token 时抛「登录已过期，请重新登录」 | P2 | 10min |
| 14 | 无 thinking/工具调用可视化 | 员工/Agent 过程不可见，信任度低 | chat 事件增 `type` 字段（text/thinking/tool），Chat 分块渲染 | P2 | 1.5d |

## 4. 已确认一致的点
1. 文件管理八条操作与语义（D/main/file-ops.ts:321-334 ↔ IO:120-129），含「打开交给系统程序」的二进制降级与删除二次确认。
2. 网关能力：status/start/stop/restart 与「打开控制台」入口（Gateway.tsx:48 ↔ R:8764/17592），且为 15 条完全同名通道之一。
3. 登录态机：登出后必须重新手机验证码登录（App.tsx:20-22/32 ↔ R:8586/8602）。
4. 无图形验证码、无用户协议勾选、无「忘记密码」（双方均如此，R:10250-10274 无对应文案）。
5. 删除类高危操作均二次确认：文件（Workspace.tsx:285-297）、定时任务（Scheduled.tsx:323）、记忆（Memory.tsx:161）、人设（Strategy.tsx:290）。

## 5. 存疑 / 无法验证
- 原版「账号登录」tab 是否含密码登录：R 仅见 10250「手机号」/10258「短信验证码」，未检索到密码字段文案；复刻密码 tab 对应服务端 `auth/password-login`，无法判定是否与原版同源。
- `uv:`/`env:`（IO:90-94，渲染层命中 uv:6 / env:9）在原版是引导内装 Python/wxauto；复刻若已把运行时打进安装包则能力等价，未验证安装包内容与资源目录。
- `clawhub:` 渲染层命中 0（main 5），技能市场是否由 UI 展示、是走 IPC 还是 HTTP `/api/clawhub/list`（R:17719）未确认。
- 复刻服务端无 sessions 模块（packages/server/src 内 grep `sessions` 命中 0），差异 #2 实际工期可能 >2d。
- 原版「素材管理」页数据源（本地素材 vs 服务端）未确认，故本报告只判 PARTIAL 而非 DIVERGENT。
- 腾讯广告 `tads:` 21 条是否仍在线可用、是否需广告主资质，未验证；亦未在用户定向裁剪清单中出现，故按真缺口登记而非 INTENTIONAL。
