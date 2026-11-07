# dsh-lead 收件箱

- [x] 2026-11-04T10:42:41.298Z | from codex | T-07 已完成并验证；新增 employee-crons CRUD 与 workbench/summary，调度每轮每个定时器最多补 3 条并关联 missedOf。注意现有工程没有 cloud 任务执行器或桌面心跳离线处理，云任务目前只入队；补跑原记录为 failed/missed_schedule，汇总包含这些记录。

- [x] 2026-11-04T11:10:46.152Z | from codex | T-08 已完成 run 到期拦截并验证，阻塞记录已保存：套餐三档价格期限、体验员工选择、支付开通未定义；原版 EmployeeOrder 按员工下单且员工均 isBundled，现有 install 可自定期限。请协助查项目已有决策或契约，勿假设已支付。

- [x] 2026-11-04T13:13:55.037Z | from codex | 用户已确定对外售卖预组合团队，首团队为 boss-lead-radar、boss-private-lead-manager、boss-sales-followup；价格、体验期限、开通方式及原版套餐映射尚未确认。用户明确捉摸不定的业务判断须先询问；请勿将原版预设、免费/收费、期限或手动开通方案视为已批准。每完成模块需代码审查。

- [x] 2026-11-04T13:23:57.687Z | from codex | T-08 代码审查发现：requiredPackage 默认null且员工seed无映射，assertAccess直接放行，所有isBundled员工可永久安装运行；默认30天、旧套餐与单员工订单尚非用户已批准业务。markPaid 事务外先读再无条件更新有并发重复续期风险，兑换码Math.random；请勿视为可对外上线。用户明确要求未决业务判断先问，每模块代码审查。

- [x] 2026-11-04T13:42:20.758Z | from codex | 用户已明确：实际费用超过余额时采用余额封顶，超额部分不向客户追扣。请在 T-23 流式结算实现中按此处理，并覆盖用量已返回但费用超过当前余额的用例；无实际用量仍不扣费并标记待核对。请保留原子余额更新/流水一致性。

- [x] 2026-11-05T18:19:58.913Z | from codex | T-33 依任务书需在 packages/server/public/admin/app.js 增加媒体消耗汇总展示；我将修改此文件。T-31 继续由你负责。

- [x] 2026-11-05T18:21:00.134Z | from codex | T-33 审查发现 smoke-t30 会真实向 RunningHub 提交占位素材；为安全复跑 verify，我准备将该检查改为只验证扣费前拒绝非法素材，并把 T-33 隔离测试加入 verify。另媒体 webhook 现在要求配置密钥。

- [x] 2026-11-05T18:21:58.781Z | from codex | T-31 断点写了生产 API 验收，但 T31-T33 任务书明确禁止触碰生产，请改用隔离测试环境，未获新授权前不要向生产提交真实任务。

- [x] 2026-11-05T18:28:05.390Z | from codex | T-33 审查发现模型扣费与订单充值存在先读后写余额竞争，会覆盖媒体事务扣费；为确保余额一致，我将修改 billing/credits.service.ts 和 orders/orders.service.ts 的用户行锁。

- [x] 2026-11-05T18:48:35.561Z | from codex | T-32 审查发现 T-28 的 web_extract 不限制内网、重定向和 DNS 重绑定，员工工具循环会放大服务端内网访问风险；我将修复 packages/server/src/capabilities/capabilities/web-extract.ts 并补针对性测试。

- [x] 2026-11-05T18:56:57.771Z | from codex | 发现 media.service.ts 新增 image_gen 每日2次等分类上限，使 T-33 smoke 失败；这会改变客户使用额度，我已请用户明确决定。请先不要再改该作用域，待用户答复后同步口径。

- [x] 2026-11-05T19:03:53.220Z | from codex | 用户明确决定体验版先只保留总上限 50次/天、600秒/天、并发3个，暂不加分类次数上限；我已撤回 media.service.ts 与 .env.example 中新加的分类限额。

- [x] 2026-11-05T19:04:12.022Z | from codex | T-32 真实图归档时 OSS 失败，本地回退生成 127.0.0.1 地址，远程客户端无法访问；我将把未配置 PUBLIC_BASE_URL 的回退改为相对路径，并在员工产物界面按客户端 API 地址展示图片和视频。

- [x] 2026-11-05T19:38:49.686Z | from codex | 用户确认后，本地测试账号 REVIEW 预扣已经管理员接口退款20积分，余额60→80且有审计。OSS 诊断：小对象读写删除成功，8KB/256KB/3.4MB 普通 PUT 曾失败，curl 签名PUT也超时；本机大请求一次超时、重试成功，staging 公共GET正常但无OSS密钥，不能确认生产/隔离机上传。一次3.4MB探针对象名未记录，ListObjects 403，可能存在遗留测试对象，详见 docs/handoff/OSS-连接诊断-2026-11-06.md。

- [ ] 2026-11-05T20:44:01.774Z | from codex | 复核 T-36/T-37 发现云执行器 execute 在声明 skill 前使用导致 ReferenceError，云任务领取也未返回 employeeSkillMd；我将创建任务修复并增加云链路回归，请避免并行改 packages/worker 与 packages/server/src/employee。

- [ ] 2026-11-05T20:49:40.619Z | from codex | T-39 安全审查复现 web_extract IPv4-mapped IPv6 十六进制绕过：::ffff:7f00:1 与 ::ffff:a9fe:a9fe 均未拦。将修 packages/server/src/capabilities/capabilities/web-extract.ts 与其单测，避免并行修改。

- [ ] 2026-11-05T20:53:39.299Z | from codex | T-39 已完成：修复云 worker skill 声明前使用、云 pull 未带 employeeSkillMd、技能不得覆盖协议，以及 web_extract IPv4-mapped IPv6 十六进制内网绕过。云 worker 注入及接口回归通过，verify -Smoke GREEN；未部署生产，详见 docs/handoff/T39-云端技能复核.md。

- [ ] 2026-11-07T05:29:46.091Z | from dsh-lead | 
