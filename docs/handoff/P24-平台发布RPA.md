# P24 平台发布（RPA）

> 状态：实现中。本文件是**实现说明与交接骨架**，验证结果一律待真机校准后回填，不许编造。
> 契约基线：`docs/handoff/P24-平台发布RPA-契约.md`（F2 以它为准）。

## 1. 为什么做

员工任务不能只停在「写文案」：客户要的是文案写完直接发到抖音 / 小红书 / 视频号。
这三个平台都**没有对个人开发者开放的发布 API**（抖音开放平台需要企业资质且内容要审核，
小红书/视频号更没有对外的发文接口），所以唯一可行的自动化方式是 RPA：
用用户本机的登录态，在创作后台页面上模拟「上传素材 → 填标题正文话题 → 点发布」。

## 2. 架构：本机 RPA vs 服务端 API 的取舍

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 服务端直接调平台开放 API | 不可行 | 三平台对个人开发者不开放发文 API；且生产机在美国机房，IP 必然触发风控 |
| 服务端无头浏览器（Playwright/Puppeteer）跑在机房 | 不可行 | 新增依赖违反铁律；机房 IP + 无真实登录态，扫码/滑块过不去，发布必被拦截 |
| **桌面端 Electron 内嵌浏览器，本机执行** | **采用** | 用用户真实网络与真实账号，扫码一次后登录态持久化；不新增任何 npm 依赖（用 Electron 内建 CDP） |

进程分工：

- **桌面主进程**：`PlatformManager` 负责开窗口、上传、填表、点发布、截图；每个平台一个持久化 partition
  `persist:platform-<id>`，登录态存在那里。
- **桌面主进程 `api()`**：拦截 `/capabilities/run`，name 命中 `platform_publish` / `platform_status` / `platform_stats`
  时本机执行并返回 `{ success, data }` / `{ success, error }`，**不发网络请求**。
- **服务端**：只在能力目录里登记 descriptor；handler 一律抛「需要桌面端执行」，防止云端 worker 误以为能发。
- **渲染层**：`PlatformPublish.tsx` 提供三张平台卡（登录状态 / 扫码登录 / 打开调试窗口）与发布表单。

## 3. 三平台与发布流程

| 平台 | id | 创作后台 | 发布类型 | 标题上限 |
| --- | --- | --- | --- | --- |
| 抖音 | `douyin` | https://creator.douyin.com/creator-micro/content/upload | video / image（图文） | 30 字 |
| 小红书 | `xiaohongshu` | https://creator.xiaohongshu.com/publish/publish | video / image（图文） | 20 字（契约 §1 写 20；`clampTitle` 以 drivers 为准） |
| 视频号 | `shipinhao` | https://channels.weixin.qq.com/platform/post/create | video / image | 16 字 |

通用流程（每一步失败都截图到 `<userDataDir>/platform-logs/<platform>-<ts>-<step>.png` 并记进 `steps`）：

1. 打开隐藏窗口进入创作后台，先判登录态（未登录直接失败，提示先扫码）。
2. 定位 `input[type=file]`，用 CDP `DOM.setFileInputFiles` 塞入本机绝对路径素材（视频 1 个、图文 1-9 张）。
3. 等上传完成（页面出现预览/进度消失），再填标题与正文；中文必须走 `Input.insertText`，
   contenteditable 用 `document.execCommand('insertText')` 兜底。
4. 话题标签拼到正文尾部（`#tag`），标题按平台上限截断。
5. 点发布按钮，等成功提示（或跳转到作品页），尽量读回作品链接；读不到链接仍算成功，`url` 留空。
6. 全程选择器是**候选数组**，按顺序尝试，全不命中抛「选择器未命中」并附截图路径。

## 4. 能力与 IPC 契约

### 4.1 员工工具（服务端只登记 descriptor）

| 能力名 | 参数 | 说明 |
| --- | --- | --- |
| `platform_publish` | `platform`(douyin/xiaohongshu/shipinhao)、`type`(video/image)、`title`、`content`、`tags`、`mediaPaths`(本机绝对路径，逗号分隔) | 本机自动发布 |
| `platform_status` | `platform`（可选，留空查全部） | 查登录状态 |
| `platform_stats` | `platform` | 作品数据，当前仅登记未实现 |

服务端 `platform-tools.ts` 的 handler 统一抛：

```
平台发布需要在桌面端（本机）执行，请在客户端登录平台后再试
```

云执行器拿到这句中文后，模型应据此告诉用户：这条任务要打开客户端、扫码登录后再执行。

### 4.2 IPC（preload 白名单）

| 通道 | 入参 | 返回 |
| --- | --- | --- |
| `platform:status` | `{ platform?: string }` | `PlatformStatus[]` |
| `platform:login` | `{ platform }` | `PlatformStatus` |
| `platform:logout` | `{ platform }` | `{ ok: true }` |
| `platform:publish` | `PublishInput` | `PublishResult` |
| `platform:open-debug` | `{ platform }` | `{ ok: true }` |

`PublishResult` 带 `ok / message / url? / screenshots[] / steps[]`，UI 直接展示步骤列表与截图路径。

## 5. 文件清单

| 文件 | 负责人 | 说明 |
| --- | --- | --- |
| `packages/desktop/src/main/platform.ts` | 子 Agent A | PlatformManager：窗口、CDP 上传、填表、发布、截图 |
| `packages/desktop/src/main/platform-drivers.ts` | 子 Agent A | 三平台选择器候选数组 + `buildContent` / `clampTitle` 纯函数 |
| `scripts/smoke-p24-platform-drivers.mjs` | 子 Agent A | drivers 纯函数单测（node 直接跑） |
| `packages/server/src/capabilities/capabilities/platform-tools.ts` | 子 Agent B | 三个 descriptor + 本地专属 handler |
| `scripts/smoke-p24-platform-tools.mjs` | 子 Agent B | descriptor / handler 契约单测 |
| `packages/desktop/src/renderer/src/pages/PlatformPublish.tsx` | lead | 平台卡 + 发布表单 + 结果区 |
| `main/index.ts` / `preload/index.ts` / `capability.service.ts` / `Shell.tsx` | lead | IPC 接线、api() 拦截、能力注册、侧栏入口 |
| `packages/desktop/src/renderer/src/types.ts` / `styles.css` | lead | `FcmApi.platform` 类型、平台页样式 |
| `packages/worker/tool-loop.mjs` | lead | `CAPABILITIES` 加三个工具 + INSTRUCTIONS 用法 |
| `scripts/check-desktop-p24.mjs` | lead | 桌面侧静态自检 55 项（文件/导出/接线/样式/白名单） |
| `scripts/prod-verify-p24.mjs` | lead | 生产验收：能力登记 + 服务器侧中文拦截 16 项 |

## 6. 验证记录

> 待真机校准后回填；在拿到真实账号跑通之前，一律写「待补」，不得填「通过」。

静态与契约层（已全部通过，2026-11-08）：

| 项 | 结果 | 备注 |
| --- | --- | --- |
| 服务端 `tsc -p packages/server/tsconfig.json` | 通过 | `TSC_EXIT=0` |
| `node scripts/smoke-p24-platform-tools.mjs` | 通过 | `P24 platform-tools SMOKE OK (14 checks)` |
| `node scripts/smoke-p24-platform-drivers.mjs` | 通过 | `P24 platform-drivers SMOKE OK (67 checks)` |
| `node scripts/check-desktop-p24.mjs` | 通过 | `P24 desktop check OK (55 checks)`（platform.ts 导出/五方法/partition/CDP 上传/截图目录、页面六个调用、preload 六通道、main 六个 handler + `LOCAL_CAPABILITIES` 分流、Shell/types/styles、worker 白名单、服务端注册） |
| 桌面 `electron-vite build` | 通过 | `out/main/index.js 89.20 kB`、`out/preload/index.js 6.90 kB`、renderer 751.57 kB（40 modules） |
| 全量 `scripts/verify.ps1 -Smoke` | 通过 | `last-verify.json` `ok=true failed=0`（T-28 步含 P24 三个脚本） |
| 生产验收 `prod-verify-p24.mjs` | 通过 16 项 | 三个能力 `category=platform` 已登记；服务器侧调用一律 `success:false` + 「平台发布需要在桌面端（本机）执行，请在客户端登录平台后再试」；缺参/未知平台同样不外放 |

真机层（**仍未验证，必须用户本机扫码后逐平台校准**）：

| 项 | 结果 | 备注 |
| --- | --- | --- |
| 抖音登录 / 发布（video、image） | 待真机 | 需真实账号扫码；创建后台选择器零真机验证 |
| 小红书登录 / 发布（video、image） | 待真机 | `.publishBtn` / `.ql-editor` 属静态推断 |
| 视频号登录 / 发布（video、image） | 待真机 | 「发表」可能是 shadow/自定义组件，靠文本兜底 |
| 云执行器调用三个工具拿到中文提示 | 待真机 | 服务端提示文案已生产验证；桌面端本机执行待客户端实测 |

## 7. 风险

- **选择器易变**：三个平台都是前端频繁改版的 SPA，class/结构随时会变。已用候选数组 + 每步截图 + 可读报错兜底，
  但仍需真机跑一次、按截图改选择器。
- **风控**：同一账号高频发布、机房 IP、固定 UA 都可能触发限流/封号。方案限定在用户本机、真实网络执行，
  并且不做批量并发；发布频率应由用户自己控制。
- **验证码/滑块**：登录、发布都可能弹滑块或短信验证。当前策略是失败即停并在 `steps` 里明确报出，
  由 `platform:open-debug` 打开可见窗口让用户手动过一次，**不尝试破解验证码**。
- **登录态失效**：`persist:` partition 里的 cookie 会过期，需要重新扫码；`platform_status` 是发布前的必要前置检查。
- **发布不可撤销**：点下发布即对外可见，没有「审核」环节；因此表单校验、标题截断、素材存在性检查必须在本机做足。
- **无真机基线**：本机没有登录过的抖音/小红书账号，选择器只做了静态推断，未做真机验证。

## 9. 上线记录与真机校准指引

- 生产部署：`p24.tgz` 277,026 B / 338 文件 → `/opt/fcmediaagent` → `app/dist.bak.20261108190426` 备份换 dist、`worker/tool-loop.mjs` 换新 → 重启两服务 → `API=active WORKER=active HEALTH=200`。
- 生产验收：`P24 PROD VERIFY GREEN (16 checks)`（能力目录三项 `category=platform`；publish/status/stats 全部 `success:false` + 同一句中文提示；缺参与未知平台同样拦截）。
- 客户端：桌面 `0.1.6` 含「📤 平台发布」页；安装后在页面里逐个平台点「扫码登录」，登录态存在 `persist:platform-<id>` partition。
  - 安装包 `fcmediaagent-ai-employee-0.1.6-win-x64.exe` **127,747,539 B**，sha512 `0P7R3lhad5HQwg1BhmXyL/VrJm496ljyy2/r/g9E/nLMbbDvRIrFvtHPErjgPO3soQFvsGxZrhKO1QdNQpqLAw==`
  - 已发布 `https://updates.fcmediaagent.com/desktop/latest/latest.yml`（yml=200 exe=206），老客户端可从 0.1.5 静默升级（`quitAndInstall(true, true)`）。

真机校准步骤（每平台一次，约 10 分钟）：

1. 打开 0.1.6，进「📤 平台发布」，点某平台的「扫码登录」→ 手机扫码 → 卡片徽标变「已登录」。
2. 先点「打开后台」，确认可见窗口里是**发布页**（不是首页/登录页）。若落错页，改 `packages/desktop/src/main/platform-drivers.ts` 的 `entryUrl`。
3. 用一条真实短内容（视频 1 个 ≤50MB 或用图文 1 张）点「开始发布」。无论成功失败，步骤列表与截图都会写在
   `%APPDATA%\中科元晟 AI员工\platform-logs\`（`<platform>-<ts>-<step>.png`）。
4. 失败就把该步骤的截图发我：`选择器未命中` 说明对应 selector 要改；`仍在上传` 说明等上传时长不够；
   `未判定成功` 说明发布后页面没出现 successHint 也没跳转，需要把该平台的真实成功特征补进 drivers。
5. 三平台各跑通一次后，本文件 §6「真机层」表格才能从「待真机」改成「通过」。

## 8. 还没做

- `platform_stats`：只登记了 descriptor，handler 还是「本地专属」提示，作品数据读取（播放/点赞/评论）未实现。
- 定时发布：契约里 `PublishInput.scheduledAt` 已预留，但三平台对定时发布支持不一致，当前未接线。
- 发布失败的重试与断点续跑：目前失败即停，靠截图人工修选择器。
- 多账号：一个平台只支持一份登录态（单 partition），多账号切换需要再做账号槽位。
- 发布结果回写员工任务产物（作品链接进 task artifacts）：待 lead 接线后补。

## 10. 0.1.7 修复：真机首测暴露「Electron UA 被平台屏蔽」

真机首测（0.1.6）现象与根因：

| 平台 | 0.1.6 表现 | Chrome UA 下表现 | 根因 |
| --- | --- | --- | --- |
| 小红书 | 「打开页面失败：ERR_FAILED (-2) loading .../login」 | readyState=complete、标题「小红书创作服务平台」 | 平台按 UA 屏蔽 Electron |
| 视频号 | 「打开页面失败：ERR_FAILED (-2) loading .../platform」 | 302 到 login.html 后正常渲染「视频号助手」 | 同上（+ 302 触发 ERR_ABORTED） |
| 抖音 | 未报错但长时间停在加载 | readyState=complete、标题「抖音创作者中心」，但 load 事件 40s 不触发 | 长连接子资源让 load 永不触发 |

排查依据：PowerShell `Invoke-WebRequest` 与 Electron `net.fetch` 对三个 URL 都返回 200，说明网络正常；
同一 Electron 38.8.6 只改 UA 就从小红书 ERR_TIMED_OUT 变为 LOAD_OK —— 因此不是网络、不是证书，是 UA。

0.1.7 的两处改动（`packages/desktop/src/main/platform.ts`）：

1. **分区级 Chrome UA**：`const PLATFORM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<主版本>.0.0.0 Safari/537.36'`，
   在 `createWindow` 里 `session.fromPartition(partition).setUserAgent(PLATFORM_UA)`。窗口级 UA 对导航不生效，必须挂分区。
2. **导航就绪判定改为轮询**：不再等 `load` 事件（抖音永远不触发）也不再因 302 的 ERR_ABORTED 判失败，
   改为 `loadURL().catch(...)` 后每 400ms 执行 `READY_SCRIPT`（`document.readyState !== 'loading'` + `location.href` + `bodyLen`），
   就绪即成功；30s 未就绪才报「打开页面失败」，并带上最后一次的真实错误或「页面一直停在加载中」。

`scripts/check-desktop-p24.mjs` 增加 4 条断言把这层固定住（PLATFORM_UA / setUserAgent / READY_SCRIPT 轮询 / 不再出现旧的「打开页面超时」文案），
现为 59 项。
