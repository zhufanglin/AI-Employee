# P43 域A：服务端账号与钱（认证/用户/积分计费/订单/支付/兑换码/订阅取舍/管理员后台/统计）

证据缩写：O = C:\Users\30290\Desktop\部署文件\_extract\server1027\dist；R = C:\Users\30290\Desktop\fcmediaagent-replica\packages\server\src。行号来自本次逐行读取与 grep。

## 1. 本域范围

原版 auth/users/credits/compute-proxy/payment/orders/redemption/subscription/packages/site-credits/statistics/usage-summary/admin/sms/vx-codes 的服务端行为（登录注册、短信、额度与积分计费、支付与订单状态机、兑换与套餐、后台配置与统计口径）在复刻 packages/server 中的对齐情况。

## 2. 对照表

| 行为点 | 原版证据（文件:行） | 复刻实现（文件:行） | 判定 | 说明 |
|---|---|---|---|---|
| 短信 devCode 回传 | O\sms\sms.service.js:67 仅返回 {message:'验证码已发送',expiresAt} | R\auth\auth.service.ts:43 返回 {success,devCode}；R\auth\sms.sender.ts:29-32 未配 AK 即返回码；desktop/src/renderer/src/pages/Login.tsx:17 自动填入 | DIVERGENT | 开发降级默认开启且无 NODE_ENV 判断，任意手机号可接管已有账号（P0） |
| 注册校验验证码 | O\auth\auth.service.js:74-93 开关开启时校验 purpose register/login，失败抛『验证码无效或已过期』 | R\auth\auth.service.ts:82 仅当 dto.code && dto.phone 才校验 | MISSING | 不传 code 即可注册任意手机/邮箱；smsLoginEnabled 开关失效 |
| 短信每日上限/TTL | O\sms\sms.service.js:38-48 每日 10 条『今日发送次数已达上限』；:50 TTL 10 分钟 | R\auth\auth.service.ts:15 TTL 5 分钟；29-44 无每日上限 | PARTIAL | 有效期 5 vs 10 分钟；缺每日上限，短信费可被刷 |
| 短信频控文案 | O\sms\sms.service.js:28-37『发送过于频繁，请60秒后重试』 | R\auth\auth.service.ts:34-36『验证码发送过于频繁，请稍后再试』 | DIVERGENT | 60s 窗口一致，文案不同（P2） |
| 短信登录开关 | O\auth\auth.service.js:132-135 关闭时『短信验证已关闭，请使用账号密码登录』 | R\auth\auth.service.ts:63-78 无开关判断 | MISSING | siteConfig.smsLoginEnabled 在登录链路无任何作用 |
| 后台短信配置是否生效 | O\sms\sms.service.js:108-117 按 DB smsConfig.isActive 选 tencent/aliyun；O\admin\admin.service.js:409-411 测试短信真实下发 | R\auth\sms.sender.ts:15-17,42-58 只读 env；R\admin\admin-extra.service.ts:161-167 testSms 只校验配置不下发 | DIVERGENT | 后台保存的短信配置完全不参与发送，且失败统一报『短信通道未配置』，运营无法排障（P1） |
| 登录响应形状 | O\auth\auth.service.js:331-351 {accessToken,refreshToken,expiresIn,tokenType:'Bearer'}（无 user） | R\auth\auth.service.ts:135-151 {accessToken,refreshToken,expiresAt,user} | PARTIAL | 字段集合不同；desktop 从不调 /auth/refresh（grep 0 命中），access token 7 天到期即掉线（P1） |
| 禁用账号错误码 | O\auth\auth.service.js:118-119 401『账号已被禁用』 | R\auth\auth.service.ts:76,118 403 Forbidden | DIVERGENT | HTTP 状态变化影响客户端分支（P2） |
| 重复注册文案 | O\auth\auth.service.js:67-73『该手机号已注册』 | R\auth\auth.service.ts:84『用户已存在』 | DIVERGENT | P2 |
| 验证码错误语义 | O\auth\auth.service.js:74-93 统一『验证码无效或已过期』；O\sms\sms.controller.js:32-45 提供 POST /sms/verify | R\auth\auth.service.ts:51-58 分三态『验证码错误』『验证码已过期』『验证码错误或已过期』；无 /sms/verify | PARTIAL | 文案泄露码状态；/sms/verify 缺失（P2） |
| 管理员登录 | O\admin\admin.service.js:74-116 硬编码 admin/admin，取/建 role=admin 用户、写 session、发 refreshToken | R\auth\auth.service.ts:122-133 env 默认 admin/admin，纯 JWT、无 session/refreshToken | PARTIAL | 后台无续期、无管理员用户行（改密/审计不可用，P2） |
| 免费额度基数 | O\subscription\quota.service.js:19-22 siteConfig.freeMonthlyQuota ?? 10；:44 resetAt=下月1日 | R\billing\quota.service.ts:8-11 同；:34 resetAt=new Date(year,month,1)=本月1日（过去时间） | PARTIAL | 订阅取限定为 INTENTIONAL；resetAt 计算错误，缺 resetMonthlyQuota（quota.service.js:84-134），当月改站点额度不生效（P2） |
| 额度→积分→封顶顺序 | O\compute-proxy\compute-proxy.service.js:187-222 quota>0 只扣额度，否则 consumeCredits→WithPartial | R\compute\compute.service.ts:243-262 同序；:155-158 差额不追扣 | ALIGNED | 顺序、封顶口径一致 |
| 402 文案 | O\subscription\quota.service.js:71『本月AI调用次数已用完，请升级会员或等待下月重置』；O\credits\credits.service.js:98-126『算力不足，请充值』 | R\billing\quota.service.ts:51-54；R\billing\credits.service.ts:68-84（:73） | ALIGNED | 两处逐字一致 |
| 无 usage 计费口径 | O\compute-proxy\compute-proxy.service.js:126-130 无 usage 仍按 calculatePrice(0,0) 计费（≥1） | R\compute\compute.service.ts:131-136 needsReview=true、actual=0、预扣全额退回 | DIVERGENT | 上游漏返 usage 时免费白嫖，收入与统计偏低（P1） |
| 流式扣费 | O\compute-proxy\compute-proxy.service.js:85-88 预扣、131-143 差额裸增删、:202 再 consumeCredits(actual) → 无额度用户约 2× 实扣（原版 bug） | R\compute\compute.service.ts:68-84 预扣走流水；:239-242 preCharged 只记账不二次扣 | DIVERGENT | 复刻修正原版重复扣费，属有意改进（P2，需测试与文档固化） |
| 退款流水与累计消耗 | O\compute-proxy\compute-proxy.service.js:138-142 裸 increment 无流水；O\credits\credits.service.js:68-97 不识别 refund | R\compute\compute.service.ts:165 addCredits('refund')；R\billing\credits.service.ts:58-59 refund 不回冲 totalCreditsConsumed | PARTIAL | 余额正确，但用户/后台『累计消耗』虚增（P1） |
| 订单 30 分钟窗口/金额单位 | O\orders\orders.service.js:54 expiredAt=now+30min；微信 V3 amount.total 用分 | R\orders\orders.service.ts:42；R\payments\wechat-pay.service.ts:206-234（分/CNY） | ALIGNED | 窗口与单位一致 |
| 待支付单复用 | O\orders\orders.service.js:34-51 复用同 pending 单 | R\orders\orders.service.ts:30-46 每次新建 | DIVERGENT | 反复点支付堆积 pending，后台待支付数/对账噪音（P2） |
| 订单过期状态值 | O\orders\orders.service.js:48-51,107-110 置 'closed' | R\orders\orders.service.ts:157-163 置 'expired' | DIVERGENT | 状态值变化；后台 app.js:39 已加 expired 标签（P2） |
| 微信支付配置来源 | O\admin\admin.service.js:412-433 读 DB wechatPayConfig 解密 apiKey/apiV3Key | R\payments\wechat-pay.service.ts:35-49,62-84 全部读 env | DIVERGENT | 后台微信支付配置保存后不生效，必须改 env 重启；运营会误以为已开通（P1） |
| 支付回调验签 | O\payment\payment.service.js:32-80 不验签，找不到订单时转 employeeOrder.completeOrderByOrderNo 兜底 | R\payments\payments.service.ts:63-77 验签后 markPaid，无员工订单兜底 | PARTIAL | 复刻安全更好，但缺平台证书时 verifyNotifySignature 返回 false（wechat-pay.service.ts:108-126）→ 回调全拒、已付款不到账（P1 上线风险） |
| 回调金额校验 | 原版 completePayment 不校验金额，按订单 credits 入账 | R\orders\orders.service.ts:94-100 金额不符置 amount_mismatch 并冻结 | DIVERGENT | 复刻更严，需要后台告警/人工处理路径（P2） |
| 员工按天订单支付 | O\employee\employee-order.service.js:49-66,89-91 下单即拉起微信 Native 返回 qrCodeUrl | R\employee\employee-order.service.ts:61-67 仅返回 payHint『支付渠道尚未开通…』；无 qrCodeUrl | MISSING | 前台无法付款；后台 API 有 GET /admin/employee-orders、POST :id/mark-paid（R\employee\package.controller.ts:113-130），但 public/admin/app.js 无入口（NAV 无该页）→ 员工实际开不通（P1） |
| 员工订单续期累加 | O\employee\employee-order.service.js:166 durationDays=(existing||0)+order.durationDays | R\employee\employee-order.service.ts markPaid 覆盖为 order.durationDays（到期时间顺延） | PARTIAL | 权益到期正确，已购天数展示/统计不累加（P2） |
| admin 手工调积分 | O\admin\admin.service.js:255-267 直接 addCredits，可扣成负、type 默认 'adjust' | R\admin\admin.service.ts:160-170 amount<0 走 consumeCredits → 402『算力不足，请充值』，不可扣负 | DIVERGENT | 运营无法纠正超发/退款，且提示是用户话术（P1） |
| admin 统计口径 | O\statistics\statistics.service.js:19-33 {totalUsers,totalCreditsBalance,totalCreditsConsumed,totalRevenue,totalRevenueYuan}；:34-68 {labels,consumed,recharged}；:91-117 {topConsumers,topRechargers}；参数 period | R\admin\admin-extra.controller.ts:301-304 返回 admin.overview()（R\admin\admin.service.ts:26-37 users/revenueTotal…）；credits 返回 byType 汇总（admin-extra.service.ts:736-747）；users 按天数组（:725-734）；参数 days | DIVERGENT | 字段/形状全不同；复刻后台自洽（app.js:105 用 /admin/overview），统计口径用 aiUsageRecord.creditsCharged（含 needsReview/partial），与原版 creditTransaction 口径不一致（P2，金额口径见 P1） |
| admin 用量端点形状 | O\usage-summary\usage-summary.service.js:43-47/49-64/65-85/86-101/102-144（{items}、percentage、昵称兜底） | R\admin\admin-extra.controller.ts:242-267（summary 返回全对象、by-model/by-user 裸数组、daily 仅 days、details 无昵称映射） | DIVERGENT | 与原版契约不兼容；复刻后台 app.js:106-116 只消费 modelBreakdown → 自洽（P2） |
| 用户积分统计契约 | O\credits\credits.service.js:201-269 avgCreditsPerRequest/modelBreakdown(requestCount)/dailyBreakdown | R\billing\credits.service.ts:133-184 无 avgCredits，byModel 用 requests、daily 用 requests | DIVERGENT | 端上暂未调用（desktop grep 0），但 scripts\smoke-t14.mjs:125 仍断言 modelBreakdown → 冒烟会红（P2） |
| 兑换码三档 | 原版无三档（生产 SubscriptionPlan 0 行；O 侧仅有渠道卡密采购 redemption-purchase） | R\employee\package.service.ts:12-34 presets、:119-162 redeem（5 段中文文案、updateMany 并发防护） | INTENTIONAL | 定向改造（兑换码三档+积分钱包）；文案与并发处理完整 |
| 积分充值在线链路 | O\orders\orders.service.js 全链路 + 前端我的套餐/订单 | R 服务端有 /payments/orders（R\payments\），但 desktop grep payments/orders、expiresIn 均 0 命中 | INTENTIONAL | 定向为兑换码充值；服务端充值接口成孤岛，需文档标注或下线（P2） |
| 缺失的渠道外挂路由 | O routes:147-151 redemption-purchase(5)、159-162 site-credits(4)、228-233 vx-codes(6)、182-186 bitable(5) | 复刻无对应控制器 | INTENTIONAL | 共 20 条，属代销/官网/飞书渠道，已定向不做；需在 F2 文档写明不再提供 |
| 缺失的订阅与公众号路由 | O routes:1-58 subscription-plans(4)/subscriptions/subscription-orders；:14-17 wechat-oa-config(4)；:67-68 /auth/wechat/session、/auth/wechat/status | 订阅无（INTENTIONAL）；公众号登录、wechat-oa-config 无（MISSING） | PARTIAL | 订阅 6 条 + 公众号 4 条 + auth 2 条；用户少一种登录方式，老公众号用户无法迁移（P2） |
| 缺失的多 key/按手机号调分路由 | O routes:20-23 volc-keys(4)、237-238 workflow/users/:phone/credits[/deduct] | 复刻 ai-api-config 单 token（R\admin\admin-extra.service.ts:88-109）；admin 按 userId 调分 | PARTIAL | 多 key 轮换/限流切换缺失；按手机号调分可由用户搜索+调分等价（P2） |

## 3. 高价值差异

| # | 差异 | 影响 | 建议修法 | 优先级 | 预估 |
|---|---|---|---|---|---|
| 1 | 短信 devCode 在生产回传并自动填码/自动登录 | 未配 AK 的部署可被任意手机号接管账号 | devMode 加 NODE_ENV!=='production' 且 DEV_RETURN_SMS_CODE 默认 false；客户端永不自动登录 devCode | P0 | 0.5d |
| 2 | 注册不强制验证码 | 任意手机号/邮箱可注册，短信开关失效 | dto.phone 必带 code 并校验 purpose=register；开关读 siteConfig.smsLoginEnabled | P1 | 0.5d |
| 3 | 后台短信/微信支付配置不生效 | 运营配完仍发不出短信/收不了款，排障成本高 | SmsSender 与 WechatPayService 优先读 DB config（解密），env 仅兜底；sms-test 真实下发 | P1 | 2d |
| 4 | 无 usage 归零计费 | 上游漏 usage 即免费，收入与统计偏低 | 保留最低价计费（原版口径）+ needsReview 标记，或加 env 开关默认最低价 | P1 | 0.5d |
| 5 | 员工订单无前台支付、后台无确认入口 | 员工按天订单收不了钱、开不通 | 复用 payments 的 Native 下单返回 qrCodeUrl，回调/后台 mark-paid 双通道；后台加员工订单页 | P1 | 2d |
| 6 | admin 调积分不能扣负且报用户话术 | 无法纠正超发/退款，运营被 402 误导 | 新增独立 adjust 通道（允许负余额、type=adjust、写流水备注） | P1 | 0.5d |
| 7 | 短信无每日上限、TTL 5 分钟 | 短信费被刷；验证码页提示与实际不符 | 补每日 10 条上限（O\sms\sms.service.js:38-48）、TTL 改 10 分钟 | P1 | 0.2d |
| 8 | access token 7 天到期无续期 | 用户周期性被登出 | desktop 401 时调 /auth/refresh 并轮换 refreshToken（R\auth\auth.service.ts:102-109 已实现） | P1 | 0.5d |
| 9 | 微信回调缺平台证书即全拒 | 已付款订单不到账 | 配置校验前置：未配平台证书时启动告警；后台可上传证书；回调失败落库待人工 | P1 | 0.5d |
| 10 | 退款不回冲累计消耗 | 用户中心/后台消耗统计虚增 | addCredits(type=refund) 时减 totalCreditsConsumed | P1 | 0.2d |
| 11 | 订单不复用 pending、状态 expired、statistics/usage 契约差异 | 对账噪音、外部脚本不兼容 | 复用 pending；状态映射补 closed；统计接口加兼容层或改文档 | P2 | 1d |
| 12 | admin 登录无 session、文案 403/『用户已存在』/resetAt 等细节 | 体验与可维护性 | 逐条对齐文案；修 resetAt 为下月 1 日 | P2 | 0.5d |

缺失 admin 路由的运营价值（对应任务书「29 条」问题）：按原版 admin 段 88 条逐条比对，复刻覆盖约 52 条、缺 36 条。其中 26 条为已定向不做（订阅 6、redemption-purchase 5、site-credits 4、vx-codes 6、bitable 5）；运营真正可能需要的 10 条是 volc-keys 4（多 key 轮换）、wechat-oa-config 4（仅当保留公众号登录）、workflow 按手机号调分 2（已有等价后台能力）。其余缺失不构成运营阻塞。

## 4. 已确认一致的点

1. 额度优先→积分→余额封顶不追扣的顺序与文案（O\compute-proxy\compute-proxy.service.js:187-222 vs R\compute\compute.service.ts:243-262）。
2. 两处 402 中文文案逐字一致（O\subscription\quota.service.js:71、O\credits\credits.service.js:98-126 vs R\billing\quota.service.ts:51-54、R\billing\credits.service.ts:68-84）。
3. 免费额度基数 siteConfig.freeMonthlyQuota ?? 10（O\subscription\quota.service.js:19-22 vs R\billing\quota.service.ts:8-11）。
4. 定价算法：按千 token 向上取整、按次计价、最低 1 积分（O\volcengine\volc-pricing.service.js:19-38 vs R\billing\pricing.service.ts:22-36）。
5. 订单 30 分钟支付窗口、金额以分存储、回调按 out_trade_no 幂等入账（O\orders\orders.service.js:54 vs R\orders\orders.service.ts:42；R\orders\orders.service.ts:90-126）。

## 5. 存疑/无法验证

1. 生产 siteConfig.freeMonthlyQuota 实际值无法读取（原版生产库不可访问）；报告按代码默认 10 判定。
2. 原版 SubscriptionPlan 生产 0 行，无法验证付费订阅是否曾上线；订阅相关路由按「已定向不做」处理。
3. 复刻微信支付 env 与真实商户号/平台证书是否匹配无法验证（无生产配置）；该项风险按部署配置项处理。
4. 原版用户侧 /orders 与公众号登录的真实使用率无日志可查，缺失影响按 P2 估计。
5. 原版 admin 路由总数按 routes 文件 88 条统计，与任务书「29 条缺失」口径不同（差异来自复刻新增 overview/orders/usage 等路由是否计入），本文按族给出结论。
