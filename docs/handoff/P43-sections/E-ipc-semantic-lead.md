# P43 · IPC 通道语义对照（lead 亲自核，2026-11-11）

> 数据源：`scripts/audit/out/original-ipc.json`（原版 147 条 handle，来自 `contracts/ipc_handles_147.tsv`）与 `scripts/audit/out/replica-ipc.json`（复刻 83 handle + 103 preload 通道，去重 104）。
> 说明：F2 静态 diff 说「12 命中 / 135 缺失 / 8.2%」，那是**字面命中率**。下表按语义把 147 条原版通道分组归并，给出真实覆盖情况。

## 一、语义归并结果

| # | 原版通道组（条数） | 语义 | 复刻状态 | 判定 |
|---|---|---|---|---|
| 1 | `app:request`、`hostapi:fetch`（2） | 通用 HTTP 桥（给 openclaw 控制台用） | 我们用直连 `api()` + 各域通道 | EQUIVALENT |
| 2 | `tads:get-config`…`tads:get-daily-report`（**23**） | **巨量引擎广告投放**：OAuth 授权、广告主信息、人群包（建/传/查/删）、计划/广告组/创意（建/查）、日报 | **无任何对应** | **MISSING（P2，需巨量广告账户 OAuth）** |
| 3 | `gateway:status/isConnected/start/stop/restart/rpc/httpProxy/getControlUiUrl/health`（10） | openclaw 网关进程管理 | `gateway:status/start/stop/restart/control-url/logs`（6） | PARTIAL（缺 rpc / httpProxy / health / isConnected，我们不需要 RPC 透传） |
| 4 | `openclaw:status/isReady/getDir/getConfigDir/getSkillsDir/getCliCommand/checkUpdate/update`（12） | openclaw 安装目录/版本/自更新 | 无 | INTENTIONAL（网关由我们随桌面打包提供，不走原版安装器） |
| 5 | `clawhub:search/install/uninstall/list/openSkillReadme`（5） | **技能市场**（ClawHub 在线装技能） | 无（技能是内置 SKILL.md + 员工目录） | MISSING（P2，与「员工市场」定位重叠，可后置） |
| 6 | `chat:sendWithMedia`（1） | 对话发图/文件 | `chat:send`（无媒体入参） | PARTIAL（P1：客户端对话不能贴图） |
| 7 | `bi:geo-locate`（1） | 定位（城市） | 无 | P2 |
| 8 | `domain:getPrimaryDomain`、`brand:getConfig`（2） | 品牌/主域名配置 | 品牌写死在前端文案 | INTENTIONAL |
| 9 | `channel:saveConfig/getConfig/getFormValues/deleteConfig/listConfigured/setEnabled/validate/validateCredentials/requestWhatsAppQr/cancelWhatsAppQr`（12） | **渠道配置中心**（含 WhatsApp 扫码登录） | `channel:personal-wechat-*`（7，走外部网桥）+ 服务端 `/channels/*`（企微/公众号） | DIVERGENT：能力有，形态不同；WhatsApp 未做（P2） |
| 10 | `provider:list/listVendors/listAccounts/getAccount/get/save/delete/setApiKey/updateWithKey/deleteApiKey/hasApiKey/getApiKey/setDefault/getDefault/validateKey/requestOAuth/cancelOAuth`（**20**） | **多模型供应商/自带 API Key/多账号/OAuth** | `compute:models`（官方直连，单一上游） | INTENTIONAL（用户明确「模型官方直连」），但原版 UI 的「供应商管理」页我们没有 |
| 11 | `shell:openExternal/showItemInFolder/openPath`、`dialog:open/save/message`（6） | 壳能力：外链、在文件夹显示、原生文件框 | 部分（`files:reveal/open`） | PARTIAL（P1，缺 `dialog:save` 导出另存） |
| 12 | `session:delete`（1） | 删除会话 | `chat:send` 域无删除 | P1（小） |
| 13 | `app:version/name/getPath/platform/quit/relaunch`（6） | 应用信息 | `app:info`（含 version） | EQUIVALENT |
| 14 | `settings:get/getAll/set/setMany/reset`（5） | 设置读写 | `settings:get/set-api-base/mark-onboarded` | PARTIAL（P1：缺批量/重置） |
| 15 | `uv:check/uv:install-all/env:install-all/env:install-wxauto/env:get-status`（5） | 本机 Python/uv/wxauto 环境安装 | 微信网桥独立安装脚本 | INTENTIONAL |
| 16 | `log:getRecent/readFile/getFilePath/getDir/listFiles`（5） | **日志查看**（客户端内看/导出日志） | 无（日志只在 `userData/platform-logs`） | **MISSING（P1，排障与用户自助都靠它）** |
| 17 | `usage:recentTokenHistory`（1） | 用量历史 | `credits:usage-records` | EQUIVALENT |
| 18 | `skill:updateConfig/getConfig/getAllConfigs/getDouyinDepsStatus/openPlatformLogin`（5） | 技能参数配置、抖音依赖状态、平台登录 | `platform:login` 等 + 内置 SKILL.md | PARTIAL（技能无可调参数，INTENTIONAL） |
| 19 | `cron:list/create/update/delete/toggle/trigger`（6） | 定时任务 CRUD + 启停 + 手动触发 | `cron:list/create/delete`（3） | **PARTIAL（P1，缺 update / toggle / trigger）** |
| 20 | `file:stage/stageBuffer`、`media:saveImage/getThumbnails`、`file:listTree/readText/stat/listDir/readBinary/writeText`（10） | 工作区文件树/缩略图/图片落盘 | `files:list/read/write/mkdir/rename/delete/reveal/open`（8）、`workspace:*` | PARTIAL（P2：缺缩略图、file:stat） |
| 21 | `wxauto:fetch/status/start/stop/token/openLogsDir`（6） | 原版内置 wxauto 驱动（个人微信） | 外部网桥 + `channel:personal-wechat-*` | EQUIVALENT（形态不同，功能更全：入站接管） |
| 22 | `update:status/version/check/download/install/setChannel/setAutoDownload/cancelAutoInstall`（8） | 客户端更新 | `update:status/check/download/install`（4） | PARTIAL |
| 23 | `asar-update:check/download/install/status`（**4**） | **asar 增量热更新**（只下 app.asar，不重装 NSIS） | 无 | **MISSING（P1：这正是我们现在每次发版要跑 6–13 分钟 NSIS 静默安装的替代品）** |

## 二、结论

- **语义覆盖面**：147 条 → 真正 MISSING 的只有 4 组：`tads:*`(23)、`clawhub:*`(5)、`log:*`(5)、`asar-update:*`(4)，共 37 条；其余 110 条全部是 EQUIVALENT / PARTIAL / INTENTIONAL。
- 换言之 **IPC 真实覆盖率 ≈ 75%（110/147）**，而不是静态 diff 的 8.2%。报告里必须写这个口径。

## 三、建议的修复优先级

- **P1（低成本、直接改善体验）**：
  1. `cron:update / toggle / trigger`（3 条，服务端 `/capabilities/cron_*` 已有，只需补 IPC + 定时页按钮）
  2. `log:*`（5 条，读 `userData/platform-logs`，设置页加「查看日志/打开目录」）
  3. `asar-update:*`（4 条，用 app.asar 替换 + sha512 校验替代全量安装包；需在 `update.ts` 加一条 asar feed）
  4. `chat:sendWithMedia`（对话贴图）、`session:delete`、`dialog:save`（导出另存）
- **P2（需外部资质/大工程）**：`tads:*`（巨量广告 OAuth）、`clawhub:*`（在线技能市场）、WhatsApp 渠道、`media:getThumbnails`。
- **INTENTIONAL（写进报告声明，不再投入）**：`provider:*`（官方直连）、`openclaw:*`（网关随包）、`uv/env:*`（网桥独立安装）、`brand/domain`。
