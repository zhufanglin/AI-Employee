# web_extract 抓取守卫修复（生产全量拦截 → 恢复）

> 影响面：生产 `https://ai.fcmediaagent.com` 上 `web_extract` 对**任何**网址都返回「禁止访问内网或保留地址」，导致 5 个抓取类 AI 员工（获客雷达、同行爆款、评论区商机、博主拆解、GEO 诊断）在云端执行时第一步就废掉。

## 现象
- `POST /api/capabilities/run {name:"web_extract", params:{url:"https://www.baidu.com"}}` → `201 {success:false, error:"禁止访问内网或保留地址", error_code:"HttpException"}`
- 同样失败：example.com、mp.weixin.qq.com（都是公网地址）
- T-32 生产验收的任务 steps 里也留了这条失败记录

## 根因（实测定位，非猜测）
`packages/server/src/capabilities/capabilities/web-extract.ts` 把所有 IPv4 与 IPv6 网段加进**同一个** `BlockList`，其中 IPv6 段包含 `::ffff:0:0/96` —— 这是 **IPv4-mapped IPv6 段本身**。
Node 的 `BlockList.check(address, "ipv4")` 会先把 IPv4 映射成 `::ffff:a.b.c.d` 再比对，于是 `::ffff:0:0/96` 命中**所有** IPv4 ⇒ 任何 http(s) 网址都被判为内网。

复现证据（生产机 `/opt/node/bin/node`，v24.22.1）：
- 单条规则测试：`::ffff:0:0/96` 对 `103.235.46.96` 的 `check(ip,'ipv4')` 返回 **true**，其余 11 条 IPv6 规则与 14 条 IPv4 规则全部 false。
- 原逻辑对三个站点：`www.baidu.com [103.235.46.96, 103.235.47.188]`、`example.com [172.66.147.243, 104.20.23.154, 2606:4700:10::6814:179a, 2606:4700:10::ac42:93f3]`、`mp.weixin.qq.com [203.205.232.110, 203.205.239.154, 240d:c040:1:40::11d, 240d:c040:0:40::116]` —— 每个都被判命中。
- 说明：本机（Windows + VPN）DNS 返回 `198.18.x` 假地址，本地冒烟对这条断言是 SKIP 的，所以本地 verify 一直绿灯，问题只在生产暴露。

## 修复
- IPv4 / IPv6 拆成两张表：`deniedV4`、`deniedV6`；从 IPv6 表移除 `::ffff:0:0/96`。
- `isDenied(address, family)`：family=6 时若是 IPv4-mapped（`::ffff:a.b.c.d`）则取内嵌 IPv4 查 `deniedV4`，否则查 `deniedV6`；family=4 只查 `deniedV4`。
- `pickPublicAddress(addresses)`：**过滤出公网地址并使用**（原先语义是「任一命中即整条拒绝」，过严且导致 DNS 返回混合记录时误杀），仅当**全部**地址都是内网/保留时才抛「禁止访问内网或保留地址」；优先选 IPv4（避免服务器无 IPv6 出口时连不上）。
- 逐跳重定向仍复用同一函数，因此每一跳都会重新解析并重新校验（DNS 重绑定防护保留）。

## 回归测试（新增，防再犯）
`packages/server/src/capabilities/capabilities/web-extract-guard.test.cjs`（5 组断言，已并入 `scripts/verify.ps1` 的 `unit: web_extract SSRF 守卫`）：
1. 公网 IPv4 不被判内网（`103.235.46.96`/`104.20.23.154`/`203.205.232.110`/`43.174.196.235`/`8.8.8.8`）
2. 内网/保留 IPv4 必被拦（127/10/172.16/192.168/169.254/198.18/100.64/0.0.0.0）
3. IPv4-mapped IPv6 按内嵌 IPv4 判定
4. IPv6 内网/保留段必被拦，公网 IPv6 放行
5. `pickPublicAddress` 过滤内网并优先 IPv4；全部内网时抛错

## 生产验证（修复后，47.85.46.165，2026-11-06）
| 网址 | 结果 |
| --- | --- |
| https://example.com | ✅ success，title「Example Domain」，171 字 |
| https://mp.weixin.qq.com | ✅ success，title「微信公众平台」，1311 字（截断） |
| https://www.36kr.com | ✅ success |
| https://www.runninghub.ai | ✅ success，title「RunningHub ｜ AI Agent-Powered Content Creation Platform…」 |
| https://www.baidu.com | ❌ `socket hang up` —— 目标站点主动断开（美国机房访问百度常见），非守卫问题 |

部署方式：`packages/server/dist` 打包 → scp → `cp -r guard/dist/. app/dist/` → `systemctl restart fcmediaagent-api`；`health=200`，线上 `web-extract.js` 已含 `deniedV4`（grep 命中 4 处）。

## 剩余风险 / 后续
- `web_extract` 只抓单页 HTML，不做 JS 渲染；小红书、抖音等强前端站点抓不到内容，需要浏览器渲染能力（后续工具批次）。
- 2MB 上限与 20s 超时对长文站点偏紧，视实际使用再调。

## 2026-11-06 修复：员工工具循环 JSON 容错（web_extract 守卫之后）

### 现象
生产员工任务 `cmw3yslj5000xrzb4qm8cqy2o` 的 steps 是 `[web_extract ok 13.4s, invalid 80.8s, finish 30.6s]`：模型第二次回复不是纯 JSON（夹了解释文字/代码围栏），`instruction()` 直接抛错，白烧一步约 80 秒。`maxSteps` 默认只有 4，一次 invalid 就可能让多步任务触顶。

### 修复（packages/worker/tool-loop.mjs）
- 新增 `extractJsonObject(text)`：依次尝试 ①```json 代码围栏内文本 ②整段原文 ③从第一个 `{` 起按括号配平（跳过字符串内的括号与转义）截出的子串，取第一个能 `JSON.parse` 的结果。
- `instruction(text)` 改为：解析成功即接受；`tool` 兼容 `action` / `name` 别名；`params` 兼容 `args` / `arguments`，缺失时回退 `{}`；只有真的没有工具名才报错。
- 导出 `instruction` 以便单测；在 `tool === 'invalid'` 时向 transcript 追加一条强纠正消息（「只输出一个 JSON 对象，不要解释、不要代码块」）。

### 测试
`packages/worker/tool-loop-parse.test.mjs`（node --test）6 项全绿：纯 JSON / 代码围栏 / 前后带解释文字 / action 与 name 别名 / params 缺失回退 / 非法输入报错。已并入 `scripts/verify.ps1`（`unit: 员工工具循环 JSON 容错`）。

### 生产验证
- 部署：scp `tool-loop.mjs` + `cloud-executor.mjs` → `/opt/fcmediaagent/worker/` → `systemctl restart fcmediaagent-worker`（active，`grep -c extractJsonObject` = 2）。
- 重跑同一任务（`cmw3z0it6001zrzb4npql7v3y`）：steps 变为 `[web_extract ok 5.3s, finish ok 83.6s]` —— **invalid 步消失**，模型解释文字被容错吃掉，产出仍是完整的 3 条获客选题表格。

### 遗留
- `maxSteps` 仍默认 4（`tool-loop.mjs:13` / `executor.ts:127` / `cloud-executor.mjs:105` 取 `FCM_EXECUTOR_MAX_STEPS || 4`）→ 4→10 属员工执行策略，待用户拍板。
- 桌面端 executor 走同一个 `tool-loop.mjs`（`packages/desktop/src/main/executor.ts:4` import），但**桌面安装包需要重新构建**才带上这次修复。
