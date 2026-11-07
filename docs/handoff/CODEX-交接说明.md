# CODEX 交接说明（主执行 Agent 切换）

> 写于 2026-11-05，交接人 dsh-lead。你（Codex）从现在起是本项目的**主执行 Agent**；我转为协助/兜底：救援卡住的任务、跑验证、回答契约问题，但不再和你并行写同一批文件（写作用域冲突比进度慢更贵）。

## 0. 三十秒上手

```powershell
cd C:\Users\30290\Desktop\fcmediaagent-replica
node scripts\coord.mjs resume --agent codex     # 看：分给我的 / 可接手的 / 我离开后发生了什么
node scripts\coord.mjs claim T-08 --agent codex # 认领（会生成断点文件 + 文件快照）
# ...开工，每完成一小步就 save...
node scripts\coord.mjs save T-08 --agent codex --note "做完什么" --next "下一步具体到文件和函数" --progress "+已完成;进行中;未开始"
.scripts\verify.ps1 -Smoke                     # 不绿不许 done
node scripts\coord.mjs done T-08 --agent codex --note "交付摘要 + 已知缺口"
```

做不动了（额度/限流/环境）**不要静默停**：`node scripts\coord.mjs block T-08 --agent codex --reason quota --note "..."`，我会在巡检时 takeover 接上。

## 1. 当前进度（真实数字，2026-11-05 快照）

- 看板：**done 8 / 19**（T-01…T-07 + T-18）。你可以直接开 T-08。
- 服务端：NestJS 11 + Prisma 6.19.2 + MySQL 8，**38 个 model / 531 个字段行 / 8 个 controller / 35 条路由**，已通：短信+密码+管理员登录、站点配置、模型代理（compute + volcengine-proxy）、proxy-token、免费额度与积分计费、用量流水、员工目录与安装/运行/审批、定时器补跑与看板汇总。
- 桌面端：Electron 38 + React 19 + electron-vite 4，**22 个 IPC**，已通：登录、对话（SSE 流式）、积分用量、渠道网关（openclaw 托管，agent 端到端已验证）、设置。
- 原版契约基线（**F2 必须 100% 对齐**）：见 `docs/fidelity-matrix.md` —— 原版 237 路由 / 147 IPC / 47 表 / 588 字段；当前复刻 35 路由 / 22 IPC / 38 表。缺口已按阶段映射，别自己另起一套。

## 2. 环境硬事实（照抄，别猜）

| 项 | 值 |
|---|---|
| Node（唯一可用） | `C:\Users\30290\Desktop\REA逆向\toolchain\node-v24.22.1-win-x64\node.exe`，npm 11.19.1 |
| 数据库 | Docker 容器 `fcm-mysql`（mysql:8.0.46），`127.0.0.1:3306`，库 `fcmediaagent_v2`，用户 `fcm` / `fcm_dev_pass`（root/root_dev_pass） |
| 服务端地址 | `http://127.0.0.1:3000/api`，Swagger `/api/docs` |
| 密钥 | `packages/server/.env`（已 gitignore）；火山方舟 `ARK_API_KEY` 已配，可用真实模型 `doubao-seed-2-1-pro-260628` / `-turbo-` / `-code-preview-260215` |
| 原版素材 | `C:\Users\30290\Desktop\部署文件\_extract\`：`0.4.29\asar`（asar 解包 + 169 个 node_modules）、`server1027`（服务端 dist + prisma）、`config-dump`（脱敏配置快照）、`ipc_handles_0429.tsv` |
| 一键起环境 | `scripts\dev-up.ps1`（拉 Docker→起 MySQL→tsc→起服务→轮询 /api/health）；停：`dev-down.ps1` |

## 3. 六个会让你白干的坑（都踩过）

1. **不要用 tsx/ts-node 跑 Nest**：esbuild 不产出 `emitDecoratorMetadata`，构造注入全是 undefined，报 `Cannot read properties of undefined (reading 'getAllAndOverride')`。必须 `tsc` 编译后跑 `node dist/main.js`。
2. **`npx.ps1` 被 PowerShell 执行策略拦**：一律用 `npx.cmd` / `npm.cmd`；跑 .ps1 用 `$sb=[scriptblock]::Create((Get-Content -Raw -Encoding utf8 "x.ps1")); & $sb`。
3. **electron-vite / electron 在仓库根 node_modules（hoisted）**：命令用 `node node_modules\electron-vite\bin\electron-vite.js`，写包内相对路径会 MODULE_NOT_FOUND。
4. **单条命令有 120s 墙**：prisma migrate / tsc / npm install / 前端构建都可能超时，放后台 job 跑再取日志。
5. **MySQL 不允许 TEXT 带默认值**（错误 1101）；Session.accessToken 用 `@db.VarChar(512)`（1024 会撞 3072 字节索引上限）。
6. **PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写 BOM**，Node 端 `JSON.parse` 直接炸；读时先 `.replace(/^\uFEFF/, "")`。

## 4. REA 怎么用（你已接入，但有几个致命细节）

- CLI 形式（绕开 MCP 也行）：
  ```powershell
  $env:TEMP="C:\Users\30290\Desktop\部署文件\_tools\reatmp"; $env:TMP=$env:TEMP
  & "C:\Users\30290\Desktop\REA逆向\toolchain\node-v24.22.1-win-x64\node.exe" "C:\Users\30290\Desktop\REA逆向\rea\scripts\rea.mjs" analyze-javascript-application <root> --source-path <相对root的路径> --analysis-timeout-ms 1800000 --json
  ```
- **第一件事必须是改 TEMP/TMP**：不改时 REA 会在 `%TEMP%` 删探针文件被拒，报 `Delete owned object by handle failed (Win32 5)`，看起来像"REA 不可用"，其实只是临时目录没权限。
- `--source-path` 必须**相对应用根目录**，多写一层目录会返回 `Analysis input is invalid`（752B 错误体，不改代码看不出来）。
- **不要对原版 2.3MB 混淆主包 `main/index-B-hcztoU.js` 跑语义分析**：1800s 也超时。REA 在 16KB 级文件（preload/index.js）上很稳；2MB+ 混淆包改用"mock electron 动态 import 拿运行时契约"的办法（见第 5 节）。
- 输出 JSON 带 UTF-8 BOM，解析前先去 BOM。

## 5. 原版逆向的两个高杠杆手段（已验证，别重造）

1. **mock electron 跑主进程**：`Module._load` 打桩返回 Proxy mock + 自写 asar 解包器抽出 169 个包 → ESM 动态 import 主包，直接拿到 **147 个 ipcMain.handle 的真实通道名与签名**，产物 `_extract/ipc_handles_0429.tsv` 与 `contracts/ipc_contract_0429.md`。这比静态正则强得多（字符串法只推断出 90 条）。
2. **javascript-obfuscator 字符串表还原**：注入 `globalThis.__dec=_0xNNNN` + vm 沙箱打桩（`import.meta` 换成 `({url:'app://local/'})`、剥 `export`），可把 renderer 9.18MB 包解出 44535 条字符串、主进程 7949 条。产物在 `_extract/*_strings.txt`。

## 6. 三个不许碰

1. **生产服务器**（`ssh -i ~/.ssh/fcmediaagent_deploy -p 2222 root@8.163.59.118`，应用在 `/www/wwwroot/fcmediaagent.com`）：只读，禁止写库/改配置/重启。生产库已脱敏导出，够用。
2. **原版安装目录与 `C:\Users\30290\AppData\Local\Programs\RRClaw`**：只读参照，不要改动（那是用户装着的软件）。
3. **不要把任何密钥写进仓库文件**（只进 `.env` 或系统环境；`.env` 已在 .gitignore）。

## 7. 用户已锁定的决策（擅自改=返工）

17 个 AI 员工替换原版 12 个并提前为 W4/W5 重点项；个人微信走自研 UIAutomation（不注入不挂钩）；微信支付用已有商户号（appId `wx219da5e18416b3fd` / mchId `1118595998`）；媒体链路（数字人/对口型/混剪）**调第三方云 API，不自建 GPU**；品牌沿用「中科元晟」、域名 `fcmediaagent.com`；模型官方直连；新库不碰生产；更新源 OSS + 自建 `latest.yml`；网关直接复用随包 openclaw；飞书多维表格不要（换本地表）；8 周排期。

## 8. 需要用户拍板才能动的（别自己定）

积分包与媒体计价（原版 999 积分=¥1 是占位数据，低于 GPU/API 成本）、灰色自动化 .pyc 技能能否随包分发、是否云端托管执行任务、tads 腾讯广告 20 条 IPC 做不做、语音（vosk-bgm）做不做。

## 9. 交接纪律（比技术更重要）

- 每小步 `save`，卡住 `block`，别静默消失 —— 这是用户明确的要求（他不想为额度充值，要能换 Agent 接着干）。
- **不要拿真实任务做演练**（我踩过：把 codex 的 T-07 从 done 打回 todo）。要演练故障接管，用 `DEMO-*` 假任务。
- 一个任务一个写作用域；跨作用域先改 state.json 的 scopes 再动手。
- `verify.ps1` 红了不要 `done`；红了也不要修别人的文件，先 `msg dsh-lead`。
