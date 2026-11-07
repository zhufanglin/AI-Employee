# T-11 个人微信：云上部署 Runbook（Windows 机器 + WireGuard 回连）

> 2026-11-06 dsh-lead。配合 `packages/wechat-bridge/README.md` 与 `docs/handoff/T11-渠道接入-实施方案.md` 使用。

## 0. 先说结论：现有那台 Linux 服务器不能直接跑

已在 47.85.46.165 实测：

| 检测项 | 结果 | 含义 |
|---|---|---|
| OS | Ubuntu 24.04.5 LTS | Linux，**没有微信 PC 客户端**（腾讯只发 Windows/macOS 版） |
| CPU 虚拟化标志 | `egrep -c '(vmx|svm)' /proc/cpuinfo` = **0** | 阿里云没透传 VT-x |
| `/dev/kvm` | **不存在** | 不能开 KVM 硬件虚拟化 |
| 磁盘 | 40G，剩 25G | 装 Windows 也不够（Win10 至少 30G） |
| 内存 | 7.4G，已用 1.4G | MySQL + api + worker 还要吃，再塞 Windows 会 OOM |

所以在这台机器上用 QEMU **纯软件模拟**跑 Windows 理论可行但实际不可用（无 KVM 时慢 10–20 倍，微信会卡死），且磁盘不够。**不要走这条路。**

## 1. 三条可行路径

| 方案 | 成本 | 稳定性 | 说明 |
|---|---|---|---|
| **A. 另买一台国内 Windows 云服务器**（推荐） | 约 ¥100–200/月（2C4G 起） | 高 | 最简单的「常开机器」；和 API 走 WireGuard 回连 |
| **B. 云桌面（阿里云无影 / 华为云 Workspace）** | 约 ¥150–300/月 | 高 | 天生就是「有人值守的 Windows 桌面」，不用操心 RDP 断开 |
| **C. 家里/办公室一台常开 Windows 机器 + 内网穿透** | 0（有旧机器的话） | 中（依赖你家电/网） | 最省；机器不用外网 IP，靠 frp/WireGuard 回连 |

**不建议**：把你现有那台美国 Linux 升级成 Windows —— 微信在国内，美国 IP 登录新设备极易触发风控（要求好友辅助验证/限制登录），且延迟高。

## 2. 方案 A 具体步骤

### 2.1 买机器
- 地域：**国内**（华东/华北均可），离你近的。
- 规格：**2 核 4G、系统盘 60G 起**（微信本体 ~1G + 聊天记录会涨）。
- 镜像：**Windows Server 2019 或 2022 中文版**（不要 Win11 桌面版，云上没显卡驱动更折腾）。
- 安全组：**不要**对公网开放 3389（RDP）以外的东西；RDP 只放行你当前的出口 IP。

### 2.2 装微信（关键约束）
1. 装 **微信 PC 3.9.x**（3.9.11 最稳）。**绝对不要 4.x** —— wxauto 靠 UIA 找控件，4.x 结构全变，直接不工作。
2. 装完：设置 → 通用设置 → **关闭「有更新时自动升级微信」**。
3. 把 `C:\Program Files (x86)\Tencent\WeChat` 目录设成只读（防偷偷升级）。
4. 用**专用小号**登录（别用主号），勾「记住密码」。

### 2.3 保持交互式桌面（这是整件事的核心难点）
wxauto/UIAutomation 必须在**有渲染的交互式会话**里跑。云服务器上 RDP 一断开，桌面就不再渲染，控件树直接空。

按顺序做：
1. `Win+R` → `netplwiz` → 取消「要使用本计算机，用户必须输入用户名和密码」→ 设自动登录（或用微软 `Autologon.exe`）。
2. 关闭睡眠/休眠/屏保：`powercfg /change standby-timeout-ac 0`、`powercfg /change monitor-timeout-ac 0`、`powercfg -h off`。
3. 关闭 Windows 自动更新重启：`sc config wuauserv start= disabled`（或组策略「配置自动更新=2 通知下载」）。
4. **用 RDP 登录一次并配置好一切**，然后**不要直接点断开**，在机器上执行（或通过 RDP 里的命令行）：
   ```bat
   tscon %sessionname% /dest:console
   ```
   这会把当前会话切到 console 会话，RDP 断开后桌面仍持续渲染。
   （之后每次 RDP 进来都要再 tscon 一次再退出；RDP 本身不影响使用，只是别让会话停留在「已断开」状态。）
5. 分辨率固定：用 `qwinsta` 确认会话，分辨率设 1280×800 即可，别用超高分辨率（找图/找控件更慢）。

### 2.4 部署网桥
1. 装 **Python 3.11+**（勾 Add to PATH）。
2. 把 `packages/wechat-bridge` 整个目录拷到 `C:\wechat-bridge`。
3. `cd C:\wechat-bridge` → `pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple`
4. 先跑 Mock：`set WECHAT_BRIDGE_MOCK=1 && python -m wechat_bridge.selftest` → 必须 `SELFTEST OK`。
5. 再跑真模式（微信已登录且窗口不最小化）：
   ```powershell
   $env:WECHAT_BRIDGE_TOKEN="<随机32位>"
   $env:WECHAT_BRIDGE_HOST="0.0.0.0"   # 只在内网/WireGuard 用
   $env:WECHAT_BRIDGE_PORT="8600"
   python -m wechat_bridge
   ```
6. 自测：`curl -H "Authorization: Bearer <token>" http://127.0.0.1:8600/api/v1/bot/status` → `logged_in:true`。
7. **常驻**：任务计划程序 → 创建任务 → 触发器「登录时」+「启动时」→ 操作 `pythonw.exe -m wechat_bridge`（工作目录 C:\wechat-bridge）。
   **不要**用「不管用户是否登录都运行」——那会跑进 Session 0，没有桌面，UIA 100% 失败。

### 2.5 回连到 API 服务器（WireGuard）
Windows 机器不暴露公网端口，用 WireGuard 组内网：

服务器侧（47.85.46.165，Ubuntu）：
```bash
apt-get install -y wireguard
wg genkey | tee /etc/wireguard/server.key | wg pubkey > /etc/wireguard/server.pub
cat > /etc/wireguard/wg0.conf <<'EOF'
[Interface]
Address = 10.66.66.1/24
ListenPort = 51820
PrivateKey = <server.key 内容>

[Peer]
PublicKey = <windows-client.pub>
AllowedIPs = 10.66.66.2/32
EOF
systemctl enable --now wg-quick@wg0
```
安全组放行 **UDP 51820**（建议限制来源 IP）。

Windows 侧：装 WireGuard 客户端，配置 `Address=10.66.66.2/32`、`Endpoint=47.85.46.165:51820`、`AllowedIPs=10.66.66.0/24`（**只走这个网段**，别把微信流量全代理到美国）。

服务器侧 API env（`/opt/fcmediaagent/server.env`）：
```
WECHAT_UIA_BASE_URL=http://10.66.66.2:8600
WECHAT_UIA_TOKEN=<与网桥一致的 token>
```
然后 `systemctl restart fcmediaagent-api`。

### 2.6 验收
1. 服务器上：`curl -H "Authorization: Bearer <token>" http://10.66.66.2:8600/api/v1/bot/status` → `logged_in:true`。
2. 服务器上：`curl http://127.0.0.1:3000/api/channels/personal-wechat/status`（带后台 JWT）→ 返回网桥状态，不再是 `WECHAT_UIA_NOT_CONFIGURED`。
3. 真机发一条：后台/服务端调 `POST /api/channels/personal-wechat/send` `{name:"文件传输助手", msg:"测试"}` → 微信里真的发出去。
4. 接收：调 `POST /api/channels/personal-wechat/listen` 订阅一个人，让对方发消息 → `GET .../messages?chat_name=xxx` 能读到。

### 2.7 风控红线（会封号的那种）
- 单号每日主动发送 ≤200 条，新号先养 7 天。
- 每条随机延迟 0.3–1.2 秒、长文本分段（网桥 `humanize=true` 已实现）。
- **禁止同文群发**（同一段文字发 20+ 人，必触发风控）。
- 不加好友、不拉群、不发文件给生人。
- 固定一台机器一个 IP 长期在线，别频繁换设备登录。

## 3. 需要你拍板

1. 选 **A（另买国内 Windows 云服务器）** 还是 **C（家里旧机器 + 内网穿透）**？C 我可以给你装 frp/WireGuard 的具体命令。
2. 买好后把 **公网 IP + RDP 账号密码** 给我，我把 2.2–2.6 全做完并跑通验收，再交给你。（RDP 我会用完后建议你改密码/收回）
3. 专用微信号先准备好（建议新注册或长期不用的小号）。

---

## 附：方案 C 已改用 SSH 反向隧道（2026-11-06）

本 Runbook 正文里的 WireGuard 方案**未采用**。最终落地为 **SSH 反向隧道**：Win10/11 自带 `ssh.exe`，
服务器 22 端口已开，`Match User wxbridge` 只允许 `PermitListen 127.0.0.1:8600`，无需改阿里云安全组、
无需装 WireGuard/frp。详见 **T11-个人微信-Windows部署手册.md**（家机一条命令安装 + 生产侧留档 +
排查对照表）。
