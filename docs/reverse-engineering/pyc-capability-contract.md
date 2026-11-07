# 原版 `.pyc` 自动化能力行为探测台账

更新时间：2026-11-05

## 目标

先建立原版 `agent-tool-box` 的可观测行为契约，再选择开源替代品或自行重写。替代实现必须逐项覆盖输入、输出、异常、权限、外部副作用、重试和超时；只看函数名或文件名不能算覆盖。

## 已确认的入口契约

- 入口：`python tool_box.py <能力名> --params '<json>'`，复杂参数使用 `--params-file`。
- 运行时：原版 `.pyc` 使用 Python 3.12；Python 3.14 启动时入口会自动切换到本机 uv 的 3.12 解释器。
- 成功外壳：`{"success":true,"data":...,"error":null}`。
- 失败外壳：`{"success":false,"data":null,"error":"...","error_code":"..."}`。
- 未知能力：返回 `UNKNOWN_CAPABILITY` 和当前可用能力列表。
- 当前 SKILL 索引记录：45 个原子能力、62 个业务工作流；旧资产摘要中的 36/48 是过时统计。

## 能力分组

| 分组 | 原版职责 | 当前产品处置 |
|---|---|---|
| `feishu_*` | 表格、文档、消息读写 | 已裁剪飞书；逐项映射到本地表或标记 CUT |
| `wxauto_*` | 个人微信启动、状态、收发消息、好友、监听、联系人、朋友圈 | 先探测原版，再用个人微信 UIAutomation 重写 |
| `douyin_*` | 用户/视频采集、下载、转录、私信、草稿、评论回复 | 先保留接口；默认不随体验版分发 |
| `wechat_mp_*` | 公众号文章改写和文件改写 | 保留接口；公众号渠道另行验收 |
| `xhs/channels/bilibili_publish_draft` | 多平台草稿或发布 | 保留接口；账号登录和平台规则未确认 |
| `mysql_*` | 原版 SaaS 库查询和写入 | 不复用；改成本地 Prisma 服务 |
| `extract_url_content` | URL 正文提取及 Playwright 回退 | 可独立重写并做输入 URL/反爬测试 |
| 工作流 | 读表 → LLM → 渠道/媒体 → 写回 → 日志 | 逐个拆成可审计任务，不能整体黑盒复用 |

## 每个能力的探测记录格式

每个能力至少记录以下样例，所有外部写操作使用 DEMO 数据和测试账号：

1. 最小成功输入与完整 JSON 输出。
2. 缺少必填参数、错误类型和错误码。
3. 空结果、重复调用、超时、上游 4xx/5xx 和重试次数。
4. 身份来源、登录态、读取/写入的文件、数据库、网络域名和请求方法。
5. 是否发送消息、发布内容、修改标签、写回表格或消耗额度。
6. 超时、取消、进程重启后的状态，以及幂等键和重复副作用。
7. 最小替代接口和覆盖结论：完全覆盖、部分覆盖、待确认或 CUT。

## 首轮探测顺序

1. 只读能力：`wxauto_get_bot_status`、`wxauto_list_contacts`、`wxauto_get_messages`、`extract_url_content`。
2. 本地可控写入：`wxauto_add_listen_chat` 使用 DEMO 联系人、`feishu_db_*` 使用本地测试表。
3. 渠道发送：`wxauto_send_message`、`wxauto_send_file`，仅发送到用户明确指定的测试会话。
4. 抖音/公众号：先解析参数和 subprocess 边界，再决定是否在隔离账号上运行。
5. 工作流：先跑失败路径和 dry-run，再跑单条 DEMO 记录；记录每个内部步骤和写回结果。

## 当前结论

- `agent-tool-box` 不是一个单纯工具，而是一个包含 45 个原子能力和 62 个流程编排的运行时。
- 原版 `.pyc` 可以作为行为参考和临时兼容层，不能作为可审计的商业交付实现。
- 个人微信能力与当前产品路线重叠，必须先完成行为探测，再选择 `wxauto`、`wechatauto-replica`、`hermes-wxauto` 或自研 UIAutomation 适配器。
- 抖音、公众号和多平台发布涉及登录态、平台规则和账号副作用，体验版只保留契约位，不默认启用。

## 未知项

- 每个能力的真实请求体、返回字段、错误码、重试和超时仍需隔离运行采集。
- `.pyc` 内部是否存在未列出的文件读取、网络域名、账号信息和持久化副作用，静态索引无法证明。
- 替代项目的许可证、微信版本兼容性和商业分发条件需要逐个核验。

## 第一轮实测结果（2026-11-05）

| 探针 | 结果 | 行为证据 |
|---|---|---|
| `tool_box.py --help` | 成功 | 入口要求 `capability` 和 `--params/--params-file`；启动时会把 Python 3.14 自动切换到 uv 管理的 Python 3.12 |
| `__unknown_probe__ --params {}` | 失败且可诊断 | 返回 `success:false`、`error_code=UNKNOWN_CAPABILITY`，并附带完整 `available_capabilities` 列表；运行时列表包含 100+ 注册项，旧的 45/62 统计仍需以此列表复核 |
| `wxauto_get_bot_status --params {}` | 失败且无微信副作用 | 返回 `error_code=ValueError`；失败点是未配置 `WXAUTO_PORT`，入口依赖客户端启动 wxauto 服务后注入端口或生成 `config/.port` |

这轮没有读取联系人、消息或登录态，也没有发送消息、启动服务、修改表格或发布内容。下一轮应先探测参数校验和 `wxauto_stop_bot` 的无服务行为，再在用户明确提供测试会话后做发送类探针。

## 第二轮实测结果（2026-11-05）

| 探针 | 结果 | 行为证据 |
|---|---|---|
| `wxauto_stop_bot --params {}` | 失败且无副作用 | 和状态查询相同，先要求 `WXAUTO_PORT`；没有端口时不返回“已停止”假成功 |
| `wxauto_send_message --params {}` | 失败且无网络调用证据 | 入口先读取 `name`，缺少必填字段返回 `KeyError('name')`；参数错误尚未进入 wxauto HTTP 层 |
| `extract_url_content` + `https://example.com` | 成功 | 返回 `url/title/content/html_length/content_length/method/blocked/error`；本次 `method=requests`、`blocked=false`。终端编码使中文内容显示异常，字段结构仍可用 |

替代实现需要把原版裸 `KeyError` 转成稳定的参数错误码，同时保持字段结构和 requests/浏览器回退信息；不能把未配置微信服务误报成停止成功。

## 第三轮实测结果（2026-11-05）

| 探针 | 结果 | 行为证据 |
|---|---|---|
| `wxauto_get_messages --params {}` | 失败 | 缺少 `chat_name` 时外层 `success=false`、`error_code=KeyError` |
| `wxauto_send_file --params {name: "__DEMO__"}` | 嵌套失败 | 外层 `success=true`，但 `data.success=false`、`data.error="缺少 file_path 或 file_url"`；不能只判断最外层 success |
| `wxauto_add_listen_chat --params {}` | 失败且无副作用 | 参数为空仍进入 HTTP 层前置检查，最终因 `WXAUTO_PORT` 未配置失败 |
| `extract_url_content --params {url: "not-a-url"}` | 容错返回 | 外层 `success=true`，返回空内容和 `error`；同时记录 `fallback_attempted=playwright_failed`、`fallback_reason`、`fallback_error` |

替代层应提供统一错误模型，同时保留原版的嵌套结果和回退诊断字段，避免客户端丢失可操作的失败原因。
