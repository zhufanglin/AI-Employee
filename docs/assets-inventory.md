# 原版资产清单（P3 资产层地基）

> 考古时间：2026-11-04。来源：`C:\Users\30290\Desktop\部署文件\_extract\0.4.29\app\resources\`（安装包 NSIS → app-64.7z 解包产物）。
> 这些资产此前**从未进入复刻计划**，但它们决定了"原版为什么能用"，属于 F3 行为忠实度的地基。

## 1. 预装技能 preinstalled-skills（11 个，304 文件）

路径：`app\resources\resources\preinstalled-skills\`，版本台账 `.preinstalled-lock.json`（generatedAt 2026-10-01）。

| slug | 版本 | 来源 | 作用 | 复刻处置 |
|---|---|---|---|---|
| agent-tool-box | 1.4.0 | local | **统一能力入口**（36 原子能力 + 48 工作流），Python | 复用（见 `2） |
| douyin-automation | 3.0.3 | local | 抖音采集/发布（27 文件，collector.py / publish_to_draft.py） | 复用，合规评估后 |
| multi-platform-publish | 1.0.0 | local | 小红书/视频号/B站发布脚本 | 复用，需账号登录态 |
| wechat-mp-agent | 1.0.0 | local | 公众号（23 文件），供 tool-box 以 subprocess 调用 | 复用 |
| tavily-search | — | 三方 | 联网搜索 API 封装 | 复用（需 key） |
| self-improving-agent | — | 三方 | 把纠错/经验写回技能目录（14 文件） | 复用 |
| find-skills | — | 三方 | 让 agent 自己发现并安装技能 | 复用（配合 bundles） |
| pdf / xlsx / docx / pptx | 8a1541c | anthropics/skills | 文档读写四大件（官方 MIT） | 直接复用 |

**关键事实**：`agent-tool-box` 的业务代码是 **.pyc 编译产物**（`capabilities/*.pyc`、`utils/*.pyc`），只有入口 `tool_box.py` 是源码。⇒ 能原样跑，但**读不到内部实现**；要改就必须重写。

## 2. agent-tool-box 能力地图（复刻的最高杠杆点）

调用契约（一条命令一个能力，输出恒定 JSON）：

```bash
python tool_box.py <能力名> --params '<json>' [--timeout 300]
# 成功 {"success":true,"data":{...},"error":null}
# 失败 {"success":false,"data":null,"error":"...","error_code":"ExceptionType"}
```

能力分两层：

**Layer A 原子能力（36）**

| 类别 | 数量 | 内容 |
|---|---|---|
| feishu | 15 | 多维表格读写（9 直调 OpenAPI + 6 个 CEO 别名）；**复刻已裁飞书**，需替换为本地表/API |
| wxauto | 8 | 个人微信（HTTP 调 wxauto-bot），与我们 W6 自研路线重叠 |
| douyin | 7 | 采集用户/发消息 + 5 个 subprocess wrapper |
| mysql | 2 | PyMySQL 直连（原版 SaaS 库） |
| wechat_mp | 2 | 公众号（subprocess 包 wechat-mp-agent） |
| web_extract | 1 | URL 正文提取 |

**Layer B 业务流程工作流（48）**：秘书助理 4、CEO 3、渠道经理 4、流量操盘手 9、销售经理 3、销售客服 7、私域运营 5、客户成功 3、新媒体运营 10。

典型串行：`secretary_daily_poster_workflow` = 读昨日内容表 → LLM 压缩≤200字 → 站点媒体 API 生成海报（4 种运营类型）→ 写今日分发表 → 写执行日志。**一个能力名 = 原版的一条 cron 业务流。**

`功能说明表.md` 里还记录着原版真实运营节奏：早间 07:00 / 午间 12:15 / 晚间 18:00 三时段发布，小红书 07:20、视频号 07:25、B站 07:30 错峰，22:00 数据复盘并迭代「爆款结构模板库」，20:00 每日战报。⇒ **这是员工域 cronPresets 与看板的真实来源。**

## 3. Agent 提示词注入层（我们完全没做）

| 文件 | 大小 | 内容 |
|---|---|---|
| `context\AGENTS.clawx.md` | 554B | 身份声明 "You are RRClaw, a desktop AI assistant application based on OpenClaw"，以及 **Tool Usage Rule：先用真工具试，拿到真实报错才允许说做不到；不许用训练数据假设拒绝** |
| `context\TOOLS.clawx.md` | 1392B | 工具使用规范：uv 用法（`uv run --no-progress --quiet python`，Windows cp936 解码失败会导致假 exit 1）、browser 三步法（start→snapshot→act）、shell:openExternal |

复刻落点：写入 `<userData>/openclaw/AGENTS.md`（openclaw workspace 提示词惯例），并在每个员工 agent 的 workspace 生成同构副本。

## 4. 技能市场与其它资产

| 资产 | 内容 | 复刻处置 |
|---|---|---|
| `skills\bundles.json` | 技能市场分类（productivity 效率办公 / developer / smart-home / media …，带 recommended 标记） | P3 技能市场页直接复用结构 |
| `openclaw-plugins\clawx-openai-image\` | 内置生图插件 | 复用 |
| `app\resources\openclaw-plugins\{dingtalk,feishu-openclaw-plugin,openclaw-weixin,wecom}\` | 4 个渠道插件（钉钉/飞书/微信/企微） | P4 渠道直接复用 |
| `voice\bgm.mp3`（17.1MB）、`clone-female.wav`、`clone-male.wav` | 视频背景音乐 + 音色克隆样例 | P8 媒体链路复用 |
| `runtime-cache\`（3438 文件） | 离线运行时缓存（uv/python/playwright 类） | 决定"断网可用"，P6 打包评估 |
| `installer\cards\`（12 个） | 首次启动引导卡片 | P6 首启流复用 |
| `icons\`（20）、`feishu\`（29）、`cli\{posix,win32}\` | 图标/飞书模板/CLI 包装 | 按需 |

## 5. 复用判定（结论）

1. **能复用**：pdf/xlsx/docx/pptx、tavily-search、self-improving-agent、find-skills、4 个渠道插件、bundles.json、voice 素材。
2. **能跑但不可改**：agent-tool-box、douyin-automation、wechat-mp-agent —— .pyc 形态，可直接用、改不了。⇒ 策略是「**调用它的能力名，不读它的实现**」。
3. **必须替换**：所有 feishu 能力（用户已裁飞书改本地表）、mysql 能力（原版 SaaS 库 schema）。
4. **法律风险需用户确认**：douyin-automation / multi-platform-publish / wechat-mp-agent 属平台自动化灰色地带，能否随包分发需拍板。

## 6. P3 落地清单

- [ ] `packages/desktop/resources/preinstalled-skills/` 复制 11 个技能（保留 .preinstalled-lock.json）
- [ ] 首次启动把技能落到 `<userData>/openclaw/skills/`，按 lock 版本判定升级
- [ ] 注入 `AGENTS.clawx.md` / `TOOLS.clawx.md`
- [ ] 员工域 cronPresets 对齐「功能说明表」真实节奏（17 员工 seed 已内置预设，可再校）
- [ ] 渠道插件接入 openclaw 配置（P4）
- [ ] 技能市场页接 bundles.json（P3 尾）
