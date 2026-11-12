# ops/ — fcmediaagent 生产运维件（P44）

本目录存放**可直接部署到生产机**（Ubuntu，47.85.46.165）的运维脚本、systemd unit 与 logrotate 配置。
目标：备份可恢复、异常有告警、日志不撑爆磁盘、操作有手册。

- 生产根目录：`/opt/fcmediaagent`
- 应用目录：`/opt/fcmediaagent/app`（`dist/`、`.env`）
- 日志目录：`/opt/fcmediaagent/logs`（systemd `StandardOutput=append:` 写入，**journalctl 看不到**）
- 备份目录：`/opt/fcmediaagent/backups/mysql`、`/opt/fcmediaagent/backups/logs`
- 生产 Node：`/opt/node/bin/node`（非交互 ssh 没有 PATH，脚本内一律用绝对路径）

> 面向同事的完整操作说明见 [docs/handoff/P44-运维手册.md](../docs/handoff/P44-运维手册.md)。
> 备份/恢复细节见 `docs/handoff/P44-备份与恢复.md`，监控细节见 `docs/handoff/P44-监控告警.md`。

## 一、目录结构

```text
ops/
├── README.md                         # 本文件：目录说明 + 生产安装步骤
├── logrotate/
│   └── fcmediaagent                  # 安装到 /etc/logrotate.d/fcmediaagent
└── systemd/
    ├── fcmediaagent-backup.service   # 每日 MySQL 备份（oneshot，由 timer 触发）
    ├── fcmediaagent-backup.timer     # 备份定时器
    ├── fcmediaagent-monitor.service  # 六项巡检（oneshot，由 timer 触发）
    └── fcmediaagent-monitor.timer    # 每 5 分钟巡检

scripts/ops/                          # 脚本源文件（随仓库走，安装到 /opt/fcmediaagent/ops）
├── backup-prod.sh                    # MySQL 备份：mysqldump | gzip + sha256，保留 14 天，--dry-run/--oss
├── restore-prod.sh                   # 恢复/演练：默认导入临时库演练，--apply 才覆盖生产
├── oss-upload.mjs                    # 备份上传 OSS（ali-oss，失败不影响本地备份）
├── monitor.mjs                       # 六项监控 + webhook，--once/--dry-run/--config/--strict
└── monitor.config.example.json       # 监控阈值示例（复制为 monitor.config.json 后生效）
```

### 各文件用途

| 文件 | 生产位置 | 用途 |
| --- | --- | --- |
| `ops/logrotate/fcmediaagent` | `/etc/logrotate.d/fcmediaagent` | 轮转 `/opt/fcmediaagent/logs/*.log`：daily、rotate 14、compress、delaycompress、**copytruncate**、maxsize 100M、notifempty、missingok、su root root |
| `scripts/ops/backup-prod.sh` | `/opt/fcmediaagent/ops/backup-prod.sh` | 从 `app/.env` 读 `DATABASE_URL`（不打印密码）→ `docker exec fcm-mysql mysqldump ... | gzip` → `backups/mysql/fcmediaagent-<ts>.sql.gz` + `.sha256`；清理 14 天前旧备份；`--oss` 上传异地 |
| `scripts/ops/restore-prod.sh` | `/opt/fcmediaagent/ops/restore-prod.sh` | `restore-prod.sh <file.sql.gz> [--to-db fcm_restore_<ts>]`：默认只演练（导入临时库并打印表数量）；`--apply` 覆盖生产且需输入 `YES`，覆盖前自动再做一次即时备份 |
| `scripts/ops/oss-upload.mjs` | `/opt/fcmediaagent/ops/oss-upload.mjs` | 把备份文件传到 OSS 桶 `zhongke001` 的 `backups/mysql/`；从 `app/node_modules` 解析 ali-oss |
| `scripts/ops/monitor.mjs` | `/opt/fcmediaagent/ops/monitor.mjs` | 六项检查：API 健康、队列积压、worker 心跳、上游欠费、磁盘/内存、备份新鲜度；写 `logs/monitor.log`（一行 JSON）并推 webhook；`--dry-run` 不写不推 |
| `scripts/ops/monitor.config.example.json` | `/opt/fcmediaagent/ops/monitor.config.example.json` | 阈值示例；复制为同目录 `monitor.config.json` 才生效；不复制则用内置默认值 |
| `ops/systemd/*.service` `*.timer` | `/etc/systemd/system/` | 备份 / 巡检的 systemd 定时任务 |

## 二、生产安装步骤（首次，一次性）

> 以下命令在**本地仓库根**执行（Windows PowerShell 或 Git Bash 均可），通过 ssh 操作生产机。
> 前提：本地有 `~/.ssh/fcmediaagent_deploy`，生产安全组放行你的公网 IP 的 22 端口。
> 若出现 `ssh: connect to host 47.85.46.165 port 22: Connection refused`，**等 5–10 秒重试，最多 8 次**；
> 连续失败见手册 §6.3（先用阿里云控制台 VNC 登录）。

### 0. 本地预检：确认待安装文件齐全

```powershell
cd C:\Users\30290\Desktop\fcmediaagent-replica
Get-ChildItem scripts\ops, ops\systemd, ops\logrotate | Select-Object FullName, Length
```

本波最终应存在：`scripts/ops/` 下 5 个文件（`backup-prod.sh`、`restore-prod.sh`、`oss-upload.mjs`、`monitor.mjs`、`monitor.config.example.json`）+
`ops/systemd/` 下 4 个 unit。**缺文件说明对应工作包未完成，先不要安装。**

### 1. 生产建目录

```bash
ssh -i ~/.ssh/fcmediaagent_deploy root@47.85.46.165 \
  'mkdir -p /opt/fcmediaagent/ops /opt/fcmediaagent/backups/mysql /opt/fcmediaagent/backups/logs && \
   chmod 700 /opt/fcmediaagent/backups /opt/fcmediaagent/backups/mysql /opt/fcmediaagent/backups/logs && \
   ls -ld /opt/fcmediaagent/ops /opt/fcmediaagent/backups/mysql /opt/fcmediaagent/backups/logs'
```

### 2. 拷脚本到 `/opt/fcmediaagent/ops`

```bash
scp -i ~/.ssh/fcmediaagent_deploy \
  scripts/ops/backup-prod.sh \
  scripts/ops/restore-prod.sh \
  scripts/ops/oss-upload.mjs \
  scripts/ops/monitor.mjs \
  scripts/ops/monitor.config.example.json \
  root@47.85.46.165:/opt/fcmediaagent/ops/
```

### 3. 拷 systemd unit 到 `/etc/systemd/system`

```bash
scp -i ~/.ssh/fcmediaagent_deploy \
  ops/systemd/fcmediaagent-backup.service \
  ops/systemd/fcmediaagent-backup.timer \
  ops/systemd/fcmediaagent-monitor.service \
  ops/systemd/fcmediaagent-monitor.timer \
  root@47.85.46.165:/etc/systemd/system/
```

### 4. 设权限

```bash
ssh -i ~/.ssh/fcmediaagent_deploy root@47.85.46.165 \
  'chown -R root:root /opt/fcmediaagent/ops /etc/systemd/system/fcmediaagent-*.service /etc/systemd/system/fcmediaagent-*.timer && \
   chmod 755 /opt/fcmediaagent/ops && \
   chmod +x /opt/fcmediaagent/ops/backup-prod.sh /opt/fcmediaagent/ops/restore-prod.sh && \
   chmod 644 /opt/fcmediaagent/ops/oss-upload.mjs /opt/fcmediaagent/ops/monitor.mjs /opt/fcmediaagent/ops/monitor.config.example.json && \
   chmod 644 /etc/systemd/system/fcmediaagent-*.service /etc/systemd/system/fcmediaagent-*.timer && \
   ls -l /opt/fcmediaagent/ops'
```

### 5. 配置告警 webhook（可选，但强烈建议）

企业微信/钉钉群机器人地址放独立文件，**不要写进仓库、不要混进 `app/.env`**：

```bash
ssh -i ~/.ssh/fcmediaagent_deploy root@47.85.46.165 \
  'umask 077; printf "%s\n" \
     "# fcmediaagent 监控告警 webhook（企业微信或钉钉机器人）" \
     "ALERT_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=把真实key贴这里" \
     > /etc/default/fcmediaagent-monitor && \
   chmod 600 /etc/default/fcmediaagent-monitor && ls -l /etc/default/fcmediaagent-monitor'
```

不配置也能装：告警只写 `/opt/fcmediaagent/logs/monitor.log`，不推送。后补配置不需要重启 timer——service 每次启动都会重新读该文件，下一次触发即生效。

### 6. 监控阈值（可选）

默认值已按生产调好（队列积压 >20 条、worker 日志 10 分钟未更新、磁盘 >85%、可用内存 <300MB、备份 >26 小时）。
要改阈值：

```bash
ssh -i ~/.ssh/fcmediaagent_deploy root@47.85.46.165 \
  'cp /opt/fcmediaagent/ops/monitor.config.example.json /opt/fcmediaagent/ops/monitor.config.json && \
   chmod 644 /opt/fcmediaagent/ops/monitor.config.json && \
   vi /opt/fcmediaagent/ops/monitor.config.json'
```

改完**不需要重启 timer**，下一次运行即生效。注意 JSON 不能有注释/尾逗号（示例里的 `_readme`、`_doc` 是合法键，脚本会忽略）。

### 7. 启用 systemd 定时器

```bash
ssh -i ~/.ssh/fcmediaagent_deploy root@47.85.46.165 \
  'systemctl daemon-reload && \
   systemctl enable --now fcmediaagent-backup.timer fcmediaagent-monitor.timer && \
   systemctl list-timers --all | grep -E "fcmediaagent-(backup|monitor)"'
```

### 8. 安装 logrotate 并干跑

```bash
scp -i ~/.ssh/fcmediaagent_deploy ops/logrotate/fcmediaagent root@47.85.46.165:/etc/logrotate.d/fcmediaagent
```

```bash
ssh -i ~/.ssh/fcmediaagent_deploy root@47.85.46.165 \
  'chown root:root /etc/logrotate.d/fcmediaagent && \
   chmod 644 /etc/logrotate.d/fcmediaagent && \
   logrotate -d /etc/logrotate.d/fcmediaagent'
```

干跑成功标志：输出中能看到 `considering log /opt/fcmediaagent/logs/api.log` / `worker.log`，且**没有 `error:`**。
退出码 0 即语法与权限 OK（`-d` 只打印，不实际轮转）。

随后确认系统定时器在跑（Ubuntu 自带，不需要自己加 cron）：

```bash
ssh -i ~/.ssh/fcmediaagent_deploy root@47.85.46.165 \
  'systemctl status logrotate.timer --no-pager | head -5; \
   ls -lh /opt/fcmediaagent/logs/'
```

### 9. 手工验证（安装后立刻做一遍）

```bash
# 9.1 备份：先空跑看计划，再真跑一次
ssh -i ~/.ssh/fcmediaagent_deploy root@47.85.46.165 \
  '/opt/fcmediaagent/ops/backup-prod.sh --dry-run && /opt/fcmediaagent/ops/backup-prod.sh'

# 9.2 校验 sha256（输出 OK 才算成功）
ssh -i ~/.ssh/fcmediaagent_deploy root@47.85.46.165 \
  'cd /opt/fcmediaagent/backups/mysql && sha256sum -c $(ls -t *.sql.gz.sha256 | head -1)'

# 9.3 监控：先空跑，再单跑一次，看六项结果
ssh -i ~/.ssh/fcmediaagent_deploy root@47.85.46.165 \
  '/opt/node/bin/node /opt/fcmediaagent/ops/monitor.mjs --dry-run && \
   /opt/node/bin/node /opt/fcmediaagent/ops/monitor.mjs --once && \
   tail -n 6 /opt/fcmediaagent/logs/monitor.log'

# 9.4 恢复演练（默认只导入临时库，不碰生产库）
ssh -i ~/.ssh/fcmediaagent_deploy root@47.85.46.165 \
  '/opt/fcmediaagent/ops/restore-prod.sh $(ls -t /opt/fcmediaagent/backups/mysql/*.sql.gz | head -1)'
```

> 9.4 演练会创建一个 `fcm_restore_<时间戳>` 临时库，打印表数量后由脚本清理（或按提示手工 drop）。
> **不要**随手加 `--apply`：那会覆盖生产库，必须先读手册 §4。

## 三、日常检查

```bash
# 定时器是否在跑（下次触发时间）
systemctl list-timers --all | grep -E 'fcmediaagent-(backup|monitor)'

# 最近一次备份 / 监控的结果
systemctl status fcmediaagent-backup.service --no-pager -l | tail -20
systemctl status fcmediaagent-monitor.service --no-pager -l | tail -20
tail -n 20 /opt/fcmediaagent/logs/backup.log
tail -n 20 /opt/fcmediaagent/logs/monitor.log
ls -lh /opt/fcmediaagent/backups/mysql | tail -5
```

## 四、升级与卸载

升级（脚本有改动时）：

```bash
# 重新执行第 2、3 步 scp，然后：
ssh -i ~/.ssh/fcmediaagent_deploy root@47.85.46.165 \
  'chmod +x /opt/fcmediaagent/ops/*.sh && systemctl daemon-reload && \
   systemctl restart fcmediaagent-backup.timer fcmediaagent-monitor.timer'
```

只改 logrotate 时：重新执行第 8 步的 scp 与 `logrotate -d`。

卸载（保留备份数据，不删 `backups/`）：

```bash
ssh -i ~/.ssh/fcmediaagent_deploy root@47.85.46.165 \
  'systemctl disable --now fcmediaagent-backup.timer fcmediaagent-monitor.timer && \
   rm -f /etc/systemd/system/fcmediaagent-backup.service /etc/systemd/system/fcmediaagent-backup.timer \
         /etc/systemd/system/fcmediaagent-monitor.service /etc/systemd/system/fcmediaagent-monitor.timer \
         /etc/logrotate.d/fcmediaagent && \
   systemctl daemon-reload && systemctl reset-failed || true'
```

## 五、安全与约定

- 本目录**不放任何密钥/密码**：数据库密码来自 `app/.env`，webhook 来自 `/etc/default/fcmediaagent-monitor`（600）。
- 所有脚本用绝对路径 `/opt/node/bin/node`，不要依赖交互式 PATH。
- `backups/` 只允许 root 读写（700）；备份文件名含时间戳，恢复时按时间选。
- 日志轮转必须保持 `copytruncate`：systemd `StandardOutput=append` 持有 fd，改成 rename 会导致磁盘不释放（原因见配置顶部注释）。
- 生产操作遇到 ssh `Connection refused` 不要反复狂点：间隔 5–10 秒重试，最多 8 次；仍失败走阿里云控制台 VNC（手册 §6.3）。
