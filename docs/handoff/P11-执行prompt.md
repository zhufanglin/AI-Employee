# P11 执行 Prompt · 全项目再盘点 + 工具第一批（联网搜索 / 工作区文件读写）

> 版本：2026-11-07 ｜ 作者：dsh-lead
> 触发：用户 m09255「先再预览整个项目,避免遗漏,写出执行prompt,对照prompt执行,可以使用多Agent工作和给Codex派发任务,有模糊不清的问题必须问我」
> 本文同时是「现状台账」与「本批执行清单」。执行时逐条打勾，完成后回写状态。

---

## 第 0 部分 · 全项目现状台账（2026-11-07 重新采集）

### 0.1 契约层（详见 docs/fidelity-matrix.md，已重跑 scripts/audit/01..05）

| 维度 | 原版 | 复刻 | 精确命中 | 缺失 | 新增 | 命中率 |
|---|---:|---:|---:|---:|---:|---:|
| HTTP 路由 | 237 | 220 | 143 | 94 | 77 | 60.3% |
| IPC handle | 147 | 63 | 12 | 135 | 51 | 8.2% |
| Prisma 表 | 47 | 40 | 34 | 13 | 6 | 72.3% |
| Prisma 字段 | 588 | 524 | - | 159 | 95 | 73.0% |
| F1 文案 | 281 | - | 45 | - | - | 16.0% |

本次刷新后补齐：audio-materials、clone-records、compose-videos、media（11/11）。
仍缺模块：agent-plan、bitable、feishu(-config/-documents)、fusion-folders、fusion-materials、orders、recorder、scene-videos、sms、subscription、wechat-oa、workflow；admin 缺 29。
其中飞书系 / bitable / fusion 系 / scene-videos / recorder / subscription(会员) 属已裁或后置，不是都要补 —— 需一次按「是否影响能用」分级（P11-A）。

### 0.2 已完成主线（可对外说「能用」）

登录（短信+密码）→ 40+ 模型代理与按次计费（额度→积分→余额封顶）→ 17 员工目录/安装/运行/多步工具循环（10 步、SKILL.md 注入）→ 定时任务与补跑 → 任务看板/审批 → 媒体（文生图/图生视频/数字人/对口型/混剪/音色克隆，RunningHub + OSS 归档 + 取消退款）→ 支付（微信 V3 Native + 兑换码 + 员工按天订单）→ 运营后台 SPA → 桌面客户端（对话/办公区/数字人/生成/积分/渠道/设置/自动更新）→ 渠道（企微/公众号骨架 + 个人微信真机闭环）→ 更新服务器 → 生产部署（47.85.46.165，HTTPS）。

### 0.3 未完成台账（每项都要有归宿）

| # | 项 | 状态 | 归宿 |
|---|---|---|---|
| A | 企微回调（5 个值 + WW_verify 文件）+ 公众号（AppID/Secret/Token/AESKey + IP 白名单） | blocked(env) | 等用户凭证 |
| B | 微信支付真下单（WECHAT_PAY_SERIAL_NO 为空，接口 503） | blocked(env) | 等用户证书序列号 |
| C | 定价定稿（现为占位价） | 后置 | 用户「后面再说」 |
| D | 工具第一批：联网搜索 + 工作区文件读写 | 本批 P11 | 本文 |
| E | 工具第二批：批量抓取 / ffmpeg / 员工派活 | 未开工 | 本批之后 |
| F | F2 缺口分级与取舍（94 路由 / 135 IPC / 13 表） | 未做 | Codex（P11-A） |
| G | F1 文案覆盖 45/281 | 未做 | 后续批量补（可用混淆字符串表） |
| H | OSS 媒体结果公开读 → 收缩 | 草案已有 | 后置（公开读是当前「能用」支点） |
| I | 仓库根历史日志/截图、scripts/_*.mjs 临时脚本 | 未清理 | 本批顺带清 |
| J | 仓库不是 git 仓库（无版本回滚） | 风险 | 需用户点头 |
| K | 语音输入/克隆、录音器、tads 广告、会员订阅 | 已裁 | 不做 |

### 0.4 本批范围：只做 D

- P11-1 web_search 能力（服务端）
- P11-2 file_write / file_read（服务端）
- P11-3 工具循环接入（packages/worker/tool-loop.mjs）
- P11-4 单测 + verify + 生产部署 + 桌面 0.1.2
- 并行：P11-A（Codex）F2 缺口分级；P11-B（子 Agent）17 份 SKILL.md 与新工具匹配度

---

## 第 1 部分 · P11-1 web_search

### 1.1 契约

descriptor:
- name: web_search
- title: 联网搜索
- category: 信息获取
- description: 用搜索引擎检索公开网页，返回标题/链接/摘要；需要正文时再用 web_extract 抓取
- params:
  - query: 必填，检索词（自然语言，可含时间/地域限定）
  - maxResults: 可选，1-10，默认 5
  - days: 可选，只取最近 N 天（1-365）

返回 { provider, query, total, items: [{ title, url, snippet, published }] }；单条 snippet 截 400 字，总预算 6000 字。

### 1.2 实现要点

- 供应商：env SEARCH_PROVIDER = tavily | bing；缺省自动探测（有 TAVILY_API_KEY 用 tavily，否则 bing）。
- Tavily：POST https://api.tavily.com/search，body { api_key, query, max_results, search_depth: "basic", days }，超时 20s。
- Bing：GET https://api.bing.microsoft.com/v7.0/search?q=&count=&mkt=zh-CN，header Ocp-Apim-Subscription-Key。
- 未配置任何 key → 抛 BadRequestException，文案「未配置搜索服务，请联系管理员配置 TAVILY_API_KEY 或 BING_SEARCH_KEY」；绝不静默返回空数组（否则模型会编造）。
- 上游失败 → 抛带状态码与人话的错误，不吞。
- 不计积分（与原版 tavily-search 一致，只走模型 token）。

### 1.3 落点

- 新增 packages/server/src/capabilities/capabilities/search.ts（descriptor + handler）
- 注册：packages/server/src/capabilities/capability.service.ts 的 descriptors 与 handlers
- 新增 .env.example 变量：SEARCH_PROVIDER=、TAVILY_API_KEY=、BING_SEARCH_KEY=

---

## 第 2 部分 · P11-2 工作区文件读写

### 2.1 契约

file_write:
- params: name（必填，含扩展名，如「选品清单.md」）、content（必填，正文）、mime（可选）
- 返回 { name, bytes, url, key }

file_read:
- params: key（必填，file_write 返回的 key）、maxChars（可选，默认 8000，上限 40000）
- 返回 { name, bytes, truncated, text }

### 2.2 实现要点

- 存储键：workspace/<userId>/<uuid>-<safeName>；本地落 uploads/workspace/<userId>/。
- OSS 四件套齐全时同时上传并返回公网 url（复用 media.service.ts:237-285 的 ossClient 范式，勿重复造）；只落本地时 url 由 PUBLIC_BASE_URL 拼，未配置 PUBLIC_BASE_URL 则 url 为 null（只给 key）。
- 文件名安全：允许中文/字母/数字/点/下划线/短横，长度 ≤ 80；拒绝 ..、斜杠、反斜杠、控制字符；扩展名白名单 .md .txt .csv .json .html .xml .log。
- 单文件 ≤ 2MB（字符数 ≤ 1,000,000），超限抛明确文案。
- 隔离：key 必须以 workspace/<userId>/ 开头，否则抛无权限；防跨用户读取。
- 不计积分。

### 2.3 落点

- 新增 packages/server/src/capabilities/capabilities/files.ts
- 注册方式同 P11-1
- .env.example 新增可选 WORKSPACE_MAX_BYTES=2000000

---

## 第 3 部分 · P11-3 工具循环接入

packages/worker/tool-loop.mjs：
1. CAPABILITIES 集合加 web_search、file_write、file_read。
2. INSTRUCTIONS 增：搜索用检索词，拿到结果后再 web_extract 取正文；产出清单/表格/长文用 file_write 交文件，finish 正文给出文件名与链接。
3. 不动既有 JSON 协议与容错（extractJsonObject / instruction）。
4. 两个执行器（桌面 executor.ts / 云端 cloud-executor.mjs）不改代码 —— 能力清单是运行时从 /capabilities 拉的。

---

## 第 4 部分 · P11-4 验证与交付

1. 新增 scripts/smoke-p11-tools.mjs（零依赖，stub fetch + 临时目录）：
   - 能力清单含 3 个新名字；
   - Tavily 响应归一（title/url/snippet 截断）；
   - Bing 响应归一；
   - 未配置 key 抛明确错误；
   - file_write → file_read 往返一致；
   - 非法文件名（../x、a/b、x.exe）被拒；超 2MB 被拒；跨用户读被拒。
2. scripts/verify.ps1 增 Step「smoke: P11 工具（搜索/文件）」。
3. 生产部署：dist 同步（整目录 sha256 对比，勿只看解包成功）→ 重启 api → GET /api/capabilities 断言含新能力 → 线上跑 file 往返。
4. 桌面重建 0.1.2 + scripts/publish-update.mjs 发布（tool-loop 打进主进程）。
5. 文档 docs/handoff/P11-工具第一批.md，并回写本文件打勾。

---

## 第 5 部分 · 派工（写作用域互不重叠）

| 任务 | 负责人 | 写作用域 | 产出 |
|---|---|---|---|
| P11-1/2/3/4 | dsh-lead | packages/server/src/capabilities/**、packages/worker/tool-loop.mjs、scripts/smoke-p11-tools.mjs、scripts/verify.ps1、.env.example | 代码 + 单测 + 部署 |
| P11-A | Codex | 只新建 docs/handoff/F2-缺口分级与取舍.md | 94 路由 / 135 IPC / 13 表按「影响能不能用」分级 + 建议 |
| P11-B | 子 Agent | 只新建 docs/handoff/P11-技能需求映射.md | 17 份 SKILL.md 对工具的实际需求、本批 3 个工具覆盖率、还缺什么 |

---

## 第 6 部分 · 待用户确认（阻塞性模糊点）

1. 搜索服务商与 key：Tavily（原版预装技能就是 tavily-search，行为最接近）/ Bing Web Search / 火山方舟自带联网。没有 key 时该能力只能返回「未配置」。
2. 员工产出文件可读性：OSS 公网直链（简单，但拿到链接即可下载）还是私有（签名 URL 或登录后下载路由，约多 0.5 天）。
3. 是否本批顺带做：file_list（列目录，很小）、employee_dispatch（员工派活）、ffmpeg（加约 70MB 包体）。
4. 是否 git init：仓库现无版本控制，一次误改无法回滚。

---

## 第 7 部分 · 执行记录（边做边勾）

- [ ] P11-1 search.ts 落地 + 注册
- [ ] P11-2 files.ts 落地 + 注册
- [ ] P11-3 tool-loop 白名单与说明书
- [ ] P11-4 smoke-p11-tools.mjs + verify.ps1 集成 + VERIFY GREEN
- [ ] 生产部署 + /api/capabilities 断言
- [ ] 桌面 0.1.2 重建 + 发布
- [ ] 文档 P11-工具第一批.md
- [ ] P11-A（Codex）交付
- [ ] P11-B（子 Agent）交付
- [ ] 清理仓库根历史日志 + scripts 临时脚本
