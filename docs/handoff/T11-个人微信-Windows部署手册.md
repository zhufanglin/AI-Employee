# T-11 个人微信网桥 —— Windows 部署手册（家里/办公室常开机器）

> 版本 2026-11-06 · 作者 dsh-lead · 状态：链路已在本机端到端验证通过（生产 ↔ 家机隧道 ↔ 网桥）

## 0. 一句话原理

家机跑一个本地 HTTP 网桥（Python + wxauto 驱动微信 PC 客户端），再用 **SSH 反向隧道**把网桥映射到生产机
`127.0.0.1:8600`。生产服务端通过 `WECHAT_UIA_BASE_URL=http://127.0.0.1:8600` 调它，**不需要开任何入站端口、
不需要改阿里云安全组、不需要 WireGuard/frp**。

```
[家机 Windows]                         [生产 47.85.46.165]
微信 3.9.x  ←UIAutomation← 网桥 :8600  ← SSH -R 127.0.0.1:8600 ← ssh wxbridge@…  (家机主动外连 22)
                                          ↑
                                 fcmediaagent-api 读 WECHAT_UIA_BASE_URL
```

## 1. 家机安装（一条命令）

前提：Windows 10/11、**微信 PC 版 3.9.x**（不要 4.x，wxauto 不支持）、Python 3.11+（没有会提示怎么装）。

在**家机**上打开 PowerShell（不用管理员），粘贴执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -UseBasicParsing https://updates.fcmediaagent.com/bridge/setup-windows.ps1 -OutFile $env:TEMP\setup-win.ps1; & $env:TEMP\setup-win.ps1"
```

它会自动：体检系统/微信/Python → 下载网桥 → 装依赖 → 生成 SSH 隧道密钥 → 写配置 → Python 自检 →
放进「启动」文件夹开机自启 → 立刻拉起看护进程。

**跑完把最后打印的两块内容发给我**：
1. `SSH 公钥`（形如 `ssh-ed25519 AAAA… wxbridge@机器名`）—— 我加到生产机白名单
2. `网桥 Token`（32 位 hex）—— 我写到生产 `.env`

之后我这边验证隧道 + 网桥，通了就算接入完成。

## 1.5 微信 PC 版本（2026-11-06 实测，**结论已更新：只能走 4.x + wxauto4**）

> **最终结论（先看这段）**：微信 3.9.x 已被腾讯**停止登录**（扫码即提示「显示当前微信版本过低，请更换其他版本」），
> 所以 3.9 路线彻底作废；只能用已装的 **微信 4.1.15.56 + wxauto4**，而 wxauto4 要求 **Python 3.12（<3.14）**。
> 下面的 3.9 下载/安装记录保留为排查历史。

### 4.x 路线（现用）
- 微信：`C:\Program Files\Tencent\Weixin\Weixin.exe`（4.1.15.56），用**专用小号**扫码登录。
- 库：`pip install wxauto4==40.1.1`（需 Python 3.12；本机 `%LOCALAPPDATA%\Programs\Python\Python312\python.exe`）。
- API 差异：`SendMsg(msg, who=)`、`SendFiles(path, who=)`、`GetAllMessage()`、`ChatWith()`、`GetSession()`；
  监听是**回调式** `AddListenChat(nickname, callback)`（没有 GetListenMessage）；**没有 GetSessionList / GetMyInfo**。
- wxauto4 找主窗口：win32 类名 `Qt51514QWindowIcon` → UIA `ClassName == 'mmui::MainWindow'` 才算登录成功；
  **未登录时该窗口 UIA ClassName 仍是 `Qt51514QWindowIcon`，会报 `未找到微信窗口：None`（这是「没登录」不是「版本不兼容」）**。
- 自检：
  ```powershell
  & "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" -c "from wxauto4 import WeChat; w=WeChat(); print('OK', w.nickname)"
  # 期望：初始化成功，获取到已登录窗口：<昵称>  →  OK <昵称>
  ```

### 3.9 路线（已作废，仅留档）

wxauto **只支持微信 3.9.x**，4.x 完全不行。若机器上装的是 4.x（`C:\Program Files\Tencent\Weixin\Weixin.exe`），
必须另装 3.9.x —— 两者目录不同，可以共存，不影响现有 4.x。

**官方下载地址仍然有效（不是第三方镜像）**：

```
https://dldir1.qq.com/weixin/Windows/WeChatSetup.exe
```

实测（2026-11-06）：283,125,176 B，Authenticode 签名有效（CN=Tencent Technology (Shenzhen) Company Limited），
sha256 `C29FC05630CFC95EF6483F6B5B52AABFE74265BB260E210E78AE437D305D8990`，
静默安装 `WeChatSetup.exe /S`（非管理员身份会弹一次 UAC，约 60 秒）→
`C:\Program Files\Tencent\WeChat\WeChat.exe` 版本 **3.9.12.1000**。

装完手动启动它（`C:\Program Files\Tencent\WeChat\WeChat.exe`，注意不是 4.x 的 Weixin.exe），
用**专用小号**扫码登录。登录后：

```powershell
# 网桥应该立刻能看到登录状态
$h=@{Authorization='Bearer <你的 Token>'}
(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8600/api/v1/bot/status' -Headers $h).Content
# {"ok":true,"logged_in":true,"nickname":"…","wxid":"…","wechat_version":"3.9.12.1000",…}
```

> **实测结果：3.9.12.1000 启动后扫码会提示「显示当前微信版本过低，请更换其他版本」，登录不了。** 该路线作废，改走上面的 4.x + wxauto4。
> 另外：不要用主力号做自动化（风控红线：日发 ≤200、禁同文群发、随机延迟）。

## 2. 家机必须一直「保持桌面」

微信 UIAutomation 要有交互式桌面，RDP 一断开就取不到控件树：

| 要求 | 做法 |
|---|---|
| 自动登录 | `netplwiz` → 取消「要使用本计算机，用户必须输入用户名和密码」 |
| 不睡眠/不休眠 | 电源选项：接通电源时「从不」睡眠、从不休眠、从不关闭硬盘 |
| 关自动更新重启 | 设置 → Windows 更新 → 活动时间拉满；组策略/服务把 `wuauserv` 设为手动 |
| RDP 退出不锁桌面 | 每次断开前在 RDP 会话里执行 `tscon %sessionname% /dest:console`（或用 `tscon` 快捷脚本） |
| 微信锁版本 | 微信设置里关自动更新；锁在 4.1.15.56（wxauto4 适配的就是 4.x；3.9 分支已无法登录） |
| 不要跑成服务 | 看护进程用**「启动」文件夹（登录时触发）**，不要用 NSSM/「不管用户是否登录」——那会进 Session 0，没有桌面 |

## 3. 生产机侧（我已配好，留档）

```bash
# 专用隧道账号，不能登录 shell、只能做一条反向转发
useradd -m -s /usr/sbin/nologin wxbridge
# /home/wxbridge/.ssh/authorized_keys 每行形如：
# restrict,port-forwarding,permitlisten="127.0.0.1:8600" ssh-ed25519 AAAA… wxbridge@家机名

# /etc/ssh/sshd_config.d/60-wxbridge.conf
ClientAliveInterval 30
ClientAliveCountMax 3
Match User wxbridge
    AllowTcpForwarding remote
    PermitListen 127.0.0.1:8600
    PermitOpen none
    X11Forwarding no
    AllowAgentForwarding no
    PermitTTY no
    MaxSessions 2

# /opt/fcmediaagent/app/.env
WECHAT_UIA_BASE_URL=http://127.0.0.1:8600
WECHAT_UIA_TOKEN=<网桥 Token>
```

## 4. 日常运维（家机）

```powershell
# 看状态（进程 / 8600 / healthz / 配置脱敏 / 最近日志）
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\FCMediaAgent\wechat-bridge\app\scripts\status.ps1"

# 手动重启看护进程
Get-Process powershell | Where-Object { $_.Path -and (Get-Content "$env:LOCALAPPDATA\FCMediaAgent\wechat-bridge\supervisor.pid") -contains $_.Id } | Stop-Process -Force
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$env:LOCALAPPDATA\FCMediaAgent\wechat-bridge\app\scripts\supervisor.ps1"

# 日志
$env:LOCALAPPDATA\FCMediaAgent\wechat-bridge\supervisor.log
$env:LOCALAPPDATA\FCMediaAgent\wechat-bridge\bridge.err.log
$env:LOCALAPPDATA\FCMediaAgent\wechat-bridge\tunnel.err.log
```

看护进程：每 5 秒巡检，网桥端口不通就重启网桥（45 秒内等就绪）、ssh 掉了就 10 秒退避重连；
单实例守卫（`supervisor.pid`）避免开机自启 + 手动启动跑出两份。

## 5. 生产侧验收命令

```bash
ss -lntp | grep :8600                                   # 应有 sshd 监听 127.0.0.1:8600
curl -s http://127.0.0.1:8600/healthz                    # ok
curl -s -H "Authorization: Bearer <token>" http://127.0.0.1:8600/api/v1/bot/status
# {"ok":true,"logged_in":true,"nickname":"…","wxid":"…","wechat_version":"3.9.x.x","mock":false,…}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8600/api/v1/bot/status   # 401（无 token）
```

网桥业务接口（服务端 `channels/personal-wechat/*` 转发的就是这 6 个）：
`GET /api/v1/bot/status`、`GET /api/v1/memory/list`、`GET /api/v1/chat/messages`、
`POST /api/v1/chat/send`、`POST /api/v1/chat/send-file`、`POST /api/v1/chat/listen-list`。

## 6. 排查对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| `Bad remote forwarding specification '127.0.0.1:.0.0.1:8600'` | PowerShell 双引号里 `$port:127` 被当成作用域变量 | 已改为 `-f` 格式化构造转发表述（脚本 v2 起） |
| `remote port forwarding failed for listen port 8600` | 生产侧已有残留 sshd 会话占着 8600 | `ss -lntp \| grep :8600` 找 pid → `kill -9`；或等 `ClientAlive` 90 秒回收 |
| `Connection … closed by remote host` 频繁 | 网络抖动/服务端重启 | 看护进程自动重连；持续检查家机出口网络 |
| `{"ok":true,"logged_in":false}` | 微信没登录/版本不对/桌面没渲染 | 家机上确认微信已登录且桌面可见（`tscon` 回控制台） |
| PowerShell 报「字符串缺少终止符」 | 脚本存成无 BOM 的 UTF-8，PS 5.1 按 GBK 读中文吃掉了引号 | 脚本一律 UTF-8 **带 BOM** 保存 |
| `python -m wechat_bridge.selftest` 找不到模块 | 没在网桥目录里跑 | `cd %LOCALAPPDATA%\FCMediaAgent\wechat-bridge\app` 再跑 |
| `Could not find a version that satisfies the requirement httptools>=0.8.0` | `uvicorn[standard]` 会拉 httptools/uvloop（C 扩展），你的 Python 版本/位数没有预编译包 | 2026-11-06 已改为纯 `uvicorn==0.54.0`（网桥不需要加速件），重跑脚本即可；若 pydantic 也装不上就换 `winget install -e --id Python.Python.3.12` |
| 手机号/账号风控 | 单号日发过多、同文群发、频率固定 | 单号日发 ≤200、多账号分摊、随机延迟（网桥已内置 humanize 0.3–1.2s） |

## 7. 产物与脚本位置

| 位置 | 说明 |
|---|---|
| `https://updates.fcmediaagent.com/bridge/setup-windows.ps1` | 家机一键安装脚本（公开发布，无密钥） |
| `https://updates.fcmediaagent.com/bridge/wechat-bridge.zip` | 网桥源码包（含 `scripts/`） |
| `packages/wechat-bridge/scripts/setup-windows.ps1` | 源（改完要重新打包上传，见 `scripts/publish-update.mjs` 同类流程） |
| `packages/wechat-bridge/scripts/supervisor.ps1` | 看护进程（网桥 + 隧道双保活） |
| `packages/wechat-bridge/scripts/status.ps1` | 家机自检 |
| `packages/wechat-bridge/scripts/FCMediaBridge.vbs` | 启动文件夹里的静默启动器 |
| `docs/handoff/T11-个人微信网桥.md` | 网桥本身（HTTP 契约、真机验收步骤） |
| `docs/handoff/T11-个人微信-云上部署Runbook.md` | 为什么不能用云服务器跑（无 KVM / 美国 IP 风控）与备选方案 |

## 8. 本机验证记录（2026-11-06 15:1x）

在本开发机上跑同一份一键脚本（`-SkipDeps`，因为本机已有依赖）→ 网桥起在 127.0.0.1:8600 →
隧道连上生产 → 生产侧：
```
$ curl -s -H 'Authorization: Bearer ***' http://127.0.0.1:8600/api/v1/bot/status
{"ok":true,"logged_in":false,"nickname":null,"wxid":null,"wechat_version":null,"mock":false,"uptime_s":349.1}
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8600/api/v1/bot/status
401
```
`logged_in:false` 是因为本机没装微信；脚本其余环节（下载/解压/密钥/配置/自检/自启/看护/隧道/鉴权）全部跑通。

## 9. 2026-11-07 落地记录（wxauto4 41.1.7 + 全新一键脚本实测）

### 9.1 现在的一键安装（家机照抄即可）
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -UseBasicParsing https://updates.fcmediaagent.com/bridge/setup-windows.ps1 -OutFile $env:TEMP\setup-win.ps1; & $env:TEMP\setup-win.ps1"
```
脚本 8 步：体检（强制 Python **3.12** + 微信 4.x）→ 建 venv → 下载解压网桥 → 装依赖 + `wxauto4==41.1.7` → 生成 SSH 隧道密钥 → 写 `bridge.env` → venv 跑 selftest → 加启动项并拉起看护进程。

安装完成后脚本会打印两块内容：**SSH 公钥**（要加进生产 `/home/wxbridge/.ssh/authorized_keys`）和 **网桥 Token**（要写进生产 `.env` 的 `WECHAT_UIA_TOKEN`）。

### 9.2 本机（= 家机）2026-11-07 00:17 实跑结果：8/8 全绿
- `venv`：`%LOCALAPPDATA%\FCMediaAgent\wechat-bridge\venv`（Python 3.12.10 64bit），已装 fastapi 0.143.0 / uvicorn 0.54.0 / pydantic 2.14.0 / **wxauto4 41.1.7**（cp312 编译版，只能在 3.12 跑）。
- selftest **30 项全 PASS**（wxauto4 桩 9 项 + HTTP 契约/mock 21 项），末行 `SELFTEST OK`。
- 网桥 `127.0.0.1:8600` 监听；看护进程 `supervisor.ps1` 用 venv python 拉起网桥 + ssh 反向隧道；生产侧 `ss -lntp | grep 8600` 显示 `127.0.0.1:8600` 由 sshd 监听。
- 生产 `.env` 已写入本次生成的 `WECHAT_UIA_TOKEN`（旧的本机测试 token 作废），重启 api 后 `health=200`。

### 9.3 端到端链路验证（生产 → 隧道 → 网桥 → wxauto4）
新脚本 `scripts/smoke-t11-personal-wechat.mjs`（生产上以 `/opt/fcmediaagent/smoke-t11-personal-wechat.mjs` 运行）：
```bash
cd /opt/fcmediaagent && FCM_API=http://127.0.0.1:3000/api FCM_PHONE=13900139000 /opt/node/bin/node smoke-t11-personal-wechat.mjs
```
2026-11-07 00:2x 结果：
```
[PASS] 登录成功 -> {"phone":"13900139000"}
[PASS] 未带 JWT 访问 status 返回 401
[PASS] 带 JWT 访问 status 返回网桥状态 -> {"ok":true,"logged_in":false,...,"wechat_version":"4.1.15.56","backend":"wxauto4","uptime_s":109.156}
[PASS] 已连上家里网桥（返回体含后端/ok 字段）
[FAIL] 微信尚未登录（请用专用小号在 4.x 上登录并保持主窗口打开）
```
即：**API → SSH 隧道 → 网桥 → wxauto4 全链路已通，唯一缺口是微信本体没登录。**
登录后重跑该脚本，`logged_in` 变 `true`、昵称/wxid 可见，即代表个人微信渠道可用。

### 9.4 三个必须注意的点
1. **微信不能是 3.9.x**：3.9 分支已被腾讯停登（扫码提示"显示当前微信版本过低"），网桥只能用 4.1.x + `wxauto4==41.1.7`。
2. **python 必须是 3.12**：wxauto4 41.x 的 wheel 是 `cp312-win_amd64` 编译版，3.13/3.14 都装不上/跑不了。
3. **旧实例会抢 8600**：如果之前手工起过网桥，先确认 `Get-NetTCPConnection -LocalPort 8600 -State Listen` 的 pid 是 venv 那个进程；旧进程占端口会让新网桥起不来，看护进程却误判"就绪"。
4. 手工改完 `bridge.env` 后要重启看护进程（`supervisor.pid` 里的 pid 杀掉，再双击启动项里的 `FCMediaBridge.vbs` 或直接跑 `supervisor.ps1`）。

### 9.5 发布产物（已上传，公网 200）
| 文件 | 大小 | sha256 |
|---|---|---|
| `/opt/fcmediaagent/updates/bridge/wechat-bridge.zip` | 57,783B | `2ae3e4d1260a0a53a12cad1f903c367ad34f087974e35e0f783ed3f2956423f3` |
| `/opt/fcmediaagent/updates/bridge/setup-windows.ps1` | 11,130B | `6507686162bc3f8839cf1853c4fa362a3a64a7b3303fe0f880e10ace6ce8b931` |

---

## 10. 2026-11-07 收尾：驱动换成 wechatauto，出站链路生产验证通过

### 10.1 结论先行
- **wxauto4 免费版只支持到微信 4.1.8.107**（官方文档），本机微信是 **4.1.15.56**，用 wxauto4 一定报
  `未找到已登录的客户端主窗口`（根因是版本不兼容，不是没登录）。
- 现在驱动改为 **wechatauto-replica 1.2.9**（GUI + OCR，不依赖 UIA），在本机 4.1.15.56 上实测可用：
  `bot/status` → `{"ok":true,"logged_in":true,"nickname":"stu","wechat_version":"4.1.15.56","backend":"wechatauto"}`。
- 两者都在 `setup-windows.ps1` 里安装：先装 wechatauto-replica（首选），装不上再装 wxauto4（回退，仅 ≤4.1.8.107 有效）。

### 10.2 生产出站链路验证（7/7 PASS）
在服务器上跑：
```bash
cd /opt/fcmediaagent && FCM_API=http://127.0.0.1:3000/api FCM_PHONE=13900139000 /opt/node/bin/node smoke-t11-personal-wechat.mjs
```
2026-11-07 01:30 结果（末行 **T11 PERSONAL WECHAT SMOKE OK (7 checks)**）：
```
[PASS] 带 JWT 访问 status 返回网桥状态 -> {"ok":true,"logged_in":true,"nickname":"stu","wechat_version":"4.1.15.56","backend":"wechatauto"}
[PASS] 向微信会话发送测试消息（出站链路） -> {"ok":true,"name":"文件传输助手","sent_at":1793986217}
[PASS] 消息已出现在该会话消息流中（读回校验） -> {"total":10,"last":{"id":"10","from":"我","text":"[T-11 出站自测] 2026-11-06T17:30:15.267Z","type":"text"}}
```
即「平台 API → SSH 反向隧道 → 家机网桥 → 微信真实发出」这一段已在生产打通。

### 10.3 入站自动接管（新功能，2026-11-07）
以前服务端只做「代理转发」，没有入站：现在新增 `PersonalWeChatPoller`。

链路：微信收到好友消息 → 网桥 `GET /api/v1/chat/messages` → 轮询器过滤（跳过"我/系统"、游标+id 去重）
→ `ChannelDispatcherService.handleInbound` → 建 AI 员工云端任务 → 5 秒内先回 ACK
→ 任务完成/失败/需补充时把结果回推同一会话（单条截 1500 字）。

生产 `.env`（`/opt/fcmediaagent/app/.env`）相关项：
```ini
WECHAT_UIA_BASE_URL=http://127.0.0.1:8600     # 家机反向隧道
WECHAT_UIA_TOKEN=<家机 bridge.env 里的 WECHAT_BRIDGE_TOKEN>
WECHAT_PERSONAL_CHATS=                         # 要接管的会话名，逗号分隔；空=不自动接管
WECHAT_PERSONAL_POLL_MS=20000                  # 轮询间隔，最小 5000
CHANNEL_OWNER_USER_ID=cmw3teyyy002frzrh86vtu3pr # 渠道消息归属的平台账号（不填只回"已收到"不建任务）
CHANNEL_EMPLOYEE_SLUG=boss-lead-radar          # 默认员工
```
改完 `systemctl restart fcmediaagent-api`，日志出现
`个人微信自动接管已启用：chats=... pollMs=20000` 即生效。

**使用边界（第一版）**：只处理文字消息（图片/文件只回一句提示）、只处理 `WECHAT_PERSONAL_CHATS` 里的会话、
重启期间的消息会漏（游标从启动时刻开始）、群聊同样会被接管（所以别把大群加进来）。

### 10.4 自测步骤（推荐用它验收）
1. 用专用小号登录微信 4.1.x，保持主窗口可见（不要最小化，最小化时 GUI 自动化抓不到渲染）。
2. 服务器 `.env` 里把 `WECHAT_PERSONAL_CHATS` 设成「会用另一个微信给这个号发消息」的会话名。
3. 用**另一个微信账号**（或让同事）给这个号发一句「帮我看看今天 AI 行业有什么新政策」。
4. 期望：5 秒内收到「已收到，正在处理，稍后把结果发给你」；1–3 分钟后收到员工任务的完整结果。
5. 服务器日志：`grep -E '个人微信|渠道任务' journalctl -u fcmediaagent-api`。

### 10.5 产物更新（2026-11-07，已上传，公网 200）
| 文件 | 大小 | sha256 |
|---|---|---|
| `/opt/fcmediaagent/updates/bridge/wechat-bridge.zip` | 60,380B | `d2d2385a2a821145241f7afae5e270a86e0f8bb73b4a13da6fd38a6ae9b6ab92` |
| `/opt/fcmediaagent/updates/bridge/setup-windows.ps1` | 12,951B | `0ba8e8cba731ea8119c2fff38b5166e1b0cdae7d371f38d0b5fb652fa7212159` |

> 注意 9.4 第 1 条已过时：不是"只能用 wxauto4"，而是"wxauto4 只到 4.1.8.107；4.1.15 用 wechatauto-replica"。

一条命令安装（家机，PowerShell）：
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -UseBasicParsing https://updates.fcmediaagent.com/bridge/setup-windows.ps1 -OutFile $env:TEMP\setup-win.ps1; & $env:TEMP\setup-win.ps1"
```


### 10.6 结果回推修复 + 生产全链路验收（2026-11-07 01:48 UTC+8）

**问题**：云执行器的任务终态是 `awaiting_approval`（等后台确认），原 `dispatcher.pollTask()` 对这个状态只推一句
「任务需要你补充信息或在后台确认，请登录平台后台处理。」——微信用户拿不到后台，等于看不到结果。

**修复**（`packages/server/src/channels/dispatcher.service.ts`）：
- 新增私有方法 `readTaskText(taskId, task)`：先取 `task.outputText`，为空再取该任务第一个 `EmployeeTaskArtifact.text`。
- `succeeded` 分支改用该方法；`needs_input` / `awaiting_approval` 分支改为：**有产出就把产出文本推回微信**（`needs_input` 追加「还需要你补充信息才能继续，直接回复补充内容即可」，`awaiting_approval` 追加「以上为初稿，确认归档请登录平台后台」），只有无产出时才回落原提示语。
- 新增单测 `scripts/smoke-t11-channel-push.mjs`（假 prisma / 假员工服务 / 假渠道发送器，5 个场景 15 项断言）：
  succeeded、awaiting_approval 带产出、awaiting_approval 无产出、failed、outputText 空回落 artifact。
  已并入 `scripts/verify.ps1` 的 `Step "smoke: T-11 渠道结果回推"`。

**生产验收（47.85.46.165，2026-11-06T17:48Z）**：
1. 部署 `dist/channels/dispatcher.service.{js,map,d.ts}` → `systemctl restart fcmediaagent-api` → active、`/api/health`=200。
2. 通过网桥向「文件传输助手」发「【回推自测】用三句话说明社区团购的选品思路，不要联网。」（17:48:26Z）。
3. 日志序列：`渠道任务已创建 task=cmw59q4vi0002rz243yo2myed`（17:48:31Z）→ `个人微信入站已处理 msgId=16 chars=27`（17:48:33Z）→ `渠道结果已推送`（17:48:58Z），任务终态 `awaiting_approval`、`outputText` 297 字符。
4. 微信里实际收到的三条消息：原始提问 → 「已收到，正在处理，稍后把结果发给你」→ **完整的三点选品思路 + 「（以上为初稿，确认归档请登录平台后台）」**。
   ⇒ 「微信 → 网桥 → 服务端 → 云执行器 → 结果回推微信」全链路闭环，且推的是真实结果文本。

**自测模式说明**：`WECHAT_PERSONAL_ALLOW_SELF=1` 只在只有一个微信号自测时打开（桌面端看到的消息 from 都是「我」）。
它会处理「我」发的消息，并靠 `PersonalWeChatOwnTexts`（每会话最近 50 条）排除我们自己推送的文本，避免自问自答。
接真实客户会话时应设回 0（客户发的消息 from 是对方昵称，不需要该开关）。

**已清理**：`scripts/tmp-trigger-inbound.mjs`、`scripts/tmp-trigger-inbound2.mjs` 已删除。
