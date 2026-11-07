import { BadRequestException } from "@nestjs/common";
import * as XLSX from "xlsx";
import { AlignmentType, Document, HeadingLevel, LevelFormat, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import type { CapabilityDescriptor, CapabilityHandler } from "../capability.types";
import { saveWorkspaceFile } from "./files";

/** 文档生成：把结构化结果交付成 Excel（xlsx）或 Word（docx）文件，写入当前用户的工作区。 */
export const descriptors: CapabilityDescriptor[] = [
  {
    name: "doc_write",
    title: "生成 Excel / Word 交付文件",
    category: "file",
    description: "把表格数据导出成真正的 Excel（.xlsx），或把 markdown 子集排版成 Word（.docx），落盘到工作区并返回可下载链接；支持多工作表、标题、项目符号、编号、表格与粗体",
    params: {
      format: "必填，xlsx 或 docx",
      name: "必填，文件基础名（不含扩展名），会做安全化处理；最终名 <name>.<format>",
      title: "可选，文档标题；docx 作为一级标题，xlsx 在 rows 快捷方式下作为表名",
      content: "可选，正文（markdown 子集，仅 docx 使用）；与 sheets/rows 至少给一个",
      sheets: "可选，xlsx 多工作表：[{ name, rows: [[...]] }]，最多 10 个",
      rows: "可选，xlsx 单表快捷方式，等价于 sheets=[{ name: title || \"Sheet1\", rows }]",
    },
  },
];

/** 正文上限：20 万字符，避免一次生成超长文档拖垮进程。 */
const MAX_CONTENT_CHARS = 200000;
/** 工作表数量上限。 */
const MAX_SHEETS = 10;
/** 单表行数、列数上限（与原版能力对齐）。 */
const MAX_ROWS = 5000;
const MAX_COLS = 100;
/** 所有工作表合计单元格上限。 */
const MAX_TOTAL_CELLS = 50000;
/** 交付文件字节上限：8MB。 */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Excel 工作表名上限（Excel 自身限制 31 字符）。 */
const MAX_SHEET_NAME = 31;
/** Excel 单元格文本上限（xlsx 格式自身限制 32767 字符）。 */
const MAX_CELL_CHARS = 32767;
/** 文件基础名上限，给 .xlsx/.docx 扩展名留出空间（saveWorkspaceFile 总长上限 80）。 */
const MAX_BASE_NAME = 60;
/** docx 编号列表的引用名。 */
const NUMBERING_REF = "doc-write-numbering";

type Cell = string | number | boolean | null;
type SheetInput = { name?: string; rows: Cell[][] };
type RunSpec = { text: string; bold: boolean };
type Block =
  | { kind: "empty" }
  | { kind: "heading"; level: 1 | 2 | 3; runs: RunSpec[] }
  | { kind: "bullet"; runs: RunSpec[] }
  | { kind: "number"; runs: RunSpec[] }
  | { kind: "paragraph"; runs: RunSpec[] }
  | { kind: "table"; rows: string[][] };

/** 文件名安全化：去掉路径分隔符、目录穿越与其它非法字符，保留中文/字母/数字/点/短横。 */
function safeBaseName(input: string, format: string): string {
  let raw = String(input ?? "").trim();
  if (!raw) throw new BadRequestException("name 必填：请给出文件基础名（不含扩展名）");
  if (raw.length > 120) throw new BadRequestException("name 过长（最多 120 字）");
  // 用户误把扩展名写进 name 时去掉，避免出现 报告.xlsx.xlsx
  const lower = raw.toLowerCase();
  for (const ext of [".xlsx", ".docx", ".xls", ".doc"]) {
    if (lower.endsWith(ext)) { raw = raw.slice(0, -ext.length); break; }
  }
  let name = raw
    .replace(/[\\/]/g, "_")          // 路径分隔符
    .replace(/\.\.+/g, "_")          // 目录穿越
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, "_") // 与 files.ts 白名单对齐
    .replace(/^[.\s_-]+|[.\s_-]+$/g, "");
  if (!name) throw new BadRequestException("name 清洗后为空，请换一个包含中文、字母或数字的文件名");
  if (name.length > MAX_BASE_NAME) name = name.slice(0, MAX_BASE_NAME);
  // 双保险：format 由调用方校验，这里只拼接白名单扩展名
  return name + "." + format;
}

/** 工作表名安全化：Excel 禁止 []:*?/\ 且最长 31 字符；空名回落到 fallback。 */
function safeSheetName(input: unknown, fallback: string): string {
  let name = String(input ?? "").trim();
  if (!name) name = fallback;
  name = name.replace(/[\[\]:*?\\/]/g, "_").replace(/^'+|'+$/g, "").trim();
  if (!name) name = "Sheet1";
  if (name.length > MAX_SHEET_NAME) name = name.slice(0, MAX_SHEET_NAME);
  return name;
}

/** 工作表重名自动加后缀（Excel 表名不区分大小写）。 */
function uniqueSheetName(base: string, used: Set<string>): string {
  let candidate = base;
  let index = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = " (" + index + ")";
    candidate = base.slice(0, MAX_SHEET_NAME - suffix.length) + suffix;
    index += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** 单元格归一化：只接受字符串/数字/布尔/null，数字必须是有限值，超长文本直接拒绝。 */
function toCell(value: any, rowIndex: number, colIndex: number, sheetName: string): Cell {
  if (value === null || value === undefined) return null;
  const where = "工作表「" + sheetName + "」第 " + (rowIndex + 1) + " 行第 " + (colIndex + 1) + " 列";
  if (typeof value === "string") {
    if (value.length > MAX_CELL_CHARS) throw new BadRequestException(where + " 文本过长（单元格最多 " + MAX_CELL_CHARS + " 字符）");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new BadRequestException(where + " 是非法数字（NaN / Infinity）");
    return value;
  }
  if (typeof value === "boolean") return value;
  throw new BadRequestException(where + " 类型不支持，只能是字符串、数字、布尔或 null");
}

/** rows 校验与归一化：二维数组、行数/列数上限。 */
function normalizeRows(raw: any, sheetName: string): Cell[][] {
  if (!Array.isArray(raw)) throw new BadRequestException("工作表「" + sheetName + "」的 rows 必须是二维数组");
  if (raw.length > MAX_ROWS) throw new BadRequestException("工作表「" + sheetName + "」超过 " + MAX_ROWS + " 行上限（实际 " + raw.length + " 行），请拆分或改用 doc_write 前先聚合");
  return raw.map((row: any, rowIndex: number) => {
    if (!Array.isArray(row)) throw new BadRequestException("工作表「" + sheetName + "」第 " + (rowIndex + 1) + " 行不是数组");
    if (row.length > MAX_COLS) throw new BadRequestException("工作表「" + sheetName + "」第 " + (rowIndex + 1) + " 行超过 " + MAX_COLS + " 列上限（实际 " + row.length + " 列）");
    return row.map((cell: any, colIndex: number) => toCell(cell, rowIndex, colIndex, sheetName));
  });
}

/** 收集 xlsx 工作表：sheets 优先，其次 rows 快捷方式。 */
function collectSheets(params: Record<string, any>): SheetInput[] {
  let raw = params.sheets;
  if (raw === undefined || raw === null) {
    if (params.rows === undefined || params.rows === null) return [];
    const title = String(params.title ?? "").trim();
    raw = [{ name: title || "Sheet1", rows: params.rows }];
  }
  if (!Array.isArray(raw)) throw new BadRequestException("sheets 必须是数组：[{ name, rows }]");
  if (raw.length === 0) throw new BadRequestException("sheets 不能为空数组，请给至少一张工作表");
  if (raw.length > MAX_SHEETS) throw new BadRequestException("工作表最多 " + MAX_SHEETS + " 个（实际 " + raw.length + " 个）");
  return raw.map((sheet: any) => {
    if (!sheet || typeof sheet !== "object" || Array.isArray(sheet)) throw new BadRequestException("sheets 的每一项必须是 { name, rows } 对象");
    return { name: sheet.name, rows: sheet.rows };
  });
}

/** 生成 xlsx：aoa_to_sheet + book_new / book_append_sheet，返回 buffer 与最终表名。 */
function buildXlsx(sheets: SheetInput[]): { buffer: Buffer; sheetNames: string[] } {
  const used = new Set<string>();
  const prepared: { name: string; rows: Cell[][] }[] = [];
  let totalCells = 0;
  sheets.forEach((sheet, index) => {
    const name = uniqueSheetName(safeSheetName(sheet.name, "Sheet" + (index + 1)), used);
    const rows = normalizeRows(sheet.rows, name);
    totalCells += rows.reduce((sum, row) => sum + row.length, 0);
    prepared.push({ name, rows });
  });
  if (totalCells > MAX_TOTAL_CELLS) throw new BadRequestException("单元格总数超过 " + MAX_TOTAL_CELLS + " 上限（实际 " + totalCells + "），请拆分工作表");
  if (totalCells === 0) throw new BadRequestException("表格没有任何数据：请给 sheets/rows 至少一个非空单元格");
  const book = XLSX.utils.book_new();
  const sheetNames: string[] = [];
  for (const sheet of prepared) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows as any[][]);
    XLSX.utils.book_append_sheet(book, ws, sheet.name);
    sheetNames.push(sheet.name);
  }
  const buffer = Buffer.from(XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as any);
  return { buffer, sheetNames };
}

/** 行内 **粗体** 解析：按 ** 切分，奇数段为粗体；不处理嵌套。 */
function parseInline(text: string): RunSpec[] {
  const parts = String(text ?? "").split("**");
  const runs: RunSpec[] = [];
  parts.forEach((part, index) => {
    if (!part) return;
    runs.push({ text: part, bold: index % 2 === 1 });
  });
  return runs.length ? runs : [{ text: "", bold: false }];
}

/** 拆分 markdown 表格行：去掉首尾竖线后按 | 切分。 */
function splitRow(line: string): string[] {
  const body = line.slice(1, -1);
  return body.split("|").map(cell => cell.trim());
}

/** 表格分隔行：|---|:---:| 等。 */
function isSeparatorRow(cells: string[]): boolean {
  if (!cells.length) return false;
  return cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

/**
 * 把 markdown 子集解析成块：
 * # / ## / ### 标题；- 与 * 项目符号；1. 编号；| a | b | 表格；**粗体**；空行空段落。
 */
function parseMarkdown(content: string): Block[] {
  const text = String(content ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { blocks.push({ kind: "empty" }); i += 1; continue; }
    // 连续以 | 开头结尾的行视为一张表
    if (trimmed.length >= 2 && trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length) {
        const current = lines[i].trim();
        if (!(current.length >= 2 && current.startsWith("|") && current.endsWith("|"))) break;
        tableLines.push(current);
        i += 1;
      }
      const rows = tableLines.map(splitRow).filter(cells => !isSeparatorRow(cells));
      if (rows.length) blocks.push({ kind: "table", rows });
      else blocks.push({ kind: "empty" });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, runs: parseInline(heading[2].trim()) });
      i += 1;
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    if (bullet) { blocks.push({ kind: "bullet", runs: parseInline(bullet[1].trim()) }); i += 1; continue; }
    const numbered = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (numbered) { blocks.push({ kind: "number", runs: parseInline(numbered[1].trim()) }); i += 1; continue; }
    blocks.push({ kind: "paragraph", runs: parseInline(trimmed) });
    i += 1;
  }
  return blocks;
}

/** 生成 docx：标题 + markdown 子集排版，返回 buffer 与正文段落数。 */
async function buildDocx(title: string, content: string): Promise<{ buffer: Buffer; paragraphs: number }> {
  const blocks = content.trim() ? parseMarkdown(content) : [];
  // 正文末尾的换行不额外产生空段落，避免交付文档末尾多出一页空白
  while (blocks.length && blocks[blocks.length - 1].kind === "empty") blocks.pop();
  const children: Array<Paragraph | Table> = [];
  let paragraphs = 0;
  if (title) {
    children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }));
    paragraphs += 1;
  }
  for (const block of blocks) {
    if (block.kind === "empty") { children.push(new Paragraph({ text: "" })); paragraphs += 1; continue; }
    if (block.kind === "table") {
      const width = block.rows.reduce((max, row) => Math.max(max, row.length), 0);
      if (!width) continue;
      const rows = block.rows.map((cells, rowIndex) => new TableRow({
        children: Array.from({ length: width }, (_, colIndex) => {
          const value = cells[colIndex] ?? "";
          const runs = parseInline(value).map(run => new TextRun({ text: run.text, bold: run.bold || rowIndex === 0 }));
          return new TableCell({ children: [new Paragraph({ children: runs })] });
        }),
      }));
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
      continue;
    }
    const runs = block.runs.map(run => new TextRun({ text: run.text, bold: run.bold }));
    if (block.kind === "heading") {
      const heading = block.level === 1 ? HeadingLevel.HEADING_1 : block.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      children.push(new Paragraph({ children: runs, heading }));
    } else if (block.kind === "bullet") {
      children.push(new Paragraph({ children: runs, bullet: { level: 0 } }));
    } else if (block.kind === "number") {
      children.push(new Paragraph({ children: runs, numbering: { reference: NUMBERING_REF, level: 0 } }));
    } else {
      children.push(new Paragraph({ children: runs }));
    }
    paragraphs += 1;
  }
  const doc = new Document({
    numbering: {
      config: [{
        reference: NUMBERING_REF,
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START }],
      }],
    },
    sections: [{ children }],
  });
  const buffer = Buffer.from(await Packer.toBuffer(doc));
  return { buffer, paragraphs };
}

/** 输出体积兜底：超过 8MB 直接报错，避免写出半成品。 */
function assertOutputBytes(buffer: Buffer) {
  if (buffer.byteLength > MAX_OUTPUT_BYTES) {
    throw new BadRequestException("生成文件 " + (buffer.byteLength / 1024 / 1024).toFixed(1) + "MB，超过 " + MAX_OUTPUT_BYTES / 1024 / 1024 + "MB 上限，请减少内容或拆分");
  }
}

export const handlers = {
  doc_write: async ({ userId, params }: any) => {
    const format = String(params?.format ?? "").trim().toLowerCase();
    if (format !== "xlsx" && format !== "docx") throw new BadRequestException("format 必填，只能是 xlsx 或 docx");
    const name = safeBaseName(params?.name, format);
    const title = String(params?.title ?? "").trim();
    const content = typeof params?.content === "string" ? params.content : "";
    if (content.length > MAX_CONTENT_CHARS) throw new BadRequestException("content 超过 " + MAX_CONTENT_CHARS + " 字符上限（实际 " + content.length + " 字符），请精简或拆分");
    const sheets = collectSheets(params || {});
    if (!sheets.length && !content.trim() && !title) {
      throw new BadRequestException("content 与 sheets/rows 至少给一个：xlsx 用 sheets/rows，docx 用 content");
    }

    if (format === "xlsx") {
      // xlsx 的 content 没有意义，必须给结构化表格
      if (!sheets.length) throw new BadRequestException("xlsx 必须提供 sheets 或 rows（content 只用于 docx）");
      const { buffer, sheetNames } = buildXlsx(sheets);
      assertOutputBytes(buffer);
      const saved = await saveWorkspaceFile(userId, name, buffer);
      return { name: saved.file.name, bytes: saved.file.bytes, key: saved.file.key, url: saved.url, format, sheets: sheetNames };
    }

    // docx：content 或 title 至少有一个，否则会生成空白文档
    if (!content.trim() && !title) throw new BadRequestException("docx 没有可写入的内容：请提供 content（markdown 子集）或 title");
    const { buffer, paragraphs } = await buildDocx(title, content);
    assertOutputBytes(buffer);
    const saved = await saveWorkspaceFile(userId, name, buffer);
    return { name: saved.file.name, bytes: saved.file.bytes, key: saved.file.key, url: saved.url, format, paragraphs };
  },
} as Record<string, CapabilityHandler>;
