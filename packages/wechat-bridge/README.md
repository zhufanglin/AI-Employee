# 个人微信固定窗口环境 · 本地网桥（wechat-bridge）

本目录是 FCMediaAgent 个人微信渠道的**本地网桥**：运行在装有 Windows 微信 PC 客户端的机器上，把「读会话 / 读消息 / 发文本 / 发文件 / 注册监听」封装成稳定的 HTTP 接口，供上游 `packages/server/src/channels/personal-wechat.service.ts` 调用。

- 技术栈：**Python 3.12**（wxauto4 编译版要求）、FastAPI、uvicorn、**wxauto4 41.1.7**（微信 4.1.x 真实模式）。
- 默认地址：`http://127.0.0.1:18990`。
> ⚠️ **版本现状（2026-11-07 起，以本节为准，下文旧段落保留作历史参考）**
> - 微信 **3.9.x 分支已被腾讯停登**（扫码直接提示"显示当前微信版本过低"）⇒ 真实模式**只能走微信 4.1.x + `wxauto4`**。
> - `wxauto4` 的版本号跟微信版本走：`40.1.x` 配微信 4.0.x、**`41.1.7` 配微信 4.1.x**（本仓库锁定 `wxauto4==41.1.7`）。
> - `wxauto4==41.1.7` 的发行包是 `cp312-win_amd64` **编译版**，**只能在 Python 3.12** 上安装运行（3.13/3.14 不行）。
> - 部署用 `scripts/setup-windows.ps1` 一键装（自动建 venv、装 `wxauto4==41.1.7`、生成隧道密钥、写 `bridge.env`、跑 selftest、加开机自启）；家机部署步骤见 `docs/handoff/T11-个人微信-Windows部署手册.md`。
> - 运行 `python -m wechat_bridge.selftest` 会同时跑 wxauto4 桩（9 项）与 HTTP/mock 契约（21 项），共 30 项，末行 `SELFTEST OK`。
> - 微信未登录时网桥仍然可用：`bot/status` 返回 `logged_in:false`、`backend:"wxauto4"`，业务接口返回 503 `WECHAT_NOT_LOGGED_IN`。

- 默认只监听回环地址，不暴露公网。
- 所有代码注释、日志和文档均为中文。

> 重要：本仓库开发机没有安装 Windows 微信，**真实模式未在本机跑通**；本机实际验证的是 Mock 模式自检（21 项全过）。真实模式必须按本文第 8 节在目标专用机上完成验收，禁止把「Mock 通过」当成「真实微信可用」。

---

## 1. 目录结构

```text
packages/wechat-bridge/
├─ README.md                     # 本文（Windows 部署手册）
├─ requirements.txt              # 完整依赖（Web + wxauto，锁版本）
├─ requirements-mock.txt         # 仅 Mock 依赖（无微信机器 / CI）
└─ wechat_bridge/
   ├─ __init__.py                # 版本号
   ├─ __main__.py                # python -m wechat_bridge 入口（--mock/--host/--port）
   ├─ app.py                     # FastAPI 路由、鉴权、统一错误、生命周期
   ├─ auth.py                    # Bearer Token 校验
   ├─ config.py                  # 环境变量配置
   ├─ errors.py                  # 统一错误体 { ok:false, code, message }
   ├─ humanize.py                # 随机停顿 + 长文本分段
   ├─ instance_lock.py           # 单实例文件锁（Windows msvcrt / POSIX flock）
   ├─ listener.py                # 独立监听/轮询线程
   ├─ mock.py                    # Mock 内存后端（6 接口全实现）
   ├─ selftest.py                # 自检：起临时 Mock 服务断言全部契约
   └─ wechat_ui.py               # wxauto 真实后端（互斥锁/超时/重试/拟人化）
```

---

## 2. 快速开始（Mock 模式，无需微信）

Mock 模式用内存假数据实现同样的 6 个接口，适合前端/服务端联调和 CI。

### 2.1 安装

```powershell
cd C:\Users\30290\Desktop\fcmediaagent-replica\packages\wechat-bridge
python -m pip install -r requirements-mock.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

如果 pip 卡住超过 3 分钟，换清华镜像（上面的命令已经指定）；仍失败时检查代理/公司网络。

### 2.2 自检（必须先跑）

```powershell
python -m wechat_bridge.selftest
```

成功时最后一行是：

```text
SELFTEST OK
```

退出码 0；任何断言失败退出码 1，并打印服务日志尾部。自检会自己选空闲端口、起临时进程、跑完自动关闭，不依赖本机微信。

### 2.3 启动 Mock 服务

```powershell
$env:WECHAT_BRIDGE_MOCK = "1"
$env:WECHAT_BRIDGE_TOKEN = "local-dev-token"   # 可与上游 WECHAT_UIA_TOKEN 保持一致
python -m wechat_bridge --host 127.0.0.1 --port 18990
```

PowerShell 验证：

```powershell
Invoke-RestMethod http://127.0.0.1:18990/healthz
Invoke-RestMethod http://127.0.0.1:18990/api/v1/bot/status -Headers @{ Authorization = "Bearer local-dev-token" }
```

Mock 预置数据：

- 联系人：`Stu`、`Amy`（备注「客户-Amy」）、`文件传输助手`。
- 任意 `chat_name` 首次读取都会生成 5 条预置消息（时间升序）。
- `send` / `send-file` 追加到对应会话。
- 相同 `(name, msg)` 在幂等窗口（默认 5 秒）内重复提交不会重复追加，返回首次 `sent_at`。

> Mock 的 `humanize=true` 只走接口逻辑，不做真实随机等待，保证自检速度。

---

## 3. 环境变量

所有配置都从环境变量读取，便于计划任务 / nssm 注入。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WECHAT_BRIDGE_MOCK` | `0` | `1/true/yes/on` 时启用 Mock，不连接微信 |
| `WECHAT_BRIDGE_TOKEN` | 空 | 非空时校验 `Authorization: Bearer <token>`；空则启动打印警告并放行（仅本机调试） |
| `WECHAT_BRIDGE_HOST` | `127.0.0.1` | 监听地址；远程调用才改成内网 IP，见第 9 节 |
| `WECHAT_BRIDGE_PORT` | `18990` | 监听端口 |
| `WECHAT_BRIDGE_LOCK_FILE` | `%LOCALAPPDATA%\FCMediaAgent\wechat-bridge\bridge.lock` | 单实例锁文件 |
| `WECHAT_BRIDGE_LOG_DIR` | `%LOCALAPPDATA%\FCMediaAgent\wechat-bridge\logs` | 日志目录（自动轮转） |
| `WECHAT_BRIDGE_UI_TIMEOUT` | `30` | 单次 UI 操作拿锁 + 执行超时（秒） |
| `WECHAT_BRIDGE_UI_RETRY` | `2` | 失败后的重试次数；2 表示最多尝试 3 次，最终 503 `WECHAT_UI_BUSY` |
| `WECHAT_BRIDGE_HUMANIZE_MIN` | `0.3` | 拟人化随机停顿下限（秒） |
| `WECHAT_BRIDGE_HUMANIZE_MAX` | `1.2` | 拟人化随机停顿上限（秒） |
| `WECHAT_BRIDGE_LISTEN_POLL` | `2.0` | 监听线程轮询间隔（秒） |
| `WECHAT_BRIDGE_MAX_MESSAGES` | `200` | 单会话最多返回/缓存消息数 |
| `WECHAT_BRIDGE_IDEMPOTENCY_WINDOW` | `5.0` | Mock 发送幂等窗口（秒） |
| `WECHAT_BRIDGE_REQUEST_TIMEOUT` | `30.0` | 预留的请求超时配置（秒） |
| `WECHAT_BRIDGE_ACCESS_LOG` | `0` | `1` 时 uvicorn 打印每个请求 |

Token 只放环境变量/计划任务配置里，不要写进命令行参数（会被进程列表看到）。

生成一个强 Token：

```powershell
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

上游服务端对应配置：

```text
WECHAT_UIA_BASE_URL=http://127.0.0.1:18990
WECHAT_UIA_TOKEN=<与 WECHAT_BRIDGE_TOKEN 完全一致>
```

---

## 4. HTTP 契约（上游依赖，禁止改路径/字段）

除 `/healthz` 外都需要 Bearer Token。所有成功响应都带 `ok: true`；所有失败响应统一为：

```json
{ "ok": false, "code": "ERROR_CODE", "message": "中文说明" }
```

### 4.1 `GET /healthz`

不鉴权，返回 `200`，纯文本 `ok`。

### 4.2 `GET /api/v1/bot/status`

```json
{
  "ok": true,
  "logged_in": true,
  "nickname": "微信昵称",
  "wxid": "wxid_xxx",
  "wechat_version": "3.9.12.x",
  "mock": false,
  "uptime_s": 123.456
}
```

真实模式读不到微信时返回 `logged_in: false`，HTTP 仍为 200（避免上游把暂时读不到状态误判为网桥不可用）。

### 4.3 `GET /api/v1/memory/list?limit=50&offset=0`

```json
{
  "ok": true,
  "items": [
    { "wxid": "wxid_xxx", "name": "Stu", "remark": null, "last_msg_at": 1762330000 }
  ],
  "total": 3
}
```

- `limit` 1~500，默认 50；`offset` ≥ 0。
- 真实模式的列表来自微信**当前会话列表**，不是完整通讯录；`wxid` 可能为 `null`（wxauto 会话项不总带 wxid）；`last_msg_at` 只在网桥已缓存过该会话消息时才有值。

### 4.4 `GET /api/v1/chat/messages?chat_name=<必填>&wx_id=<可选>`

```json
{
  "ok": true,
  "chat_name": "Stu",
  "items": [
    { "id": "wx-Stu-1762330000-0-abcd1234", "from": "Stu", "text": "你好", "ts": 1762330000, "type": "text" }
  ]
}
```

- `chat_name` 必填，否则 400 `CHAT_NAME_REQUIRED`。
- 按 `ts` 升序；最多 `WECHAT_BRIDGE_MAX_MESSAGES`（默认 200）条。
- `from` 为发送者昵称；自己发送的消息为 `"我"`；系统消息为 `"系统"`。
- `type` 常见值：`text`、`file`、`image`、`system` 等（来自 wxauto 的消息类型）。

### 4.5 `POST /api/v1/chat/send`

请求：

```json
{ "name": "Stu", "msg": "你好", "humanize": true }
```

响应：

```json
{ "ok": true, "name": "Stu", "msg": "你好", "sent_at": 1762330000 }
```

- `humanize=true`：每段发送前随机停顿 0.3~1.2 秒；超过 120 字的长文本按标点分段发送。
- 同一请求失败会重试 `WECHAT_BRIDGE_UI_RETRY` 次；文本发送做了「已发送段数」记录，重试不会把已成功段落从头再发。
- `name` / `msg` 为空分别返回 400 `NAME_REQUIRED` / `MESSAGE_REQUIRED`。

### 4.6 `POST /api/v1/chat/send-file`

请求（`file_path` 与 `file_url` 二选一）：

```json
{ "name": "Stu", "file_path": "D:\\tmp\\report.pdf", "humanize": false }
```

```json
{ "name": "Stu", "file_url": "https://example.com/report.pdf" }
```

响应：

```json
{ "ok": true, "name": "Stu", "file": "D:\\tmp\\report.pdf", "sent_at": 1762330000 }
```

- `file_path`：相对路径按网桥进程当前目录解析；不存在返回 400 `FILE_NOT_FOUND`。
- `file_url`：仅允许 http/https，下载到临时目录后再发；失败返回 502 `FILE_DOWNLOAD_FAILED`。
- 响应里的 `file` 是实际发送的本地路径（URL 场景为下载后的临时文件路径）。
- 两者都缺返回 400 `FILE_REQUIRED`。

### 4.7 `POST /api/v1/chat/listen-list`

请求（`wxid` 与 `nickname` 至少一个）：

```json
{ "nickname": "Stu" }
```

响应：

```json
{ "ok": true, "following": ["Stu"] }
```

- 真实模式调用 wxauto `AddListenChat`，监听线程周期性拉取新消息写入本地缓存。
- 监听列表只存在内存，进程重启后需要上游重新调用注册。
- 缺参数返回 400 `TARGET_REQUIRED`。

---

## 5. 为什么选 wxauto（而不是 uiautomation）

任务要求 `wxauto` 或 `uiautomation` 二选一。本项目选 **wxauto**，理由：

1. **封装层级更高**：wxauto 已提供 `ChatWith`、`SendMsg`、`SendFiles`、`AddListenChat`、`GetAllMessage` 等稳定高层 API，正好覆盖 6 个契约；uiautomation 只提供控件树操作，发送、切会话、取消息都要自己写。
2. **版本适配集中**：wxauto 针对微信 3.9.x 的窗口类名/控件层级做了适配，升级时只需升级 wxauto 一个依赖；uiautomation 方案要把 UI 结构假设散落在业务代码里。
3. **文件与监听能力现成**：wxauto 原生支持发送文件和监听消息，减少自研 UIA + 剪贴板 + 轮询的复杂度。
4. **可锁定源码**：wxauto 已从 PyPI 下架，但 GitHub 仓库可访问；本项目锁定 commit `05e5a52379c99f401dc512acfdd811b3d701da8b`（pyproject 版本 39.2.1），避免「今天能装、明天 404」。

必须说明的代价：

- **版本对应关系**：wxauto（旧）只支持微信 3.9.x，而 3.9.x 已被腾讯停登；现在真实模式走 `wxauto4`：`40.1.x` ↔ 微信 4.0.x、`41.1.7` ↔ 微信 4.1.x。微信升级到新大版本后需要同步升级驱动。
- wxauto4 41.1.7 是 `cp312-win_amd64` 编译版 ⇒ 必须 Python 3.12。
- wxauto 底层仍是 Windows UIA。历史断点（`docs/handoff/checkpoints/T-11.md`）记录过：微信 3.9.11 的聊天区是 `MMUIRenderSubWindow`，Python `uiautomation` 找不到 `EditControl`，当时只能走坐标 + 视觉校验，且窗口矩形不稳定而 blocked。wxauto 对这个场景做了额外适配，但**不保证每个 3.9.x 小版本都可用**，所以必须锁版本并在目标机实测。若 wxauto 也失败，不要硬上线，回到断点里的坐标方案重新评估。

安装 wxauto 不需要 git（requirements 用的是 GitHub archive.zip），但目标机能访问 GitHub；若目标机完全断外网，请在能联网的机器执行：

```powershell
python -m pip download -r requirements.txt -d wheelhouse
```

再把 `wheelhouse` 拷到目标机：

```powershell
python -m pip install --no-index --find-links wheelhouse -r requirements.txt
```

---

## 6. 真实模式启动

### 6.1 安装依赖

```powershell
cd C:\fcmediaagent-replica\packages\wechat-bridge
python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

安装后确认：

```powershell
python -c "from wxauto4 import WeChat; print('wxauto4 ok')"
```

### 6.2 确认微信版本

必须使用 **微信 4.1.x**（本仓库按 `wxauto4==41.1.7` 验证的是 4.1.15.56）。3.9.x 已无法登录，不要再用；4.0.x 需要 `wxauto4==40.1.x`。

查看版本：

```powershell
(Get-Item "C:\Program Files (x86)\Tencent\WeChat\WeChat.exe").VersionInfo.FileVersion
```

### 6.3 启动

```powershell
$env:WECHAT_BRIDGE_MOCK = "0"
$env:WECHAT_BRIDGE_TOKEN = "<强随机 Token>"
$env:WECHAT_BRIDGE_LOG_DIR = "D:\fcmediaagent\logs"
python -m wechat_bridge --host 127.0.0.1 --port 18990
```

启动前确认：

- 微信已登录，主窗口已打开，**没有最小化**；
- 只有一个网桥进程（第二个会因单实例锁启动失败）；
- 屏幕已解锁（锁屏/休眠会让 UIA 读不到窗口）。

### 6.4 真实模式验收清单

1. `GET /api/v1/bot/status` 返回 `logged_in: true`、昵称和版本正确；
2. `GET /api/v1/memory/list` 能列出当前会话；
3. 对测试好友 `GET /api/v1/chat/messages` 能读到最近消息且升序；
4. `POST /api/v1/chat/send` 发一条文本，手机端确认收到；
5. `humanize=true` 发 300 字长文本，确认分成多条且间隔自然；
6. `POST /api/v1/chat/send-file` 发一个小文件，手机端确认收到；
7. `POST /api/v1/chat/listen-list` 后再让对方发消息，重复读 `chat/messages` 能看到新消息；
8. 停掉微信再调接口：返回 503 类错误而不是进程崩溃；重新登录后恢复；
9. 再启动第二个网桥：应被单实例锁拒绝。

---

## 7. 运行设计说明（排障前先读）

- **单实例锁**：`InstanceLock` 对锁文件首字节加独占锁；Windows 用 `msvcrt.locking`，POSIX 用 `fcntl.flock`。同一台机器只能有一个进程操作微信 UI。进程崩溃时锁由操作系统释放，不需要手工删锁文件；但不要在进程仍运行时删锁文件。
- **UI 互斥 + 超时 + 重试**：所有真实 UI 操作（状态、会话、消息、发送、文件、监听注册）都走 `_execute`：先拿 `threading.Lock`（最多等 `WECHAT_BRIDGE_UI_TIMEOUT` 秒），失败重试 `WECHAT_BRIDGE_UI_RETRY` 次，仍失败返回 HTTP 503 `WECHAT_UI_BUSY`。状态接口是例外：失败时降级成 `logged_in:false`，HTTP 仍 200。
- **监听线程与 HTTP 分离**：`ListenerService` 是 daemon 线程，按 `WECHAT_BRIDGE_LISTEN_POLL` 轮询；它只尝试 0.5 秒拿 UI 锁，拿不到就跳过本轮，避免轮询把发送接口堵死。
- **拟人化**：`humanize.py` 在标点处切分长文本（默认 120 字/段），每段前随机 sleep 0.3~1.2 秒。随机数使用进程内 `random.Random`，不共享全局状态。
- **幂等**：Mock 对 `(name, msg)` 做时间窗去重；真实模式不做业务幂等（微信本身没有消息 ID 去重），上游重试可能导致重复发送，建议上游只在网络错误时重试，并控制重试次数。
- **日志**：控制台 + `WECHAT_BRIDGE_LOG_DIR/bridge.log`，单文件 5MB，保留 5 个备份。启动日志会打印 mock/host/port/token 是否启用（不打印 Token 明文）。

---

## 8. Windows 专用机部署手册

### 8.1 机器要求

- **专用物理机或 VM**：不要和日常办公、其他微信账号共用。推荐 Windows 10 22H2 / Windows 11 x64，4 vCPU、8GB 内存、80GB 磁盘。
- **一个环境一个微信号**：同一台机器只登录一个微信；需要多账号就多台 VM/多台机器，不要试图在一个桌面里切号。
- **显示**：1920×1080，缩放 **100%**，不要用 125%/150%（UIA 坐标和控件可见性会变）。关闭屏保、睡眠、显示器节能。
- **会话**：必须保持**交互式登录会话**。锁屏、休眠、RDP 断开都可能导致 UIA 找不到窗口。远程维护优先用控制台/VM 控制台；必须用 RDP 时，断开前执行 `tscon <会话ID> /dest:console` 把会话交还控制台（需要管理员权限），不要让 RDP 会话直接断开。
- **系统更新**：专用机可延迟 Windows 自动重启，但不要永久关闭安全更新；安排在无人值守时段重启，并确保微信和网桥能自动拉起。
- **VM 快照/镜像**：装好微信 4.1.x + 网桥并验收通过后打快照；微信弹更新后可能破坏 UIA 结构，靠快照回滚最快。

### 8.2 微信版本锁定与关闭自动更新

1. 安装微信 **4.1.x** 离线安装包（本仓库验证 4.1.15.56），安装后先备份安装目录与安装包到 `D:\software\weixin-4.1.x`。
2. 退出微信，重命名更新程序（不同版本路径可能略有差异）：
   ```powershell
   Rename-Item "C:\Program Files (x86)\Tencent\WeChat\WeChatUpdate.exe" "WeChatUpdate.exe.bak" -ErrorAction SilentlyContinue
   ```
3. 禁用腾讯相关计划任务（专用机上执行；先看清楚再禁用）：
   ```powershell
   Get-ScheduledTask | Where-Object { $_.TaskName -match 'WeChat|Tencent' } | Disable-ScheduledTask
   ```
4. 微信设置里关闭自动更新/有新版本提示（不同小版本菜单名可能不同，通常在「设置 → 通用设置」或登录页右上角菜单）。
5. 用防火墙阻止更新程序出站（不要阻断 `WeChat.exe` 本身，否则消息收发会断）：
   ```powershell
   New-NetFirewallRule -DisplayName "Block-WeChatUpdate" -Direction Outbound -Program "C:\Program Files (x86)\Tencent\WeChat\WeChatUpdate.exe" -Action Block
   ```
6. 每天巡检 `GET /api/v1/bot/status` 的 `wechat_version`；一旦变成 4.x 立即停用并按快照回滚。
7. 不要让用户在这台机器上点「检查更新」「立即升级」；不要装 Microsoft Store 版微信。

### 8.3 账号自动登录与开机自启

1. 微信登录时勾选「自动登录」（若版本没有该选项，需要手机确认；专用机建议关闭微信的「登录保护」以外的二次验证干扰，但不要牺牲账号安全）。
2. Windows 自动登录（专用机才建议）：
   - 运行 `netplwiz`，取消「要使用本计算机，用户必须输入用户名和密码」，设置专用账号密码；或使用 Sysinternals **Autologon**。
   - 注意：Windows 自动登录密码会以可逆形式保存在注册表，务必使用专用低权限账号 + 全盘加密（BitLocker）。
3. 微信开机自启：把 `WeChat.exe` 快捷方式放到：
   ```text
   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
   ```
   或建计划任务「登录时」启动，延迟 30 秒，等桌面加载完。
4. 网桥开机自启：见 8.5。建议网桥比微信晚 30~60 秒启动；网桥本身是懒连接，早启动也不会崩，但状态会是未登录。
5. 关闭 Windows 锁屏/屏保：设置 → 个性化 → 锁屏界面 → 屏幕保护程序 → 无；电源选项 → 从不睡眠；组策略/注册表关闭自动锁屏（专用机）。

### 8.4 微信窗口固定置顶且不最小化

- 微信主窗口保持打开，**不要点最小化**；最小化后 UIA 可能读不到聊天控件。
- 窗口放在固定位置、固定大小（建议最大化或 1200×900），不要被其他窗口完全遮挡（UIA 一般不怕遮挡，但坐标兜底方案怕）。
- 置顶方案（任选其一）：
  - PowerToys → Always on Top（`Win+Ctrl+T`）把微信窗口置顶；
  - AutoHotkey v2 脚本每 5 秒检查并置顶/复位窗口：
    ```autohotkey
    #Requires AutoHotkey v2.0
    #Persistent
    SetTimer(KeepWeChat, 5000)
    KeepWeChat() {
        if WinExist("ahk_exe WeChat.exe") {
            WinSetAlwaysOnTop(true, "ahk_exe WeChat.exe")
            WinMove(0, 0, 1200, 900, "ahk_exe WeChat.exe")
        }
    }
    ```
- 不要用「关闭到托盘」后让窗口处于隐藏状态；托盘状态下部分 wxauto 操作会失败。
- 不要同时开多个微信窗口/多开器；单实例锁只能防网桥重复，不防微信多开。

### 8.5 网桥常驻（计划任务 / nssm）

#### 方案 A：计划任务（真实模式推荐）

必须让网桥运行在**已登录用户的交互式桌面会话**里，否则 UIA 无法操作微信窗口。因此用「登录时触发」的计划任务，而不是 Windows 服务。

图形界面步骤：

1. 任务计划程序 → 创建任务；
2. 常规：名称 `FCMediaAgent-WeChatBridge`，「只在用户登录时运行」，勾选「使用最高权限运行」；
3. 触发器：新建 → 「登录时」→ 延迟 30 秒；
4. 操作：启动程序 `C:\...\python.exe`，参数 `-m wechat_bridge`，起始于 `C:\fcmediaagent-replica\packages\wechat-bridge`；
5. 设置：勾选「如果任务失败，每隔 1 分钟重启一次，最多 999 次」；取消「如果任务运行超过 3 天，停止任务」；「如果计算机使用电池电源，则停止」按需取消。

命令行创建（把路径和 Token 换成实际值）：

```powershell
$action = New-ScheduledTaskAction -Execute "C:\Python314\python.exe" `
  -Argument "-m wechat_bridge" `
  -WorkingDirectory "C:\fcmediaagent-replica\packages\wechat-bridge"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Delay = "PT30S"
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "FCMediaAgent-WeChatBridge" -Action $action -Trigger $trigger `
  -Settings $settings -RunLevel Highest
```

环境变量不会自动继承到计划任务。请在任务里用 `cmd /c "set ... && python -m wechat_bridge"` 包裹，或把环境变量写入**系统/用户环境变量**后重启登录会话。推荐第二种，避免命令行里出现 Token。

#### 方案 B：nssm（仅建议 Mock / 无 UI 场景）

**重要：Windows 服务运行在 Session 0，不能操作交互式桌面的微信窗口。** 所以 nssm 只适合：

- 在无微信的机器上跑 Mock 做联调；
- 或只验证进程守护/日志/自启动，不用于真实发送。

Mock 示例：

```powershell
nssm install FCMediaAgentWeChatBridge "C:\Python314\python.exe" "-m wechat_bridge"
nssm set FCMediaAgentWeChatBridge AppDirectory "C:\fcmediaagent-replica\packages\wechat-bridge"
nssm set FCMediaAgentWeChatBridge AppEnvironmentExtra WECHAT_BRIDGE_MOCK=1 WECHAT_BRIDGE_TOKEN=<token>
nssm set FCMediaAgentWeChatBridge AppStdout "D:\fcmediaagent\logs\bridge-stdout.log"
nssm set FCMediaAgentWeChatBridge AppStderr "D:\fcmediaagent\logs\bridge-stderr.log"
nssm set FCMediaAgentWeChatBridge Start SERVICE_AUTO_START
nssm start FCMediaAgentWeChatBridge
```

真实模式如果一定要服务化，只能把「启动网桥」做成服务去调用计划任务/登录脚本，或者接受「服务启动网桥但 UIA 不可用」的失败结果——不要指望 `nssm` 服务能点微信。

### 8.6 多实例与端口

- 单实例锁保证一个进程；第二个进程启动会报「已有网桥进程持有单实例锁」并退出。
- 端口冲突时改 `WECHAT_BRIDGE_PORT`，同时改上游 `WECHAT_UIA_BASE_URL`。
- 不要在同一台机器跑两个微信账号的网桥；需要多账号请多 VM。

---

## 9. 网络与防火墙

### 9.1 最推荐：只监听 127.0.0.1

上游服务端和网桥在同一台机器：保持默认 `WECHAT_BRIDGE_HOST=127.0.0.1`，不需要任何入站防火墙规则，攻击面最小。

### 9.2 上游在另一台机器：只开内网 + 白名单

1. 网桥改监听内网网卡地址（不要 `0.0.0.0` 暴露到公网）：
   ```powershell
   $env:WECHAT_BRIDGE_HOST = "10.0.0.21"
   ```
2. 防火墙只放行接口服务器 IP。Windows 防火墙的「阻止」规则优先于「允许」，不要对同一端口同时建 Allow 全量 + Block 全量；正确做法是先把对应网络配置文件的入站默认动作设为阻止，再建一条精确白名单 Allow：
   ```powershell
   # 仅对专用机所在的 Domain/Private 网络生效；公网配置保持阻止
   Set-NetFirewallProfile -Profile Domain,Private -DefaultInboundAction Block
   New-NetFirewallRule -DisplayName "WeChatBridge-Allow-API" -Direction Inbound `
     -Protocol TCP -LocalPort 18990 -RemoteAddress 10.0.0.12 -Action Allow
   ```
   如果机器有多张网卡/多个网络配置文件，逐条确认 `Get-NetConnectionProfile` 的 NetworkCategory，避免把规则误加到公网网卡。
3. 最好再套一层 WireGuard/Tailscale 等内网 VPN，HTTP 明文只走加密隧道；不要在公网直接暴露 18990。
4. Token 必须强随机（≥32 字节），并定期轮换；轮换时同步改上游。

### 9.3 出站

- 允许微信自身出站（否则无法收发消息）。
- 阻止 `WeChatUpdate.exe` 出站（见 8.2）。
- 如果 `file_url` 需要从公网下载，允许网桥进程访问对应域名；否则用 `file_path` 走本地文件。

---

## 10. 日志与排障

### 10.1 日志位置

默认：

```text
%LOCALAPPDATA%\FCMediaAgent\wechat-bridge\logs\bridge.log
%LOCALAPPDATA%\FCMediaAgent\wechat-bridge\logs\bridge.log.1 ... .5
%LOCALAPPDATA%\FCMediaAgent\wechat-bridge\bridge.lock
```

计划任务/服务账号不同，`%LOCALAPPDATA%` 可能指向不同用户目录。生产环境建议显式设置 `WECHAT_BRIDGE_LOG_DIR=D:\fcmediaagent\logs`。

看最近日志：

```powershell
Get-Content "D:\fcmediaagent\logs\bridge.log" -Tail 200 -Wait
```

### 10.2 常见错误码

| code | HTTP | 含义 / 处理 |
|---|---|---|
| `UNAUTHORIZED` | 401 | Token 缺失或不匹配；核对上游 `WECHAT_UIA_TOKEN` 与 `WECHAT_BRIDGE_TOKEN` |
| `VALIDATION_ERROR` | 400 | JSON 字段类型不对（如 `humanize` 传了字符串乱值） |
| `CHAT_NAME_REQUIRED` | 400 | 缺少 `chat_name` |
| `NAME_REQUIRED` | 400 | 缺少 `name` |
| `MESSAGE_REQUIRED` | 400 | `msg` 为空 |
| `FILE_REQUIRED` | 400 | `file_path` / `file_url` 都没传 |
| `FILE_NOT_FOUND` | 400 | 本地文件不存在或无权限 |
| `FILE_URL_INVALID` | 400 | URL 不是 http/https |
| `FILE_DOWNLOAD_FAILED` | 502 | 下载远端文件失败（网络/证书/404） |
| `TARGET_REQUIRED` | 400 | 监听接口 `wxid` / `nickname` 都为空 |
| `WECHAT_WXAUTO_MISSING` | 503 | 没装 wxauto，或 Python 环境不对 |
| `WECHAT_NOT_READY` | 503 | 微信未启动/未登录/窗口不可见 |
| `WECHAT_UI_BUSY` | 503 | UI 操作连续失败/等锁超时；看日志里「UI 操作失败」的具体异常 |
| `NOT_FOUND` | 404 | 路径写错 |
| `INTERNAL_ERROR` | 500 | 网桥内部异常，日志有堆栈 |

### 10.3 「UI 元素找不到」怎么排

现象：日志出现 `WECHAT_UI_BUSY` / `Find Control Timeout` / `控件不存在`，发送或读消息 503。

按顺序检查：

1. 微信是不是 **4.1.x**？3.9.x 已停登（会被提示版本过低），4.0.x 需要 wxauto4 40.1.x（本仓库锁的是 41.1.7）。
2. 微信主窗口是否已登录、是否最小化、是否被关闭到托盘？恢复窗口。
3. 屏幕是否锁定/休眠？解锁，设置永不睡眠。
4. 显示缩放是否 100%？改成 100% 后重启微信。
5. 微信语言/主题是否被改过？用简体中文、默认浅色主题。
6. 目标会话是否在当前会话列表可见？先手动点开一次，确认窗口标题/会话名与 `chat_name` 完全一致（备注名/昵称不要混用）。
7. 是否开了多个微信/多开器？关掉多余实例。
8. 重启微信 + 重启网桥；单实例锁文件不需要手工删（进程退出会自动释放）。
9. 仍失败：保留日志，按第 5 节说明评估 wxauto 与微信小版本兼容性；不要盲目升级微信。

### 10.4 「微信弹出更新」

- 立即不要点「立即更新」；按 8.2 阻断 `WeChatUpdate.exe`。
- 微信只能停留在 **4.1.x**（3.9.x 已被腾讯停登）；微信小版本升级后如果网桥报 `未找到已登录的客户端主窗口`，按 wxauto4 的版本对应关系升级依赖（41.x ↔ 微信 4.1.x）。
- 每天巡检 `wechat_version`，发现变化告警。

### 10.5 「掉登录」

现象：`bot/status` 的 `logged_in` 变 false，或 `WECHAT_NOT_READY`。

1. 看微信窗口是否显示二维码/「登录已失效」；需要手机扫码或确认。
2. 检查是否在别的设备登录了同一账号（手机端「网页/Mac/Windows 微信已登录」）；把其它设备踢掉。
3. 检查网络、代理、DNS；微信离线会掉登录。
4. 检查 Windows 是否重启过但自动登录失败；重新登录并确认「自动登录」勾选。
5. 检查是否被杀软/安全软件拦截了微信注入或 UIA。
6. 恢复后先手动发一条消息验证，再调网桥。

### 10.6 自检失败

- `python -m wechat_bridge.selftest` 只依赖 `requirements-mock.txt`，不需要微信；失败先看它打印的服务日志。
- 端口冲突/权限：自检自动选空闲端口，一般不会冲突；若公司策略禁止监听本地端口，需申请。
- 中文乱码：自检已强制 UTF-8 输出；旧终端可先 `chcp 65001`。

---

## 11. 风控注意事项（务必阅读）

微信个人号自动化属于高风险操作，平台规则会变化，以下只是工程建议，不构成「不会被封」的保证：

1. **单号日发送上限建议 200 条**，新号/低活跃号建议从 20~50 条起步，稳定后再逐步提高；**不要**一上线就打满 200。
2. **随机化间隔**：开启 `humanize=true`，并把 `WECHAT_BRIDGE_HUMANIZE_MIN/MAX` 保持在 0.3~1.2 秒或更保守；批量任务在消息之间再叠加业务层随机间隔（例如 5~30 秒），不要固定节拍。
3. **避免群发同文**：同一段文案不要短时间发给大量联系人；至少做变量替换（称呼、上下文），并控制单批人数。
4. **控制时段**：只在正常作息时间发送（如 9:00~21:00），不要 7×24 小时不间断。
5. **单号单环境**：一台机器一个微信号；不要频繁切换账号、不要用模拟器/多开器。
6. **账号质量**：新注册、无实名、无支付、无历史聊天的号风险最高；优先用老号、有正常社交记录的号。
7. **内容风险**：少发链接、二维码、敏感词、营销硬广；先正常聊天建立互动，再发业务内容。
8. **观察反馈**：出现「操作频繁」「请稍后再试」「限制登录」立即停止当天任务，至少冷却 24 小时；不要换 IP/换设备硬刚。
9. **频率上限硬约束**：建议在业务层做「单号日发送计数器 + 单联系人冷却 + 全局并发 1」，不要只依赖网桥；网桥不做业务限流，只做 UI 串行。
10. **合规**：只处理有合法授权/用户同意的会话，遵守《个人信息保护法》和微信平台规则；不要用于骚扰、诈骗、灰产。

---

## 12. 安全清单

- [ ] `WECHAT_BRIDGE_TOKEN` 强随机（≥32 字节），只存环境变量/凭据管理，不写代码库、不写命令行。
- [ ] 默认监听 `127.0.0.1`；远程访问必须内网 + 防火墙白名单 + VPN。
- [ ] 专用机使用独立低权限 Windows 账号；开启 BitLocker。
- [ ] 不把 18990 映射到公网，不做端口转发到路由器。
- [ ] 日志不记录 Token 和消息全文（当前只记录错误与元数据；wxauto 异常可能包含会话名，注意日志访问权限）。
- [ ] 定期轮换 Token，离职/换人立即轮换。
- [ ] 保留微信安装包和 VM 快照，禁止自动升级。

---

## 13. 已知限制

1. **真实模式未在本机验证**：开发机未安装微信，wxauto 也未安装；仅 Mock 模式 21 项自检通过。真实 UI 行为必须在目标专用机按 6.4 验收。
2. 真实模式依赖 **微信 4.1.x + `wxauto4==41.1.7` + Python 3.12**；微信大版本变化会导致 UIA 结构变化，锁版本。
3. `memory/list` 是「当前会话列表」不是完整通讯录；`wxid` 可能为空。
4. 监听列表只存内存，重启后需上游重新注册；没有持久化消息库。
5. 真实模式没有业务级发送幂等；上游重试可能重复发送。
6. 单机单实例、单账号；不支持多账号并发。
7. UIA 对锁屏、RDP 断开、显示缩放、窗口最小化敏感；这些属于部署约束，不是代码能完全消除的。

---

## 14. 验收命令汇总

```powershell
# 1) 自检（Mock，不依赖微信）
cd C:\fcmediaagent-replica\packages\wechat-bridge
python -m wechat_bridge.selftest

# 2) 启动 Mock
$env:WECHAT_BRIDGE_MOCK="1"; $env:WECHAT_BRIDGE_TOKEN="local-dev-token"
python -m wechat_bridge --host 127.0.0.1 --port 18990

# 3) 健康检查
Invoke-RestMethod http://127.0.0.1:18990/healthz

# 4) 带鉴权调状态
Invoke-RestMethod http://127.0.0.1:18990/api/v1/bot/status `
  -Headers @{ Authorization = "Bearer local-dev-token" }

# 5) 发消息（Mock 会追加到 Stu 会话）
Invoke-RestMethod http://127.0.0.1:18990/api/v1/chat/send `
  -Method Post -ContentType "application/json; charset=utf-8" `
  -Headers @{ Authorization = "Bearer local-dev-token" } `
  -Body '{"name":"Stu","msg":"联调测试","humanize":true}'
```

真实模式把 `WECHAT_BRIDGE_MOCK` 设为 `0`，并确保微信 4.1.x 已登录、窗口未最小化（未登录会返回 503 `WECHAT_NOT_LOGGED_IN`）。
