# P43 · 域 D：媒体链路 + 渠道接入 + 微信生态 + 网关

> 证据路径约定（下文所有 :行号 均相对此根）：
> **ORIG-SRV** = `C:\Users\30290\Desktop\部署文件\_extract\server1027\dist\`；**ORIG-RES** = `C:\Users\30290\Desktop\部署文件\_extract\0.4.29\app\resources\`；**ORIG-STR** = `C:\Users\30290\Desktop\部署文件\_extract\main_0429_strings.txt`；**ORIG-IPC** = `C:\Users\30290\Desktop\部署文件\_extract\ipc_handles_0429.tsv`；**REPL-SRV** = `C:\Users\30290\Desktop\fcmediaagent-replica\packages\server\src\`；**REPL-DSK** = `C:\Users\30290\Desktop\fcmediaagent-replica\packages\desktop\src\main\`；**REPL-BRG** = `C:\Users\30290\Desktop\fcmediaagent-replica\packages\wechat-bridge\wechat_bridge\`

## 1. 本域范围
媒体任务（提交/轮询/回调/归档/退款/取消/计费）与其周边三张业务表（音色素材、克隆记录、合成视频），加上企微/公众号/个人微信三条消息通道、openclaw 网关职责、以及抖音/小红书/视频号本机 RPA 发布与取数。

## 2. 对照表

| 行为点 | 原版证据（文件:行） | 复刻实现（文件:行） | 判定 | 说明 |
|---|---|---|---|---|
| 媒体路由集合 | ORIG-SRV`media-proxy\media-proxy.controller.js:117-199`（9 条：5 submit + template + tasks + files/temp + oss-transfer） | REPL-SRV`media\media.controller.ts:9-28`（另加 usage/summary、cancel、webhook、files/upload） | PARTIAL | 主链路一一对应；多出的 4 条是新增能力（见矩阵 channels/media 扩项），缺 files/temp 真实上传 |
| 提交响应体形状 | ORIG-SRV`media-proxy\media-proxy.service.js:56-72` 返回 `user_billing:{task_type,estimated_amount,status:'pending'}` | REPL-SRV`media\media.service.ts:339` 返回 `{taskId,status,estimatedAmount,upstream}` | DIVERGENT | 字段名与结构全换，前端若读 `user_billing.estimated_amount` 拿到 undefined，无法显示预估扣费 |
| 计费口径（预扣 vs 结算） | ORIG-SRV`media-proxy\media-user-billing.service.js:65-127`：settle 时 `actual=ceil(pricePerInputSecond*effectiveSeconds)`，diff>0 补扣到余额 0（`isPartialDeduct`）、diff<0 退差价，写 aiUsageRecord | REPL-SRV`media\media.service.ts:293` 只算 `estimatedAmount`；全库无 settle 路径，`settledAmount` 仅在退款时置 0（`:350-364`） | DIVERGENT | **按用户声明时长收费、成功后不按实际时长结算/退差**；per_input_second 计费时与"实际用量"脱钩 |
| 价格未配置的报错 | ORIG-SRV`media-proxy\media-user-billing.service.js:21-34` → `HttpException 503`「媒体任务 ${taskType} 未配置用户价目或已停用」 | REPL-SRV`media\media.service.ts:45-54` → `BadRequestException 400`「媒体任务类型未配置」 | PARTIAL | 状态码 503→400、文案改写；前端若按 503 做「请联系管理员」降级会走成表单错误 |
| 任务状态机词表 | ORIG-SRV `prisma\schema.prisma:134` 注释 `pending|settled|refunded`，service 实际只写这三态 | REPL-SRV`media\media.service.ts:318,336,343` 写 `SUBMITTING/QUEUED/RUNNING/...`，成功写 `SUCCESS`，**从不写 settled**，但 `packages\server\prisma\schema.prisma:132` 注释仍写 pending/settled/refunded | DIVERGENT | 状态词表已换，schema 注释过期；按原版状态做统计/对账的脚本会全部落空 |
| 上游受理失败的退款 | ORIG-SRV`media-proxy\media-proxy.service.js:34-73`：preCharge 后失败 refundCharge，返回 502 中文「请求 Agent 总站点失败」/「Agent 未返回 task_id」 | REPL-SRV`media\media.service.ts:340-366`：400/ProviderRejected → refundFailure(FAILED)，否则置 `REVIEW` + 502「媒体任务提交结果待核对，请勿重复提交并联系客服」 | ALIGNED | 复刻加了乐观锁白名单与「不确定就不退款、进人工核对」，比原版更安全 |
| 提交不确定态的人工兜底 | 原版无：网络超时后记录永久 pending，无人处理 | REPL-SRV`media\media.service.ts:468-484` pendingReviews（REVIEW 或 SUBMITTING 超 10 分钟）+ resolveReview（refund/track） | INTENTIONAL | 新增能力，修复原版悬挂任务；文案「请填写核对依据（4 至 500 字）」 |
| 任务查询的用户隔离 | 原版 `media-auth.guard` 按手机号签发，GET tasks/:taskId 不校验归属用户 | REPL-SRV`media\media.service.ts:400-404` `findFirst({taskId,userId})` | ALIGNED | 复刻更严；跨用户不可读他人任务 |
| 回调的身份校验 | 原版无 webhook 路由 | REPL-SRV`media\media.controller.ts:20-25` 校验 `RUNNINGHUB_WEBHOOK_SECRET` + header，未配置即 401；但 `media.service.ts:429` 按 taskId 全局查询、不带 userId | PARTIAL | 回调合法但「按 taskId 全局查」在多租户下依赖密钥强度；建议回调也校验 taskId∈库内 userId 归属（本就由 taskId 唯一约束保证，风险低） |
| 结果归档 | 原版不归档，直接回传上游 URL（`media-proxy.service.js:112-142` 只 uploadTemp） | REPL-SRV`media\media.service.ts:254-285`：SUCCESS 时 OSS 或本机 `uploads/media/` 兜底，>300MB 跳过，失败静默保原 URL | INTENTIONAL | 应对上游 24h 临时 URL；失败静默是可接受的降级 |
| `files/oss-transfer` 契约 | ORIG-SRV`media-proxy\media-proxy.service.js:215-278`：OSS 配置读 **DB ossConfig**、必须带 `phone`、key=`video/${phone}/${uuid}.ext`、`x-oss-object-acl: public-read`、返回 `{ossUrl}` | REPL-SRV`media\media.service.ts:488-512`：OSS 五项读 **env**、无 phone、key 前缀 `media/${userId}/`、`Content-Disposition: inline`、返回 `{url}` | DIVERGENT | 归属键（phone→userId）、配置源（DB→env）、响应字段（ossUrl→url）三处都变；前端读 `ossUrl` 会拿到 undefined |
| `files/temp` 上传 | ORIG-SRV`media-proxy\media-proxy.controller.js:189` `FileInterceptor('file',{limits:{fileSize:500*1024*1024}})` 真上传 | REPL-SRV`media\media.service.ts:487` `tempFile` 直接回 `{...body, uploadUrl:null, expiresIn:900}`，**不上传任何字节** | MISSING | 前端若仍走 files/temp 拿 uploadUrl，会拿到 null 并静默失败；真实上传被挪到 `files/upload`（base64，60MB 上限） |
| 自定义工作流节点 | 原版无此概念（nodeInfoList 由服务端按 mode 生成） | REPL-SRV`media\media.service.ts:288` 拒绝非空 nodeInfoList，但 `:81` 又允许直接使用 | PARTIAL | 同一能力两处口径相反（死代码），且 `:288` 的 400 文案会暴露给终端用户 |
| 模板接口 | ORIG-SRV`media-proxy\media-proxy.controller.js:173` 真实取上游模板 | REPL-SRV`media\media.service.ts:486` `return {items: []}` | MISSING | 复刻「高级/实验」里的智能混剪模板下拉会是空列表 |
| 用量汇总 | 原版无 | REPL-SRV`media\media.service.ts:450-466` 按 taskType 聚合，`costStatus` 恒为「待核算」 | PARTIAL | 新增后台视图，但上游成本永远「待核算」，无法据此对账（需要人工填 resultMeta.usage.consumeCoins） |
| 音色素材上传 | ORIG-SRV`audio-materials\audio-materials.controller.js` 50MB multipart + `audio-materials.service` 走 `ossConfig`、key `audio/${phone}/` | REPL-SRV`audio-materials\audio-materials.service.ts` 改走 `media.upload`（RunningHub，base64/URL），无 50MB 拦截；仍以 phone 归属 | INTENTIONAL | 上游换成 RunningHub 的必然结果；缺文件大小上限是新的边界缺口（60MB 由 media.upload 兜） |
| 克隆记录 create 语义 | ORIG-SRV`clone-records\clone-records.service.js`：只落库，`status:'polling'` 固定，`taskId` 由客户端给，必填 phone/type/sourceUrl/taskId，不调上游 | REPL-SRV`clone-records\clone-records.service.ts:19-39` 真调 `media.submit(indextts,{audio,text})`，`taskId` 用上游返回值 | DIVERGENT | 语义从「登记客户端结果」变成「发起合成任务」；且 `media.service.ts:94` 要求 text，**按原版四字段调用会 400「缺少要合成的文本（text）」** |
| 合成视频 musetalk 回调 | ORIG-SRV`compose-videos\compose-videos.controller.js`：取 `video_task_id|task_id|id`、`video_url|url|result_url|videoUrl` 多别名，**查不到也返回 `{code:0,message:'ok'}`**（幂等吞掉） | REPL-SRV`compose-videos\compose-videos.service.ts` callback：只认 taskId/musetalkTaskId/smartClipTaskId，查不到 `NotFoundException`「任务不存在」 | DIVERGENT | 上游重试时会持续收到 404/500；别名不兼容，上游若用旧字段名则永远匹配不到记录 |
| 合成视频 create | ORIG-SRV 只落库，初态 mixcut/news→`composing`、其余→`cloning_audio`，无扣费 | REPL-SRV`compose-videos\compose-videos.service.ts` 真提交 + 真扣费（走 media.submit） | DIVERGENT | 有扣费即比以前多一道失败面；状态初值与终态文案沿用原版映射（一致） |
| 形象/场景视频 | ORIG-SRV`scene-videos\scene-videos.controller.js`：6 路由 + yidevs 场景克隆（100MB 上传） | 复刻无 `scene-videos` 模块，`packages\server\prisma\schema.prisma` 无 SceneVideo 表 | INTENTIONAL | 已在 `docs/fidelity-matrix.md:274` 判 CUT（自建 GPU 依赖）；但 `GET scene-videos/health` 没有等价健康页 |
| 渠道接入模型 | 原版是 openclaw 插件通道：`ORIG-STR:503-527`（wecom/dingtalk/telegram/discord/qqbot/mattermost/whatsapp/openclaw-weixin/openclaw-lark）+ `ORIG-IPC:48-55`（8 个 channel:* 配置 IPC）+ `:116-117` WhatsApp 二维码登录 | 复刻改成 NestJS 自研 dispatcher，仅 3 通道（`REPL-SRV``channels\dispatcher.service.ts:11` wecom/wechat-mp/personal-wechat），IPC 换成 `REPL-DSK\index.ts:582-590` channel:personal-wechat-* | DIVERGENT | 覆盖 Telegram/Discord/QQ/Mattermost/WhatsApp/飞书 全部缺失；`channel:saveConfig/getConfig/listConfigured/setEnabled/validate` 在桌面端不存在（`index.ts` 只有 gateway:* 与 personal-wechat-*） |
| 公众号职责 | ORIG-SRV`wechat-oa\wechat-oa.controller.js:265-295` 只有 GET/POST callback，业务**仅扫码登录**（4 位码、登录成功客服消息、「验证码无效或已过期，请重新扫码获取新验证码。」） | REPL-SRV`channels\channels.controller.ts:148-181` 公众号回调做 AI 员工任务分发；无扫码登录（`WechatLoginSession` 表缺失，见 `docs/fidelity-matrix.md:142`） | DIVERGENT | 原版"公众号=登录入口"的职能消失，改成新职能；公众号扫码登录这条路在复刻里彻底没有 |
| 渠道配置存储 | 原版 `wechat-oa.service.js` 读 DB `wechatOaConfig(isActive)` 并用 CryptoService 解密 appSecret，后台 `/admin/wechat-oa-config`（`server1027_routes.txt:14-17` 含 upload-qr/verify-callback） | REPL-SRV`channels\channels.config.ts` 全部读 env，缺配置静默降级；无 admin 配置接口 | PARTIAL | 运营无法在后台改渠道凭证（改 env 要重启），也没有二维码上传/回调自检 |
| 渠道消息幂等 | 原版无对应链路（公众号不派任务） | REPL-SRV`channels\dispatcher.service.ts:98-148` 只把 `msgId` 塞进 input，**不查重**；企微回调 `channels.controller.ts:85-104` 同步 await 建任务后才回包 | MISSING | 企微 5 秒未回包会重试同一条 MsgId → 重复建任务、重复扣算力；需要按 msgId 唯一键或快速 ACK 后异步建任务 |
| 渠道结果推送形态 | 原版无长文本问题（只回固定短文案） | REPL-SRV`channels\dispatcher.service.ts:33-38,260-282`：企微 600 字/公众号 1800/个人微信 1500，超长给 `channels/result/:taskId?t=HMAC` 网页 | INTENTIONAL | 新增能力；`channels\result-page.ts:21` 两个密钥都为空时回落到硬编码串「fcmediaagent-channel-result」，任何人可用已知 taskId 伪造链接（P2） |
| 个人微信桥接口面 | `ORIG-RES\wxauto\web_server.py:358-2973` 约 130 个 `/api/v1/*` 端点（bot 起停、listen-mode/only、朋友圈点赞评论发布、自动加好友、关键词、定时消息、转发规则、会话摘要、知识库、激活码、告警） | `REPL-BRG\app.py:170-246` 共 6 个：healthz、bot/status、memory/list、chat/messages、chat/send、chat/send-file、chat/listen-list | PARTIAL | 只保留"收发+会话列表"最小集；bot 生命周期、朋友圈、加好友、关键词、定时、知识库全部缺失 |
| 个人微信桥契约细节 | 原版 Flask：`config/.port` 端口发现 + `config/internal_api_token` + GET `/api/v1/token` 回环兜底；发送路径 `/api/v1/chat/send_file`（下划线） | 复刻 FastAPI：`REPL-BRG\config.py:57-110` 固定 `WECHAT_BRIDGE_PORT=18990`、`WECHAT_BRIDGE_TOKEN`；`auth.py:16-28` Bearer 严格比对；路径 `chat/send-file`（连字符） | DIVERGENT | 端点命名与发现机制都不兼容，任何沿用原版 wxauto 的前端/脚本都不能直接对接 |
| openclaw 网关职责 | 原版随包 `ORIG-RES\openclaw\`（含 `openclaw.mjs` 与 channel 插件）+ `openclaw.json` 里配 channels/accounts | REPL-DSK`gateway.ts:98-122` 生成的 openclaw.json 只有 gateway/session/models/agents，**无 channels 段**；`:124-174` 只做 spawn/健康探测/日志 | PARTIAL | 网关退化为"纯模型转发进程"，原版用网关承载的 8 条 IM 通道能力在复刻中无处落地 |
| 平台 RPA 发布终态 | `ORIG-RES\resources\preinstalled-skills\douyin-automation\SKILL.md`（v3.0）：「发布到草稿箱 publish_to_draft.py」，即**只到草稿箱**，人工再发 | REPL-DSK`platform.ts:2090-2145` `waitPublishOutcome`（120s/2s 轮询、25s 点一次重试）+ `:2338-2360`，成功以「跳转到作品管理/列表」为准 | INTENTIONAL | 用户要求自动发布，允许实现不同；复刻是"真发布并等结果"，比原版草稿箱更接近用户目标 |
| 抖音采集/转写/私信 | 同上 SKILL.md：collector/downloader/transcriber(Vosk)/send_message 四件套 + 产物目录 `collections/<关键词>_<时间戳>/` | 复刻桌面端无对应实现（全仓库仅 `platform-drivers.ts:94` 的评论页 URL） | MISSING | "对标视频→拆解→二创"这条原版主流程在复刻中完全没有 |
| 抖音/小红书评论回复 | `auto_reply.pyc`：关键词搜视频→扫评论区→按 comment_keywords/reply_templates 回复 | REPL-DSK`platform-drivers.ts:37`：「抖音、小红书创作后台网页版都没有评论管理页」，只有视频号可读评论/回复 | PARTIAL | 复刻在抖音/小红书上的评论运营能力弱于原版技能；只能靠视频号（P1 建议明确告知用户） |
| volcengine 密钥池 | ORIG-SRV`volcengine\volc-key-pool.service.js`：所有方法直接抛「密钥池已迁移到 Agent 服务器」 | REPL-SRV`compute\` 无密钥池实现，代理走 env/DB | ALIGNED | 原版已是死代码，复刻不实现不算缺口 |

## 3. 高价值差异

| # | 差异 | 影响 | 建议修法 | 优先级 | 预估 |
|---|---|---|---|---|---|
| 1 | 媒体计费只有预扣、无结算（`media.service.ts:293` vs `media-user-billing.service.js:65-127`） | per_input_second 定价下，用户按声明时长被扣、成功后不按实际时长补扣/退差；钱算错，且 `MediaTaskRecord` 永远没有 settled 记录 | 在 webhook/getTask 成功分支调 `settleMediaTask()`：actual=ceil(per*effectiveSeconds)，diff>0 补扣至余额 0 记 isPartialDeduct、diff<0 退 credits（不改 totalCreditsConsumed），写 aiUsageRecord | P0 | 1.5d |
| 2 | 渠道回调无 MsgId 幂等（`dispatcher.service.ts:98-148`） | 企微/公众号超时重试 → 同一需求重复建任务、重复扣算力，用户收到多份结果 | 加 `ChannelInboundMsg(msgId @unique)` 或 Redis SETNX；命中直接回 ACK 不建单；并把建任务改成回包后异步 | P0 | 0.5d |
| 3 | 提交响应字段 `user_billing` 消失（`media.service.js:56-72` vs `media.service.ts:339`） | 前端展示"预估扣 X 算力"读不到值；用户看不到本次预扣，投诉计费 | 响应加 `user_billing:{task_type,estimated_amount,status:'pending'}` 兼容字段（可与新字段并存） | P0 | 0.2d |
| 4 | `clone-records.create` 语义改成"发起任务且必填 text"（`clone-records.service.ts:19-39` + `media.service.ts:94`） | 前端按原版四字段（phone/type/sourceUrl/taskId）调用直接 400「缺少要合成的文本（text）」，音色克隆入口不可用 | create 支持 text 缺省（缺省时用 sourceUrl 建 record 不提交上游，走原版"登记"语义）；仅在带 text 时提交 | P1 | 0.5d |
| 5 | `files/temp` 空壳（`media.service.ts:487`） | 旧前端/旧契约调用返回 `uploadUrl:null`，上传静默失败且无报错 | 要么实现 multipart 真上传（500MB 限），要么显式 410 + 文案「请改用 files/upload」 | P1 | 0.5d |
| 6 | 公众号职能被替换，扫码登录消失（`wechat-oa.controller.js:265-295` 无对应实现） | 原版"公众号扫码登录客户端"的用户路径不存在；若存量用户走此路径会卡死 | 若保留登录路径：补 `WechatLoginSession`（矩阵已标 MISSING_TABLE）与 4 位码文案；否则在发布说明里显式声明该入口下线 | P1 | 2d（若需要） |
| 7 | 渠道配置只能 env（`channels.config.ts`） | 运营改企微/公众号凭证必须改 env 重启；无 admin 配置页、无二维码上传、无回调自检 | 补 `WecomConfig/WechatMpConfig` 表 + admin CRUD + 回调自检（对齐原版 `/admin/wechat-oa-config` 三件套） | P1 | 2d |
| 8 | `oss-transfer` 契约三处变更（`media.service.ts:488-512` vs `media-proxy.service.js:215-278`） | 前端读 `ossUrl` 得到 undefined；按 phone 归档的历史目录结构断掉 | 响应同时返回 `ossUrl` 与 `url`；objectKey 保留 `phone` 维度或双写 | P1 | 0.3d |
| 9 | 抖音采集/转写/私信整条链缺失 | 原版"竞品视频→拆解→二创"主流程不可用，17 员工里的视频类技能只能拿到平台数据不能拿素材 | 复用原版 skill 包（playwright+ffmpeg+vosk）挂到 `capabilities` 工具层，先做"单条 URL 采集+转写" | P1 | 3d |
| 10 | 抖音/小红书评论回复不可用（仅视频号） | 用户提出"评论自动回复"时在抖音上直接做不到 | 改用创作者中心「私信/评论」接口或抖音开放平台；短期在 UI 上把能力限定到视频号 | P1 | 1d |
| 11 | 个人微信桥能力面仅 6/130 端点 | bot 起停、朋友圈、加好友、关键词、定时消息、知识库全部没有；用户"微信生态"预期落空 | 按优先级补：bot 起停 + listen-mode + 关键词 + 定时消息（朋友圈/知识库后置） | P1 | 3d |
| 12 | `musetalk-callback` 从幂等吞掉变 404（`compose-videos.service.ts`） | 上游重试持续报错，可能被判"回调不可用"而停推 | 恢复幂等：查不到返回 `{code:0,message:'ok'}` 仅记日志；并兼容 video_task_id/task_id/url 别名 | P1 | 0.3d |
| 13 | 长结果页签名有硬编码兜底密钥（`result-page.ts:21`） | `JWT_SECRET`/`CHANNEL_RESULT_SECRET` 都为空时，任何人可对已知 taskId 伪造全文链接 | 缺密钥时不生成长结果链接（直接截断），移除硬编码兜底 | P2 | 0.2d |
| 14 | `smart_clip/template` 返回空（`media.service.ts:486`）、`costStatus` 恒「待核算」（`:450-466`） | 模板下拉空、成本视图永远不能闭环 | 模板从 env/DB 读；costStatus 由 resultMeta.usage.consumeCoins 是否齐全推导 | P2 | 0.5d |
| 15 | openclaw.json 不含 channels（`gateway.ts:98-122`） | 网关只剩模型转发；原版 8 条 IM 通道 + `channel:*` IPC 无处配置 | 明确取舍：要么把 dispatcher 的 3 条通道暴露成网关 channel 插件，要么在文档标注 openclaw 通道能力不再提供 | P2 | 2d |

## 4. 已确认一致的点
1. 媒体 5 个提交路由的 URL 与 taskType 映射逐条一致（`media.controller.ts:9-15` ↔ `media-proxy.controller.js:117-165`）。
2. 失败退款都做到"锁用户余额 + 写反向流水 + 置终态"，且复刻额外加白名单防重复退款（`media.service.ts:350-364`）。
3. `audio-materials`/`clone-records`/`compose-videos` 列表接口都以 **phone** 做归属过滤，与原版同一归属维度（复刻额外收窄 userId）。
4. 企微/公众号回调都实现验签 + AES 解密 + 5 秒内被动回复（`wechat-oa.controller.js:265-295` 同构；复刻 `channels\wecom\wecom.service.ts`、`crypto\wechat-mp-crypto.ts`）。
5. volcengine 代理路由 `/volcengine-proxy/v3/chat/completions`、`/models` 与 `/volcengine/proxy-token` 与原版一致（`server1027_routes.txt:224-227` ↔ `compute\volcengine-proxy.controller.ts:14`）。

## 5. 存疑 / 无法验证
- 原版 `media-proxy` 的 agent 总站返回值里 `billing.input_seconds` 的真实精度（秒/毫秒）无从观测——`media-user-billing.service.js:74-111` 只是透传；复刻没有对应字段，补 settle 时需与 RunningHub 的 `usage.consumeCoins` 对照实测。
- 原版 `wechat-oa-h5.controller.js`（8.5KB）未细读，公众号 H5 登录页的完整交互/文案可能与本报告结论有补充。
- 原版 openclaw 的 wecom/dingtalk 插件本体不在 `0.4.29\app\resources\resources\openclaw-plugins\`（该目录只有 `clawx-openai-image`），只能从 `ORIG-STR:503-527` 与 `ORIG-IPC:48-55` 推断其存在与配置项，无法核对消息出入格式。
- 原版 `wxauto\manager.ts`（62KB）未逐行读，个人微信进程由谁拉起（主进程 spawn vs 独立服务）未确认；复刻走独立 nssm/ps1 服务（`packages\wechat-bridge\scripts\`），形态不同。
- RunningHub 各 `apiId` 的实际节点语义（如 smart_clip 114/224/115/135）只能靠 env 覆盖验证，本仓库无上游文档可对；`media.service.ts:81` 与 `:288` 对 nodeInfoList 的矛盾需产品确认是否要开放自定义。
