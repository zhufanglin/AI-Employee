> **主执行 Agent：dsh-lead（2026-11-05 16:30 起接手，Codex 转为协作/复核）** — 交接依据 docs/handoff/checkpoints 与 JOURNAL。

# AGENTS.md —— 本项目开工契约（所有 Agent 通用）

> 本文件是 **Codex / WorkBuddy / DeepSeek Harness(Lead)** 三个 Agent 的**唯一入口**。
> 不管你是哪个应用、谁把你叫起来的，**开工第一件事**都是跑下面这条命令，然后严格按它的输出干活。

## 0. 开工（必须执行，不许跳过）

```powershell
cd C:\Users\30290\Desktop\fcmediaagent-replica
C:\Users\30290\Desktop\REA逆向\toolchain\node-v24.22.1-win-x64\node.exe scripts\coord.mjs resume --agent <codex|workbuddy|dsh-lead>
```

这条命令会告诉你：项目做到哪了、**分给你的任务**、**你可以认领的任务**、别人给你的留言、**你上次看之后别人改了什么**、环境事实、必读文档。

## 1. 项目是什么

把商业产品「中科元晟 AI员工 0.4.29」（一个基于开源 OpenClaw 的 Electron 桌面 AI 员工客户端 + NestJS 服务端 + Web 管理端）**从行为层面完整复刻**成我们自己的代码。原版安装包、解包产物、服务端编译产物都在 `C:\Users\30290\Desktop\部署文件\`，只读参考，**永远不要改那里**。

复刻成品：`C:\Users\30290\Desktop\fcmediaagent-replica`（本仓库）。

## 2. 五层忠实度（判断"做对了没"的唯一标准）

| 层 | 内容 | 要求 |
|---|---|---|
| F4 架构 | 进程/模块划分、网关与代理拓扑 | 可不同，但必须能解释 |
| F3 行为 | 用户点一下之后发生什么、状态机、调度 | 必须一致 |
| **F2 契约** | **HTTP 路由 + 入参出参、IPC 通道、数据库表/字段、错误码与错误文案** | **100% 对齐，不许"看起来差不多"** |
| F1 文案 | 中文提示语、按钮文字、错误提示 | 逐字对齐（可从原版混淆产物字符串表取） |
| F0 视觉 | 像素 | 近似即可 |

F2 的基线在 `docs/fidelity-matrix.md` + `contracts/`（237 条路由 / 147 个 IPC / 47 张表 / 588 字段）。**新增接口前先查基线，命名不许自创。**

## 3. 三条铁律

1. **一个写作用域同一时刻只有一个 Agent 写。** 认领任务时用 `--scope` 声明，冲突就 `msg` 对方，不许硬改别人的文件。
2. **不许碰密钥。** `packages/server/.env` 只读不写；新配置项只加到 `.env.example`。
2.1 **机器边界（2026-11-06 澄清，曾被误解）**：`8.163.59.118` 是原版商业产品生产机，**永久只读**；`154.64.255.36` 与他人共用，**仅 staging**；`47.85.46.165` 是我们自己的复刻生产机（ai.fcmediaagent.com），**只有 dsh-lead 有权操作**（部署与真机验收），其他 Agent 需要时找 dsh-lead。
3. **数据库 schema 只有一个入口。** 改 `prisma/schema.prisma` 前必须在 JOURNAL 里声明迁移名（`prisma migrate dev --name <名字>`），迁移提交后再动代码。

## 4. 环境事实（本机实测，别再自己猜）

- **Node 只用这个**：`C:\Users\30290\Desktop\REA逆向\toolchain\node-v24.22.1-win-x64\node.exe`（同目录 `npm.cmd` / `npx.cmd`）。系统自带的 `C:\node.exe` 是 v24.18，**不要用**。
- **MySQL**：Docker 容器 `fcm-mysql`，`127.0.0.1:3306`，库 `fcmediaagent_v2`，用户 `fcm / fcm_dev_pass`。Docker Desktop 不会自启，先 `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"` 等 40–60s，再 `docker start fcm-mysql`，**等 mysqld 起来**否则 Prisma 报 `P1001`。
- **服务端**：`packages/server` → `tsc -p tsconfig.json` → `node dist/main.js`（端口 3000，全局前缀 `/api`，Swagger `/api/docs`）。**禁止用 tsx 跑 Nest**（esbuild 不产出 emitDecoratorMetadata，注入全变 undefined）。
- **桌面端**：`packages/desktop` → `node ..\\..\\node_modules\\electron-vite\\bin\\electron-vite.js build`（electron-vite 被 hoist 到根 node_modules，别写包内路径）。
- **单次命令 120s 上限**：`npm install` / `prisma migrate` / `tsc` 这类必须放后台 job 跑。
- **PowerShell 执行策略**拦 `.ps1`/npx.ps1：跑脚本用 `$sb=[scriptblock]::Create((Get-Content -Raw <path>)); & $sb`，跑 npx 用 `npx.cmd`。
- 一键拉起/停止/验证：`scripts/dev-up.ps1` / `scripts/dev-down.ps1` / `scripts/verify.ps1`。

## 5. 故障接管协议（最重要，别的都能慢，这个不能缺）

**前提**：任何 Agent 都可能中途消失 —— 额度用完、被限流、API 500、进程崩了、环境坏了。所以：

**正在做的任务，必须随时留下断点。**

```powershell
# 每做完一小步（不是一大块）就存断点：做了什么 + 下一步做什么
node scripts\coord.mjs save T-07 --agent codex --note "EmployeeCron 表已建模，scheduler 骨架跑通" --next "补 missedOf 补跑逻辑，然后写 smoke"
```

断点落在 `docs/handoff/checkpoints/<ID>.md`（进度清单 + 下一步 + 已改文件 + 决策坑），人看文件就能接。

**做不动了，必须显式声明，不许静默停：**

```powershell
node scripts\coord.mjs block T-07 --agent codex --reason quota --note "方舟额度耗尽，续做需充值或换 key"
# reason 取值：quota | ratelimit | api | env | human | other
```

**另一方的接手动作（一条命令拿到全部上下文）：**

```powershell
node scripts\coord.mjs takeover T-07 --from codex --agent dsh-lead
```

它会打印**接手简报**：原负责人与阻塞原因、断点里的「下一步」、**认领后哪些文件被新增/修改/删除**（基于认领时的文件快照自动比对）、**最近一次 verify 是红还是绿**。然后所有权自动转给你，历史留痕。

**如果原负责人是直接崩掉的（没来得及 block）**：跑 `node scripts/coord.mjs check` —— 心跳超过 25 分钟没更新的 doing 任务会被自动标记为 `stalled`，并出现在每个 Agent `resume` 输出的「可以接手的任务」里。

**接手后怎么干**（顺序不许颠倒）：
1. 读 `docs/handoff/checkpoints/<ID>.md` 的「下一步」；
2. 跑 `scripts/verify.ps1` 确认当前代码是红是绿（别接手一个本来就编译不过的树还以为是自己的锅）；
3. 按快照 diff 快速过一遍别人改过的文件，别重复实现；
4. 继续 `save` → `done`。

**额度不足的正确姿势**：不是"等充值"，是 `block --reason quota` + `msg` 通知下一个 Agent，然后退出。项目不允许因为某个 Agent 的额度卡住整个进度。

## 6. 协作总线（职责与文件）

全部在 `docs/handoff/`：

- `state.json` —— 单一事实源：阶段、任务、负责人、写作用域、环境。**只有 `coord.mjs` 能改它。**
- `BOARD.md` —— 由 state.json 自动生成的任务看板，人看这个。
- `JOURNAL.md` —— 追加式流水账：谁在什么时候 CLAIM/DONE/NOTE/MSG 了什么。**这是交接的凭证。**
- `inbox/<agent>.md` —— 点对点留言，未读用 `- [ ]` 标记，`resume` 会展示并自动清未读。
- `marks/<agent>.json` —— 每个 Agent 的"上次看到第几条日志"，用来只显示增量。

常用命令（都在仓库根执行）：

```powershell
node scripts\coord.mjs resume --agent codex      # 开工
node scripts\coord.mjs claim T-07 --agent codex  # 认领
node scripts\coord.mjs done  T-07 --agent codex --note "定时器+补跑已完成，冒烟见 ..."
node scripts\coord.mjs note "顺手修了 xxx"        # 记一笔流水
node scripts\coord.mjs msg dsh-lead "T-07 的 API 已冻结，见 docs/x.md" --from codex
node scripts\coord.mjs status                    # 全局进度
```

## 7. 收工（必须执行）

1. `powershell -ExecutionPolicy Bypass -File scripts/verify.ps1` —— **必须绿灯**（服务端 tsc + 桌面端 build；带 `-Smoke` 还会跑接口冒烟）。
2. `node scripts\coord.mjs done <ID> --agent <你> --note "做了什么 + 产物路径 + 已知未完成项"`
3. 有需要别人接着做的事：`msg` 给对应 Agent；**不要口头交接**。

## 8. 代码约定

- 服务端：NestJS 11 + Prisma 6。控制器按域分目录（`src/<domain>/<domain>.{module,controller,service}.ts`），错误用 Nest 内建 HttpException，**错误文案照抄原版**（原版字符串表在 `C:\Users\30290\Desktop\部署文件\_extract\*`）。
- 前端：React 19 + electron-vite，状态就近放，IPC 全部走 `window.fcm`（preload 白名单），**不要开 nodeIntegration**。
- 网关：直接复用原版 `packages/desktop/resources/openclaw`（MIT），我们只负责生成配置 + 拉进程 + 探活。
- 新增依赖前先在 JOURNAL 记理由；能用 stdlib 就不加包。

## 9. 现在的位置（阶段）

见 `docs/handoff/BOARD.md` 顶部「当前阶段」。**不要凭记忆判断进度，每次都以 BOARD 为准。**

---

*维护：`dsh-lead`。改动本文件需要 `msg` 通知另外两个 Agent 并在 JOURNAL 记录。*
