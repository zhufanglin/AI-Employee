# P44 运维保障（第一波）执行 Prompt

> 起因：User said (m21191)「好,按你的顺序来执行.你写一个执行 prompt,跟你的子 Agent 一起执行」。
> 依据：docs/handoff/P44-运维保障-自检清单.md 的 A1–A6（SSH 单点、无备份、无监控告警、日志不轮转、admin 初始密码、生产残留测试数据）。
> 本波只做「让生产能扛住事故」，不新增产品功能。

## 一、目标（可验收）

1. **每天自动备份 MySQL 并可恢复**：本地留 14 天 + 可选 OSS 异地，备份可校验、恢复演练脚本可跑通。
2. **有监控与告警**：健康、队列积压、worker 心跳、上游欠费、磁盘/内存、备份新鲜度 六项，异常能落日志并推送（webhook 可配）。
3. **日志有轮转**：api.log / worker.log 按天轮转 + 压缩 + 保留 14 天，不撑爆磁盘。
4. **后台 admin 密码不再是初始值**，生产测试数据清理有 dry-run 报告后再执行。
5. **运维手册**：给同事看的部署/回滚/备份恢复/告警处置说明。

## 二、生产事实（所有脚本按此写，禁止硬编码密钥）

- 生产机：47.85.46.165（阿里云弗吉尼亚 4C8G），唯一归我们所有；staging 154.64.255.36 **只读、不许动**。
- Node：/opt/node/bin/node（24.22.1，非交互 ssh 无 PATH，必须写绝对路径）。
- 应用目录：/opt/fcmediaagent/app（dist/ 与 systemd 启动的 dist/main.js），环境变量在 /opt/fcmediaagent/app/.env。
- 服务：systemd fcmediaagent-api(:3000)、fcmediaagent-worker；nginx 反代 443；日志 /opt/fcmediaagent/logs/{api.log,worker.log}（systemd StandardOutput=append，journalctl 看不到）。
- MySQL：docker 容器 fcm-mysql，127.0.0.1:3306，库 fcmediaagent；连接串在 app/.env 的 DATABASE_URL（形如 mysql://user:pass@127.0.0.1:3306/fcmediaagent）。
- 更新/静态：/opt/fcmediaagent/updates（nginx 站点 updates.fcmediaagent.com）。
- 备份目录（本波新建）：/opt/fcmediaagent/backups/{mysql,logs}。
- ops 安装目录（本波新建）：/opt/fcmediaagent/ops。
- ssh 偶发 Connection refused / Connection closed，**必须重试 2–8 次**，间隔 5–10 秒；ssh 传脚本一律先 tools.write 落盘 → scp → ssh bash（不要用 PowerShell 管道 base64）。
- 生产 .env 里可用：ALIYUN_SMS_*、OSS_*（桶 zhongke001）、DATABASE_URL、PUBLIC_BASE_URL=https://api.fcmediaagent.com。
  **注意**：短信模板 SMS_512280223 是验证码模板，不能拿来发告警正文 ⇒ 告警通道用「日志 + webhook（可配企业微信/钉钉机器人 URL）」。

## 三、四个工作包与写作用域（互不重叠）

### WP1 备份与恢复（子 Agent A）
- 写：scripts/ops/backup-prod.sh、scripts/ops/restore-prod.sh、scripts/ops/oss-upload.mjs、ops/systemd/fcmediaagent-backup.service、ops/systemd/fcmediaagent-backup.timer、docs/handoff/P44-备份与恢复.md。
- 要求：
  - backup：从 /opt/fcmediaagent/app/.env 解析 DATABASE_URL（不打印密码）→ docker exec fcm-mysql mysqldump --single-transaction --quick --routines --events --databases fcmediaagent | gzip → /opt/fcmediaagent/backups/mysql/fcmediaagent-YYYYmmdd-HHMMSS.sql.gz + .sha256；保留 14 天（RETENTION_DAYS 可覆盖）；--dry-run 打印将执行的动作不发命令；失败非 0 退出并打印原因。
  - 可选 OSS：--oss 开关走 scripts/ops/oss-upload.mjs（用 ali-oss，从 /opt/fcmediaagent/app/node_modules 解析，secure:true，key backups/mysql/<file>），失败只 warn 不影响本地备份成功。
  - restore：restore-prod.sh <file.sql.gz> [--to-db fcm_restore_<ts>]；默认**只做演练**（导入临时库并打印表数量），--apply 才覆盖生产库且必须二次确认（读 stdin 输 YES）；导入前先做一次即时备份。
  - 两个脚本都必须 bash -n 通过，且在本机 Windows 只做语法/逻辑检查（不要真的执行 docker）。

### WP2 监控告警（子 Agent B）
- 写：scripts/ops/monitor.mjs、scripts/ops/monitor.config.example.json、ops/systemd/fcmediaagent-monitor.service、ops/systemd/fcmediaagent-monitor.timer、docs/handoff/P44-监控告警.md。
- 要求：Node 24 纯内置（fetch/child_process/fs），每 5 分钟跑一次，六项检查：
  1. http://127.0.0.1:3000/api/health 非 200 或 db 非 up；
  2. 队列积压：docker exec fcm-mysql mysql ... -N -B -e "select count(*) from EmployeeTask where status='queued' and createdAt < now() - interval 30 minute" > 阈值；
  3. worker 心跳：/opt/fcmediaagent/logs/worker.log mtime 超过 N 分钟（阈值可配）；
  4. 上游欠费：最近 200 行日志 grep AccountOverdueError；
  5. 磁盘 / 使用率 > 85%、内存可用 < 300MB；
  6. 备份新鲜度：/opt/fcmediaagent/backups/mysql 最新文件超过 26 小时。
  - 告警：写 /opt/fcmediaagent/logs/monitor.log（一行 JSON）+ 若 ALERT_WEBHOOK_URL 有值则 POST（企业微信/钉钉机器人通用 markdown 体）；同一告警去重（state 文件 /opt/fcmediaagent/monitor-state.json，冷却 60 分钟）；恢复时发一次「已恢复」。
  - --once 单跑、--dry-run 只打印不推送；配置从 monitor.config.json（可选）读阈值。

### WP3 日志轮转与系统配置件（子 Agent C）
- 写：ops/logrotate/fcmediaagent、ops/README.md、docs/handoff/P44-运维手册.md。
- 要求：logrotate 配置覆盖 /opt/fcmediaagent/logs/*.log，daily、rotate 14、compress、delaycompress、copytruncate（systemd 用 append 句柄，只能 copytruncate）、maxsize 100M、notifempty。
- ops/README.md：目录说明 + 生产安装步骤（逐条命令）。
- docs/handoff/P44-运维手册.md：部署/回滚（备份 dist 与 asar）、备份恢复、告警处置、常见故障（Prisma P1001、上游欠费、22 端口 refused、磁盘满、worker 不心跳）、admin 密码轮换、SSH 加固（改端口/密钥登录/fail2ban）checklist、清测试数据流程。

### WP4 lead 亲自做（生产执行）
- ssh 恢复后：安装 WP1/WP2/WP3 产物（systemd unit/timer、logrotate、脚本到 /opt/fcmediaagent/ops）→ 手工跑一次备份并校验 → 手工跑一次 monitor → 启 timer → 轮换 admin 密码（写回 .env + 重启 api + 验证登录）→ 测试数据 dry-run 报告 → 视风险执行清理 → 更新看板/文档/git。

## 四、纪律（所有子 Agent 必须遵守）

1. 只写自己 WP 列出的文件，不碰别人的、不改现有业务代码。
2. **不 ssh 生产、不执行 docker、不 git commit、不打包、不跑全量 verify**；允许 bash -n <脚本>、node --check <js>、node <脚本> --dry-run（本机无生产环境时必须优雅失败并打印「需要生产环境」）。
3. 不硬编码任何密钥/密码；从 /opt/fcmediaagent/app/.env 或环境变量读。
4. 脚本全部 UTF-8 无 BOM（sh 脚本 LF 行尾），带 set -euo pipefail，错误信息中文。
5. 完成后 send_message 给 lead，≤12 行摘要：文件清单 + 关键决定 + 未验证点。

## 五、验收（lead 复核）

- bash -n / node --check 全绿；
- 生产上：备份文件生成且 sha256 校验一致、恢复演练导入临时库行数合理、monitor --once 输出六项 OK、timer 已 enabled、logrotate -d 干跑无语法错；
- docs/handoff/P44-运维手册.md 覆盖四项操作；
- 看板新增 P44 任务并 done，git 推送。
