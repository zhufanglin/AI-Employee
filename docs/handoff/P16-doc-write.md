# P16 文档生成（doc_write）交接说明

## 为什么做

P16 之前，员工只能把结果交付成 md / txt / csv（`file_write`），给老板或客户发"能直接打开的表"和"能直接打印的文档"要人肉转换。本能力补上两类真实交付物：

- **Excel（.xlsx）**：多工作表、中文表头、数字/布尔单元格，可直接筛选、透视；
- **Word（.docx）**：标题、项目符号、编号、表格、粗体，按 markdown 子集排版，可直接改稿打印。

生成后立即落到当前用户工作区（复用 `saveWorkspaceFile`），返回可下载的 key 与（配置了 OSS 时的）直链，和 `file_write` 交付链路一致。

## 能力与参数

能力名：`doc_write`（category：`file`）。参数非法时抛 `BadRequestException`（中文文案），由上层包装成 `{success:false,error}`。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `format` | 是 | `"xlsx"` 或 `"docx"`，大小写不敏感 |
| `name` | 是 | 文件基础名（不含扩展名），会安全化；最终名 `<name>.<format>` |
| `title` | 否 | 文档标题：docx 作为一级标题加在正文前；xlsx 仅在 `rows` 快捷方式下作为表名（默认 `Sheet1`） |
| `content` | 否 | 正文，markdown 子集（仅 docx 使用，xlsx 忽略）；与 `sheets`/`rows` 至少给一个 |
| `sheets` | 否 | xlsx 多工作表：`[{ name: string, rows: (string\|number\|boolean\|null)[][] }]`，最多 10 个 |
| `rows` | 否 | xlsx 单表快捷方式，等价 `sheets=[{ name: title \|\| "Sheet1", rows }]`；`sheets` 优先 |

返回：

```ts
{ name, bytes, key, url, format,
  sheets?: string[],      // xlsx：最终工作表名（清洗/截断/去重后）
  paragraphs?: number }   // docx：正文段落数（不含表格内部段落）
```

docx 的 markdown 子集（自研解析，未引第三方 md 库）：

- `# ` / `## ` / `### ` → Heading1/2/3；
- `- ` 或 `* ` → 项目符号；`1. ` 等 → 编号列表（docx numbering，`%1.`）；
- 连续 `| a | b |` 行 → 表格；第二行或任意 `|---|:---:|` 分隔行跳过；表头行加粗；
- `**粗体**` → 粗体 run（按 `**` 切分，奇数段加粗；不处理嵌套）；
- 空行 → 空段落；正文末尾换行不产生多余空段落。

## 限制与安全边界

- `content` ≤ 200000 字符；单表 ≤ 5000 行 × 100 列；所有表合计单元格 ≤ 50000；`sheets` ≤ 10。
- 表名 ≤ 31 字符，`[]:*?/\` 替换为 `_`，重名自动加 ` (2)`、` (3)` 后缀（Excel 表名不区分大小写）；空名回落 `Sheet1`/`SheetN`。
- 单元格仅接受 `string | number | boolean | null`：`NaN`/`Infinity`、对象、数组直接报错；单格文本 ≤ 32767 字符（xlsx 格式硬限制）。
- 输出字节 ≤ 8MB，超限报错（`saveWorkspaceFile` 的 20MB 上传上限之前再收一道）。
- 文件基础名安全化：路径分隔符 `\` `/` 与 `..` 替换为 `_`，非法字符替换为 `_`，去首尾 `. _ -`；清洗后为空则报错；最长 60 字符；误带 `.xlsx/.docx/.xls/.doc` 时先去掉再拼，避免 `报告.xlsx.xlsx`。
- 落盘只经 `saveWorkspaceFile(userId, ...)`，严格写 `workspace/<userId>/`，不读写他人文件；不拼 shell。
- xlsx 只给 `content` 会报错（"xlsx 必须提供 sheets 或 rows"），因为 content 对表格无意义；docx 只给 `sheets` 会报错（"没有可写入的内容"）。
- docx 里的 `sheets/rows` 不参与生成。

## 验证结果（真实运行）

环境：仓库根 `C:\Users\30290\Desktop\fcmediaagent-replica`，NODE 便携版 v24.22.1。

1. 依赖预检：`xlsx` 0.18.5、`docx` 9.5.1、`mammoth` 均可 require；`typeof Packer.toBuffer === "function"`。
2. 类型检查 + 产物：
   `NODE node_modules\typescript\bin\tsc -p packages\server\tsconfig.json` → **exit 0**（产物 `packages/server/dist/capabilities/capabilities/docs-write.js`）。
3. 单测：`NODE scripts\smoke-p16-doc-write.mjs` → **34 项全 PASS，0 FAIL，exit 0**，最后一行：
   `P16 doc-write SMOKE OK (34 checks)`
   - xlsx：生成 / 落盘字节一致 / `XLSX.read` 读回表名与首行 / 中文逐字比对无乱码 / 多表顺序 / `rows` 快捷方式（含布尔单元格）/ 31 字符截断 / 非法字符清洗 / 重名后缀 / 5001 行拒绝 / 101 列拒绝 / 66000 单元格总量拒绝 / 对象单元格拒绝；
   - docx：生成 / `mammoth.extractRawText` 读回标题、项目符号、编号、表格单元格、`**粗体**` 不破坏文本连续性 / `convertToHtml` 断言 `<h1>`、`<h2>`、`<table>`、`<strong>`、`<ul>`、`<ol>` / 只给 title 可生成 / content 空且无 sheets 报错 / 只给 sheets 报错；
   - 通用：缺 format / `format=pdf` / 缺 name / 都不给 / 只给 content / 11 张表 / content 超 20 万字符均拒绝；`../报表` 安全化为 `报表.xlsx` 且可按名回查；`..` 拒绝；`a\b` → `a_b.xlsx`；误带扩展名不重复；B 用户按 key 访问 A 文件抛"无权访问"，按名查返回 null；无 OSS 时 `url` 为 null。
4. 临时工作区指向 `%TEMP%\p16-doc-write-*`，跑完清理，不污染仓库。

## 没做的事

- **不做 PDF**：pdf-lib 内置 Helvetica 渲染不了中文，服务器也没有可嵌入的 CJK TTF 字体；硬做只会产出乱码文件，故本批次明确不做（`format=pdf` 直接报错）。后续要做得先解决中文字体授权与分发（如思源黑体子集）。
- **没有改 `capability.service.ts`**（按分工要求，该文件归 lead/集成方）：`doc_write` 的 descriptor 与 handler 尚未注册进 `CapabilityService`。集成时需要：`import { descriptors as docWriteDescriptors, handlers as docWriteHandlers } from "./capabilities/docs-write";`，把 `...docWriteDescriptors` 加入 `descriptors`，`...docWriteHandlers` 加入 `handlers`。未注册前前端/员工侧看不到该能力。
- 未接 worker 的提示词/工具白名单（`packages/worker/tool-loop.mjs` 属他人文件），员工是否能自主调用取决于集成方的能力清单。
- 8MB 输出上限有实现但未在 smoke 中构造（要让 5 万单元格撑到 8MB 需要超大文本，跑得慢且无额外价值），属于防御性兜底。
- markdown 只支持题面列出的子集：不支持代码块、引用、链接、图片、嵌套列表、多级缩进；docx 无页眉页脚、页码、目录、自定义字体/配色。
- xlsx 不写列宽、样式、公式、合并单元格、数据校验和冻结窗格（纯数据交付）。
- 未做 OSS 实测（本机无 OSS 凭据，`url` 走 null 分支；上传逻辑完全复用已验证的 `saveWorkspaceFile`）。
