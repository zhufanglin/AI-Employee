# 跨 Agent 协作总线（Codex · WorkBuddy · DeepSeek Harness）

这里解决的问题只有一个：**三个 Agent 在不同应用里干活，怎么保证像一个人在干。**

答案：**磁盘即总线**。不靠聊天记录、不靠口头交接、不靠"我记得"，全部落成文件。

## 一次完整的交接长什么样

```
Codex 干完 T-07
  → node scripts/coord.mjs done T-07 --agent codex --note "定时器+补跑已实现，冒烟 smoke-cron.mjs 全绿"
  → JOURNAL.md 追加一行；state.json 里 T-07 变 done；BOARD.md 自动重生成
  → node scripts/coord.mjs msg dsh-lead "EmployeeCron 的 nextRunAt 用 Asia/Shanghai 计算，别再自己算" --from codex

我（dsh-lead）下一次开口时
  → node scripts/coord.mjs resume --agent dsh-lead
  → 输出：「你上次看之后发生的事（3 条）」包含 Codex 的 DONE 与 MSG
  → 我看情况接 T-08，或 msg 回 Codex
```

## 文件职责

| 文件 | 谁写 | 谁读 | 作用 |
|---|---|---|---|
| `state.json` | 只能由 `coord.mjs` 写 | 全部 | 阶段 / 任务 / 负责人 / 写作用域 / 环境 |
| `BOARD.md` | 自动生成 | 人 + Agent | 看板，最直观的进度 |
| `JOURNAL.md` | 追加写 | 全部 | 流水账，交接凭证；`resume` 按 marks 只显示增量 |
| `inbox/<agent>.md` | 任何 Agent | 该 Agent | 点对点留言，`- [ ]` 未读 |
| `marks/<agent>.json` | `resume` 自动 | — | 「你上次看到第几条」 |

## 命令速查

```powershell
node scripts\coord.mjs resume --agent codex     # 开工（唯一入口）
node scripts\coord.mjs status                   # 全局进度
node scripts\coord.mjs claim T-07 --agent codex # 认领（写作用域由 state.json 里定义）
node scripts\coord.mjs done  T-07 --agent codex --note "..."
node scripts\coord.mjs note "一句话"             # 顺手记
node scripts\coord.mjs msg workbuddy "..." --from codex
node scripts\coord.mjs inbox workbuddy          # 只看留言
node scripts\coord.mjs sync                     # 重生成看板
node scripts\coord.mjs add "新任务标题" --agent dsh-lead --accept "验收标准" --scope "packages/server/src/x"
```


## 故障接管（这是这套总线的真正目的）

分工是次要的，**接力**才是目的：谁额度用完、谁被限流、谁崩了，另一个人必须能从他停下的那一行继续，不重做、不问人。

### 三条命令

§§§powershell
# 1) 干活着的人，每做一小步就存断点
node scripts\coord.mjs save T-07 --agent codex --note "Cron 表已建模，scheduler 跑通" --next "补 missedOf 补跑 + smoke"

# 2) 做不动了，显式声明（quota | ratelimit | api | env | human | other）
node scripts\coord.mjs block T-07 --agent codex --reason quota --note "方舟额度耗尽"

# 3) 接手的人一条命令拿全部上下文
node scripts\coord.mjs takeover T-07 --from codex --agent dsh-lead
§§§

### takeover 会告诉你什么

- 原负责人、阻塞原因、卡了多久
- 断点里的**进度清单**和**下一步**
- **认领之后哪些文件被新增/修改/删除**（认领时自动存了文件快照，接手时比对）
- **最近一次 verify.ps1 是红还是绿**（`docs/handoff/last-verify.json`）
- 然后把所有权转给你，并把这次转手写进 `checkpoints/T-07.md` 历史与 JOURNAL

### 原负责人直接崩了（没来得及 block）怎么办

`node scripts/coord.mjs check` 会把**心跳超过 25 分钟**的 doing 任务标成 `stalled`。
每个 Agent 的 `resume` 输出里都有「可以接手的任务」段落，直接给出 takeover 命令。

### 心跳

`save` / `heartbeat` 都会刷新心跳。长时间跑一个大编译/大测试之前先 `save` 一次，否则容易被打成 stalled。

## 防撞车规则

1. **claim 才有写权**：state.json 里每个任务带 `scope`（仓库相对路径前缀）。同 scope 的任务不会同时给两个人——`claim` 会拒绝已被他人认领的任务。
2. **schema 独占**：`packages/server/prisma/schema.prisma` 同一时刻只允许一个 Agent 改，迁移名先写进 JOURNAL。
3. **完成即验证**：`scripts/verify.ps1` 绿灯才能 `done`。红灯就 `release` 或 `msg` 说明卡点。
4. **不许静默改别人的文件**：跨 scope 修改前先 `msg` 并在 JOURNAL 留痕。

## 我（Lead）怎么发现你们干完了

每次用户跟我说话，我第一件事就是 `resume --agent dsh-lead`，它会列出「你上次看之后发生的事」。所以你们只要正常 `done`/`note`/`msg`，我一定能看到——**不需要用户转述**。

## 环境自检

```powershell
powershell -File scripts\dev-up.ps1      # Docker + MySQL + 服务端，等 /api/health
powershell -File scripts\verify.ps1      # 编译服务端 + 构桌面端
powershell -File scripts\verify.ps1 -Smoke   # 再加接口冒烟
powershell -File scripts\dev-down.ps1
```
