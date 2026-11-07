import { BadRequestException } from "@nestjs/common";
import * as XLSX from "xlsx";
import mammoth from "mammoth";
import type { CapabilityDescriptor, CapabilityHandler } from "../capability.types";
import { extOf, readWorkspaceBytes, resolveWorkspaceFile } from "./files";

/** 文档解析：把用户上传的 Excel/Word/PDF 读成文本，供员工理解资料内容。 */
export const descriptors: CapabilityDescriptor[] = [
  {
    name: "doc_read",
    title: "读取表格/文档内容",
    category: "file",
    description: "读取工作区里的 Excel（xlsx/xls）、Word（docx）、PDF 文件并返回文本内容；Excel 按工作表输出 CSV 文本，PDF/Word 输出正文",
    params: { key: "可选，file_list 返回的 key", name: "可选，file_list 返回的文件名；key 与 name 至少填一个", maxChars: "可选，最大字符数，默认 8000，上限 40000" },
  },
];

const MAX_SHEETS = 5;

function clip(text: string, maxChars: number) {
  const clean = String(text ?? "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: clean.slice(0, maxChars), truncated: clean.length > maxChars, chars: clean.length };
}

async function parseExcel(buffer: Buffer, maxChars: number) {
  const book = XLSX.read(buffer, { type: "buffer" });
  const names = book.SheetNames.slice(0, MAX_SHEETS);
  const blocks: string[] = [];
  for (const name of names) {
    const sheet = book.Sheets[name];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    blocks.push("## 工作表：" + name + "\n" + csv.trim());
  }
  const body = blocks.join("\n\n");
  const meta = { sheets: book.SheetNames.length, parsedSheets: names.length };
  return { ...clip(body, maxChars), meta };
}

async function parseDocx(buffer: Buffer, maxChars: number) {
  const result = await mammoth.extractRawText({ buffer });
  return { ...clip(result?.value ?? "", maxChars), meta: { messages: Array.isArray(result?.messages) ? result.messages.length : 0 } };
}

async function parsePdf(buffer: Buffer, maxChars: number) {
  // pdf-parse 只在需要时加载，避免启动即初始化 pdfjs。
  const pdfParse: any = require("pdf-parse");
  const data = await pdfParse(buffer);
  return { ...clip(data?.text ?? "", maxChars), meta: { pages: Number(data?.numpages) || null } };
}

export const handlers = {
  doc_read: async ({ userId, params }: any) => {
    const maxChars = Math.min(Math.max(Math.trunc(Number(params?.maxChars) || 8000), 500), 40000);
    const file = await resolveWorkspaceFile(userId, params);
    if (!file) throw new BadRequestException("文件不存在或已被清理，先用 file_list 查看可用文件");
    const ext = file.ext || extOf(file.name);
    const buffer = await readWorkspaceBytes(userId, file);
    if (buffer.byteLength > 60 * 1024 * 1024) throw new BadRequestException("文档超过 60MB，请拆分后再上传");
    let parsed: { text: string; truncated: boolean; chars: number; meta: any };
    try {
      if (ext === ".xlsx" || ext === ".xls") parsed = await parseExcel(buffer, maxChars);
      else if (ext === ".docx") parsed = await parseDocx(buffer, maxChars);
      else if (ext === ".pdf") parsed = await parsePdf(buffer, maxChars);
      else if ([".md", ".txt", ".csv", ".json", ".html", ".xml", ".log"].includes(ext)) {
        parsed = { ...clip(buffer.toString("utf8"), maxChars), meta: { kind: "text" } };
      } else throw new BadRequestException("doc_read 不支持 " + ext + "，图片/音视频请用其它方式处理");
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException("文档解析失败：" + (error instanceof Error ? error.message : String(error)).slice(0, 200));
    }
    return { name: file.name, ext, bytes: file.bytes, ...parsed };
  },
} as Record<string, CapabilityHandler>;
