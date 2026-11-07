# F2 契约基线矩阵（原版 0.4.29 vs 复刻）

> 机器生成：`scripts/audit/05-report.mjs`。数据源 `scripts/audit/out/{original,replica}-{routes,ipc,schema}.json` + `diff.json` + `copy-diff.json`。
> 口径：F2 = 契约层，**必须 100% 对齐**；F1 = 用户可见文案，需逐条比对。

## 0. 总览

| 维度 | 原版基线 | 当前复刻 | 精确命中 / 缺失 | 新增或额外 | 命中率 |
|---|---:|---:|---:|---:|---:|
| HTTP 路由 | 237 | 220 | 143 命中 / 94 缺失 | 77 | 60.3% |
| IPC handle | 147 | 63 | 12 命中 / 135 缺失 | 51 | 8.2% |
| Prisma 表 | 47 | 40 | 34 命中 / 13 缺失 | 6 | 72.3% |
| Prisma 字段名 | 588 | 524 | 159 缺失（含缺失表） | 95 | 73.0% |
字段类型/可空性差异：0 项。逐表差异详见 `scripts/audit/out/diff.json`；F2 覆盖率仅按字段名计，类型差异单列，不混入覆盖率。

以上是静态契约比对，不代表流程行为已验证。原版 IPC handle 基线取自既有 mock-electron 动态导入契约；本机对混淆包的字符串扫描找到 87 / 147 个通道字符串，字符串出现不等于运行行为已确认。

## 1. HTTP 路由（按模块）

| 模块 | 原版 | 复刻 | 精确命中 | 缺失 | 新增 | 状态 |
|---|---:|---:|---:|---:|---:|---|
| admin | 88 | 76 | 59 | 29 | 17 | PARTIAL |
| agent-plan | 2 | 0 | 0 | 2 | 0 | MISSING |
| audio-materials | 3 | 3 | 3 | 0 | 0 | OK |
| auth | 9 | 11 | 7 | 2 | 4 | PARTIAL |
| bitable | 5 | 0 | 0 | 5 | 0 | MISSING |
| capabilities | 0 | 3 | 0 | 0 | 3 | EXTRA |
| channels | 0 | 14 | 0 | 0 | 14 | EXTRA |
| clone-records | 4 | 4 | 4 | 0 | 0 | OK |
| compose-videos | 6 | 6 | 6 | 0 | 0 | OK |
| compute | 2 | 2 | 2 | 0 | 0 | OK |
| credits | 4 | 4 | 4 | 0 | 0 | OK |
| employee-crons | 0 | 4 | 0 | 0 | 4 | EXTRA |
| employee-execution | 0 | 6 | 0 | 0 | 6 | EXTRA |
| employee-orders | 3 | 6 | 3 | 0 | 3 | PARTIAL |
| employee-tasks | 0 | 6 | 0 | 0 | 6 | EXTRA |
| employees | 5 | 9 | 4 | 1 | 5 | PARTIAL |
| feishu | 6 | 0 | 0 | 6 | 0 | MISSING |
| feishu-config | 4 | 0 | 0 | 4 | 0 | MISSING |
| feishu-documents | 2 | 0 | 0 | 2 | 0 | MISSING |
| fusion-folders | 4 | 0 | 0 | 4 | 0 | MISSING |
| fusion-materials | 4 | 0 | 0 | 4 | 0 | MISSING |
| health | 0 | 1 | 0 | 0 | 1 | EXTRA |
| media | 11 | 15 | 11 | 0 | 4 | PARTIAL |
| orders | 5 | 0 | 0 | 5 | 0 | MISSING |
| packages | 4 | 4 | 1 | 3 | 3 | PARTIAL |
| payments | 1 | 7 | 1 | 0 | 6 | PARTIAL |
| recorder | 7 | 0 | 0 | 7 | 0 | MISSING |
| redemption | 1 | 1 | 1 | 0 | 0 | OK |
| scene-videos | 6 | 0 | 0 | 6 | 0 | MISSING |
| site | 1 | 1 | 1 | 0 | 0 | OK |
| sms | 2 | 0 | 0 | 2 | 0 | MISSING |
| subscription | 7 | 0 | 0 | 7 | 0 | MISSING |
| toolapi | 32 | 32 | 32 | 0 | 0 | OK |
| volcengine | 2 | 2 | 2 | 0 | 0 | OK |
| volcengine-proxy | 2 | 2 | 2 | 0 | 0 | OK |
| wechat-oa | 3 | 0 | 0 | 3 | 0 | MISSING |
| workbench | 0 | 1 | 0 | 0 | 1 | EXTRA |
| workflow | 2 | 0 | 0 | 2 | 0 | MISSING |

缺失模块合计：agent-plan、bitable、feishu、feishu-config、feishu-documents、fusion-folders、fusion-materials、orders、recorder、scene-videos、sms、subscription、wechat-oa、workflow

## 2. IPC 通道（按命名空间）

| 命名空间 | 原版 | 复刻 | 缺口 |
|---|---|---|---|
| tads | 20 | 0 | 20 |
| provider | 17 | 0 | 17 |
| channel | 10 | 0 | 10 |
| gateway | 9 | 4 | 5 |
| openclaw | 8 | 0 | 8 |
| file | 8 | 0 | 8 |
| update | 8 | 4 | 4 |
| app | 7 | 0 | 7 |
| cron | 6 | 0 | 6 |
| wxauto | 6 | 0 | 6 |
| clawhub | 5 | 0 | 5 |
| settings | 5 | 1 | 4 |
| log | 5 | 0 | 5 |
| skill | 5 | 0 | 5 |
| window | 4 | 3 | 1 |
| asar-update | 4 | 0 | 4 |
| shell | 3 | 0 | 3 |
| dialog | 3 | 0 | 3 |
| env | 3 | 0 | 3 |
| uv | 2 | 0 | 2 |
| media | 2 | 0 | 2 |
| hostapi | 1 | 0 | 1 |
| bi | 1 | 0 | 1 |
| chat | 1 | 0 | 1 |
| domain | 1 | 0 | 1 |
| session | 1 | 0 | 1 |
| brand | 1 | 0 | 1 |
| usage | 1 | 0 | 1 |

复刻多出的通道（原版无，需评估是否保留）：`gateway:logs`、`gateway:control-url`、`app:info`、`settings:set-api-base`、`auth:sms-send`、`auth:sms-login`、`auth:password-login`、`auth:logout`、`auth:me`、`site:config`、`compute:models`、`credits:balance`、`credits:usage-records`、`employees:catalog`、`employees:mine`、`employees:install`、`employees:uninstall`、`employees:run`、`employee-tasks:list`、`employee-tasks:approve`、`employee-tasks:reject`、`employee-execution:heartbeat`、`employee-execution:status`、`employee-execution:tick`、`employee-execution:start`、`employee-execution:stop`、`employee-execution:nodes`、`media:upload`、`media:image`、`media:video`、`media:task`、`media:cancel`、`media:compose-create`、`media:compose-list`、`media:compose-remove`、`media:compose-transfer`、`media:clone-create`、`media:clone-list`、`media:clone-remove`、`media:audio-list`、`media:audio-upload`、`media:audio-remove`、`channel:personal-wechat-status`、`channel:personal-wechat-contacts`、`channel:personal-wechat-messages`、`channel:personal-wechat-send`、`channel:personal-wechat-send-file`、`channel:personal-wechat-listen`、`chat:send`、`settings:mark-onboarded`、`settings:get-onboarded`

## 3. 数据表

| 表 | 状态 | 原版字段 | 复刻字段 | 缺失字段 |
|---|---|---|---|---|
| User | PARTIAL | 34 | 29 | feishuConfig, feishuOAuthStates, wechatLoginSessions, subscriptions, subscriptionOrders, recorderBinding, recorderContents |
| Session | OK | 8 | 8 | - |
| ProxyToken | OK | 7 | 7 | - |
| VerificationCode | OK | 9 | 9 | - |
| SmsConfig | OK | 11 | 11 | - |
| ModelPricing | OK | 10 | 12 | - |
| MediaPricing | OK | 10 | 10 | - |
| MediaTaskRecord | OK | 11 | 14 | - |
| AiUsageRecord | OK | 20 | 22 | - |
| SiteConfig | OK | 19 | 19 | - |
| CreditPackage | OK | 11 | 11 | - |
| CreditTransaction | OK | 13 | 13 | - |
| Order | OK | 16 | 21 | - |
| WechatPayConfig | OK | 12 | 12 | - |
| FeishuDocument | MISSING_TABLE | 8 | 0 | id, documentUrl, phone, category, title, userId, createdAt, updatedAt |
| SceneVideo | MISSING_TABLE | 8 | 0 | id, videoUrl, videoName, phone, title, createdAt, updatedAt, sceneTaskId |
| AudioMaterial | OK | 5 | 5 | - |
| FusionFolder | OK | 9 | 9 | - |
| FusionMaterial | OK | 13 | 13 | - |
| CloneRecord | OK | 10 | 10 | - |
| ComposeVideo | OK | 19 | 19 | - |
| OssConfig | OK | 9 | 9 | - |
| FeishuConfig | MISSING_TABLE | 19 | 0 | id, userId, phone, appId, appSecret, dmPolicy, allowFrom, enabled, bitableConfig, extraConfig, authMode, oauthAccessToken, oauthRefreshToken, oauthExpiresAt, oauthScope, oauthOpenId, createdAt, updatedAt, user |
| FeishuOAuthState | MISSING_TABLE | 9 | 0 | id, state, status, errorMessage, expiresAt, createdAt, updatedAt, userId, user |
| AiEmployee | OK | 30 | 40 | - |
| AiEmployeePurchase | OK | 12 | 12 | - |
| EmployeeOrder | OK | 18 | 18 | - |
| ContentCollection | OK | 11 | 11 | - |
| DailyDistribution | OK | 6 | 6 | - |
| PotentialCustomer | OK | 11 | 11 | - |
| TodayCommunication | OK | 10 | 10 | - |
| CustomerProfile | OK | 18 | 18 | - |
| StrategySummary | OK | 6 | 6 | - |
| CustomerCollection | OK | 12 | 12 | - |
| UserChatPrompt | OK | 7 | 7 | - |
| WechatOaConfig | MISSING_TABLE | 14 | 0 | id, appId, appSecret, token, encodingAesKey, callbackBaseUrl, loginMode, oaName, oaId, oaQrCodeUrl, description, isActive, createdAt, updatedAt |
| WechatLoginSession | MISSING_TABLE | 12 | 0 | id, sceneId, loginMode, status, openId, userId, accessToken, verifyCode, expiresAt, createdAt, updatedAt, user |
| PendingSubscribe | MISSING_TABLE | 7 | 0 | id, openId, eventType, eventKey, content, matched, createdAt |
| SubscriptionPlan | MISSING_TABLE | 15 | 0 | id, name, slug, durationDays, price, priceDisplay, monthlyQuota, description, features, sort, isActive, createdAt, updatedAt, subscriptions, orders |
| UserSubscription | MISSING_TABLE | 13 | 0 | id, userId, planId, status, currentPeriodStart, currentPeriodEnd, autoRenew, cancelledAt, createdAt, updatedAt, plan, user, orders |
| SubscriptionOrder | MISSING_TABLE | 19 | 0 | id, userId, planId, subscriptionId, orderNo, amount, durationDays, monthlyQuota, payMethod, status, wechatTransactionId, paidAt, expiredAt, isAutoRenew, createdAt, updatedAt, plan, subscription, user |
| UserMonthlyUsage | OK | 11 | 11 | - |
| SystemInfo | OK | 16 | 16 | - |
| BitableRecord | MISSING_TABLE | 7 | 0 | id, phone, tableName, feishuRecordId, data, createdAt, updatedAt |
| RedemptionCode | OK | 12 | 12 | - |
| RecorderBinding | MISSING_TABLE | 9 | 0 | id, userId, deviceCode, apiKey, employeeSlug, boundAt, lastSeenAt, user, contents |
| RecorderContent | MISSING_TABLE | 12 | 0 | id, userId, bindingId, title, content, employeeSlug, recordedAt, uploadedAt, ingestedAt, status, binding, user |
| AiEmployeeInstall | EXTRA_TABLE | 0 | 9 | - |
| EmployeeCron | EXTRA_TABLE | 0 | 12 | - |
| EmployeeTask | EXTRA_TABLE | 0 | 20 | - |
| EmployeeTaskArtifact | EXTRA_TABLE | 0 | 8 | - |
| EmployeeExecutionNode | EXTRA_TABLE | 0 | 10 | - |
| UserPackageGrant | EXTRA_TABLE | 0 | 12 | - |

## 4. 文案（F1）

抽取的用户可见中文文案：原版 `281` 条，其中在复刻中命中的 `47` 条。

| 模块 | 文案数 | 命中 | 覆盖率 |
|---|---|---|---|
| admin | 64 | 8 | 12.5% |
| toolapi | 27 | 8 | 29.6% |
| payment | 21 | 1 | 4.8% |
| statistics | 19 | 1 | 5.3% |
| employee | 17 | 9 | 52.9% |
| feishu-oauth | 14 | 0 | 0.0% |
| media-proxy | 14 | 1 | 7.1% |
| fusion-materials | 13 | 0 | 0.0% |
| sms | 13 | 0 | 0.0% |
| subscription | 13 | 2 | 15.4% |
| volcengine | 12 | 6 | 50.0% |
| wechat-oa | 12 | 0 | 0.0% |
| scene-videos | 11 | 0 | 0.0% |
| redemption | 9 | 6 | 66.7% |
| common | 8 | 0 | 0.0% |
| compute-proxy | 8 | 8 | 100.0% |
| agent-plan | 7 | 5 | 71.4% |
| auth | 7 | 2 | 28.6% |
| audio-materials | 6 | 0 | 0.0% |
| compose-videos | 5 | 0 | 0.0% |
| orders | 5 | 2 | 40.0% |
| authorization | 4 | 0 | 0.0% |
| recorder | 4 | 0 | 0.0% |
| site | 4 | 3 | 75.0% |
| feishu-config | 3 | 0 | 0.0% |
| clone-records | 2 | 1 | 50.0% |
| redemption-purchase | 2 | 0 | 0.0% |
| vx-codes | 2 | 0 | 0.0% |
| workflow | 2 | 1 | 50.0% |
| credits | 1 | 1 | 100.0% |
| site-credits | 1 | 0 | 0.0% |
| system-info | 1 | 0 | 0.0% |
| usage-summary | 1 | 0 | 0.0% |

## 5. 基线自检（baseline-check.json）

```json
{
 "routes": {
  "extracted": 237,
  "contractRaw": 238,
  "contractNormalizedUnique": 237,
  "onlyExtracted": [],
  "onlyContract": []
 },
 "ipc": {
  "runtimeContract": 147,
  "contract": 147,
  "evidence": "Mock-electron dynamic import capture; bundle string scan is separate evidence only",
  "bundleStringScanFound": 87,
  "preloadStringScanFound": 60
 },
 "tables": {
  "orig": 47,
  "contractSchemaModels": 47
 }
}
```

## 6. 缺口与已确认处置

| 缺口 | 状态依据 | 处置 |
|---|---|---|
| Feishu / Bitable | 项目契约已记录改用本地表 | CUT；不计为复刻缺陷 |
| 公众号登录、录音器、会员订阅、代理分销 | 总纲记录为已认可裁剪 | CUT；按项目范围维护 |
| 腾讯广告 tads、语音、灰色自动化技能分发、云端员工执行 | 决策待用户 | 保持待决策，不自动标 CUT |
| 其余精确未匹配路由 | 94 项 | 按模块拆分实现；只有用户确认的裁剪才标 CUT |
| 其余未匹配 IPC handle | 135 项 | 按功能拆分；只有用户确认的裁剪才标 CUT |
| 缺失 Prisma 表 | 13 张 | 依据对应模块范围逐项处置，不为追数字盲目建表 |

## 7. 模块处置台账（T-14 收口）

| 模块 | 原版路由 | 复刻路由 | 处置 |
|---|---:|---:|---|
| admin | 88 | 76 | IMPLEMENTED 主体（配置/定价/兑换码/用户/员工/用量/统计/上传/别名，58 项冒烟断言）；剩余 29 条见下方子域台账 |
| agent-plan | 2 | 0 | BLOCKED（代理分成计费规则未定，待用户拍板） |
| audio-materials | 3 | 3 | CUT（同上） |
| auth | 9 | 11 | IMPLEMENTED |
| bitable | 5 | 0 | CUT（同上） |
| capabilities | 0 | 3 | UNREVIEWED（默认：未处置，需下一轮收口） |
| channels | 0 | 14 | EXTRA（复刻新增：渠道接入，原版在 Electron 主进程侧） |
| clone-records | 4 | 4 | CUT（同上） |
| compose-videos | 6 | 6 | CUT（同上，由 media 云端 API 覆盖） |
| compute | 2 | 2 | IMPLEMENTED |
| credits | 4 | 4 | IMPLEMENTED |
| employee-crons | 0 | 4 | EXTRA（M6.5） |
| employee-execution | 0 | 6 | EXTRA（T-19 云端执行器，运行侧待隔离机） |
| employee-orders | 3 | 6 | IMPLEMENTED |
| employee-tasks | 0 | 6 | EXTRA（M6.5） |
| employees | 5 | 9 | IMPLEMENTED |
| feishu | 6 | 0 | CUT（用户 m00579 明确：飞书多维表格不要，换本地表） |
| feishu-config | 4 | 0 | CUT（同上） |
| feishu-documents | 2 | 0 | CUT（同上） |
| fusion-folders | 4 | 0 | CUT（同上） |
| fusion-materials | 4 | 0 | CUT（同上） |
| health | 0 | 1 | EXTRA |
| media | 11 | 15 | IMPLEMENTED |
| orders | 5 | 0 | IMPLEMENTED |
| packages | 4 | 4 | IMPLEMENTED |
| payments | 1 | 7 | IMPLEMENTED |
| recorder | 7 | 0 | CUT（录音器硬件绑定不在本期范围） |
| redemption | 1 | 1 | IMPLEMENTED |
| scene-videos | 6 | 0 | CUT（原版依赖自建 GPU 媒体服务；用户 m01410 改为调用第三方云端平台，见 media） |
| site | 1 | 1 | IMPLEMENTED |
| sms | 2 | 0 | IMPLEMENTED（发送走 auth/sms + 管理端配置校验） |
| subscription | 7 | 0 | CUT（生产库 SubscriptionPlan/UserSubscription/SubscriptionOrder 均 0 行，且已用兑换码套餐替代） |
| toolapi | 32 | 32 | IMPLEMENTED |
| volcengine | 2 | 2 | IMPLEMENTED |
| volcengine-proxy | 2 | 2 | IMPLEMENTED |
| wechat-oa | 3 | 0 | CUT（公众号登录/运营不在本期范围，总纲 v3 已记录） |
| workbench | 0 | 1 | EXTRA（M6.5 办公区） |
| workflow | 2 | 0 | CUT（原版工作流编排为云端 agent 功能，复刻由 M6.5 员工任务+定时器覆盖） |

处置口径：**只有用户明确确认过的裁剪才标 CUT**；未做但未确认的标 UNREVIEWED，不粉饰为完成。

### 7.1 admin 模块剩余 29 条子域台账

| 子域 | 缺失条数 | 处置 | 依据 |
|---|---:|---|---|
| subscription-plans / subscriptions / subscription-orders | 6 | CUT | 生产库三张订阅表均 0 行，已由兑换码套餐（UserPackageGrant）+ 员工订单替代 |
| volc-keys（模型 Key 池） | 4 | CUT | 复刻走官方直连 + 服务端 env 单 Key，无多租户 Key 池需求 |
| vx-codes（微信激活码） | 6 | CUT | 原版用于 vx 机器人授权分发，复刻自研个人微信不依赖激活码 |
| redemption-purchase（云端兑换码采购） | 5 | CUT | 依赖原版云端 agentServerUrl 计费，复刻不自建云端 |
| site-credits（站点积分采购） | 4 | CUT | 同上，属云端分销体系 |
| wechat-oa-config（公众号配置/二维码/回调） | 4 | BLOCKED | 公众号运营渠道本期未接，待渠道范围确认 |
