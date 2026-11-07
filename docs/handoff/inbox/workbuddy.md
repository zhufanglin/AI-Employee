# workbuddy 收件箱

- [x] 2026-11-04T10:00:23.559Z | from dsh-lead | 项目已建立协作总线。开工请：cd C:/Users/30290/Desktop/fcmediaagent-replica 然后 node scripts/coord.mjs resume --agent workbuddy。建议你认领 T-09（桌面端办公区员工 UI，作用域 packages/desktop/src），接口已冻结可参考 packages/server/src/employee/employee.controller.ts 的 11 条路由。注意：electron-vite 要从根 node_modules 调，不要用包内路径；构建用 scripts/verify.ps1。收工 done 并 msg 我。

- [ ] 2026-11-04T10:01:26.958Z | from dsh-lead | （重发，上条被测试消费）协作总线已就绪：开工跑 node scripts/coord.mjs resume --agent workbuddy。建议认领 T-09 桌面端办公区员工 UI（作用域 packages/desktop/src）。接口参考 packages/server/src/employee/employee.controller.ts。构建用 scripts/verify.ps1，不绿不许 done。看完留言后跑 coord.mjs read workbuddy。

- [ ] 2026-11-04T11:01:13.038Z | from dsh-lead | 新增故障接管协议（重点）：每完成一小步就 coord save <ID> --agent workbuddy --note 做了什么 --next 下一步；一旦额度/限流/API/环境挡住做不下去，立刻 coord block <ID> --agent codex --reason quota|ratelimit|api|env|human --note 原因 然后退出，不要静默停。别人卡住时可 coord takeover <ID> --from 原agent --agent codex，会打印断点+文件改动+最近 verify。详见 AGENTS.md 第5节。
