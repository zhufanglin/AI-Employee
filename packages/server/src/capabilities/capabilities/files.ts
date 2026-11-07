import { BadRequestException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import OSS from "ali-oss";
import type { CapabilityDescriptor, CapabilityHandler } from "../capability.types";
import { env } from "../../common/env";

/** 工作区文件能力：员工落盘交付物、回读交付物，以及读取用户上传的资料。 */
export const descriptors: CapabilityDescriptor[] = [
  {
    name: "file_write",
    title: "写入工作区文件",
    category: "file",
    description: "把一个文本文件写入当前用户的工作区，返回可下载链接；适合交付清单、表格、长文",
    params: { name: "必填，文件名（含扩展名，如 选品清单.md）", content: "必填，文件正文", mime: "可选，MIME 类型，默认按扩展名推断" },
  },
  {
    name: "file_list",
    title: "列出工作区文件",
    category: "file",
    description: "列出当前用户工作区里的文件（含用户上传的资料、员工写出的交付物），按更新时间倒序；可先用它找到文件名再读",
    params: { limit: "可选，返回条数，默认 20，上限 50" },
  },
  {
    name: "file_read",
    title: "读取工作区文本文件",
    category: "file",
    description: "按 key 或文件名读取工作区里的文本文件（md/txt/csv/json/html/xml/log）；表格、PDF、Word 请用 doc_read",
    params: { key: "可选，file_write 或 file_list 返回的 key", name: "可选，file_list 返回的文件名；key 与 name 至少填一个", maxChars: "可选，最大字符数，默认 8000，上限 40000" },
  },
];

/** file_write 与 file_read 支持的纯文本扩展名。 */
const TEXT_EXTS = [".md", ".txt", ".csv", ".json", ".html", ".xml", ".log"];
/** doc_read 支持的文档扩展名。 */
const DOC_EXTS = [".xlsx", ".xls", ".docx", ".pdf"];
/** 用户上传通道额外允许的扩展名（图片、音视频作为素材引用，不解析）。 */
const UPLOAD_ONLY_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".mp3", ".wav", ".m4a", ".mp4", ".mov"];
export const UPLOAD_EXTS = [...TEXT_EXTS, ...DOC_EXTS, ...UPLOAD_ONLY_EXTS];

const MIME_BY_EXT: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

export function workspaceRoot(): string {
  return env("WORKSPACE_DIR", "").trim() || join(process.cwd(), "uploads", "workspace");
}

export function maxBytes(): number {
  const value = Number(env("WORKSPACE_MAX_BYTES", "2000000"));
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 2000000;
}

/** 上传通道单文件上限，默认 20MB（用户资料常比员工交付物大）。 */
export function uploadMaxBytes(): number {
  const value = Number(env("WORKSPACE_UPLOAD_MAX_BYTES", "20971520"));
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 20971520;
}

function checkName(raw: string): string {
  if (!raw) throw new BadRequestException("name 必填");
  if (raw.length > 80) throw new BadRequestException("文件名过长（最多 80 字）");
  if (raw.includes("..") || raw.includes("/") || raw.includes("\\") || /[\u0000-\u001f]/.test(raw)) throw new BadRequestException("文件名不能包含路径分隔符或控制字符");
  if (!/^[\w\u4e00-\u9fa5.-]+$/.test(raw)) throw new BadRequestException("文件名只能包含中文、字母、数字、下划线、点与短横");
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) throw new BadRequestException("文件名必须带扩展名");
  return raw;
}

/** 文件名白名单：文本类（file_write 用）。 */
export function safeFileName(input: string): string {
  const raw = checkName(String(input ?? "").trim());
  const ext = raw.slice(raw.lastIndexOf(".")).toLowerCase();
  if (!TEXT_EXTS.includes(ext)) throw new BadRequestException("不支持的文件类型 " + ext + "，可选：" + TEXT_EXTS.join(" "));
  return raw;
}

/** 文件名白名单：上传通道（文本 + 表格/PDF/Word + 图片音视频）。 */
export function safeUploadName(input: string): string {
  const raw = checkName(String(input ?? "").trim());
  const ext = raw.slice(raw.lastIndexOf(".")).toLowerCase();
  if (!UPLOAD_EXTS.includes(ext)) throw new BadRequestException("不支持的文件类型 " + ext + "，可选：" + UPLOAD_EXTS.join(" "));
  return raw;
}

export function extOf(name: string): string { return name.slice(name.lastIndexOf(".")).toLowerCase(); }

/** 用户 workspace 前缀，读时用于防越权。 */
export function userPrefix(userId: string): string { return "workspace/" + userId + "/"; }

export function ossClient() {
  const accessKeyId = env("OSS_ACCESS_KEY_ID", "");
  const accessKeySecret = env("OSS_ACCESS_KEY_SECRET", "");
  const bucket = env("OSS_BUCKET", "");
  const region = env("OSS_REGION", "");
  const endpoint = env("OSS_ENDPOINT", "");
  if (!accessKeyId || !accessKeySecret || !bucket || !region || !endpoint) return null;
  return new OSS({ region, accessKeyId, accessKeySecret, bucket, endpoint, secure: true });
}

export function publicBase(): string { return env("PUBLIC_BASE_URL", "").replace(/\/$/, ""); }

/** key → 本地绝对路径；不是 workspace/<userId>/ 前缀的一律拒绝。 */
export function localPathFor(userId: string, key: string): string {
  const prefix = userPrefix(userId);
  if (!key.startsWith(prefix)) throw new BadRequestException("无权访问该文件");
  const rest = key.slice(prefix.length);
  if (!rest || rest.includes("/") || rest.includes("\\") || rest.includes("..")) throw new BadRequestException("文件 key 无效");
  return join(workspaceRoot(), userId, rest);
}

export function userDir(userId: string): string { return join(workspaceRoot(), userId); }

/** 存储名 <uuid>-<原文件名> → 展示名（去掉 uuid 前缀）。 */
export function displayName(stored: string): string { return stored.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, ""); }

export function storedName(name: string): string { return randomUUID() + "-" + name; }

export type WorkspaceFile = { name: string; stored: string; key: string; ext: string; bytes: number; updatedAt: string };

/** 列出用户工作区文件，按更新时间倒序；目录不存在返回空数组。 */
export async function listWorkspaceFiles(userId: string): Promise<WorkspaceFile[]> {
  const dir = userDir(userId);
  let entries: string[] = [];
  try { entries = await readdir(dir); } catch { return []; }
  const rows: WorkspaceFile[] = [];
  for (const stored of entries) {
    if (stored.startsWith(".") || stored.endsWith(".tmp")) continue;
    try {
      const info = await stat(join(dir, stored));
      if (!info.isFile()) continue;
      rows.push({ name: displayName(stored), stored, key: userPrefix(userId) + stored, ext: extOf(stored), bytes: info.size, updatedAt: info.mtime.toISOString() });
    } catch { /* 并发删除忽略 */ }
  }
  rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return rows;
}

/** 按 key 或文件名定位文件；同名多份取最新一份。返回 null 表示不存在。 */
export async function resolveWorkspaceFile(userId: string, params: any): Promise<WorkspaceFile | null> {
  const key = String(params?.key ?? "").trim();
  const name = String(params?.name ?? "").trim();
  if (key) {
    const stored = key.slice(key.lastIndexOf("/") + 1);
    const path = localPathFor(userId, key);
    try {
      const info = await stat(path);
      if (!info.isFile()) return null;
      return { name: displayName(stored), stored, key, ext: extOf(stored), bytes: info.size, updatedAt: info.mtime.toISOString() };
    } catch { return null; }
  }
  if (!name) throw new BadRequestException("key 或 name 至少填一个，可先用 file_list 查看已有文件");
  const all = await listWorkspaceFiles(userId);
  const hit = all.find(row => row.stored === name) || all.find(row => row.name === name) || all.find(row => row.name === displayName(name));
  return hit ?? null;
}

/** 读文件原始字节（本地优先，回落 OSS）。 */
export async function readWorkspaceBytes(userId: string, file: WorkspaceFile): Promise<Buffer> {
  try { return await readFile(join(userDir(userId), file.stored)); } catch { /* 尝试 OSS */ }
  const client = ossClient();
  if (client) {
    try {
      const result: any = await client.get(file.key);
      return Buffer.isBuffer(result?.content) ? result.content : Buffer.from(result?.content ?? "");
    } catch { /* 落到下面抛错 */ }
  }
  throw new BadRequestException("文件不存在或已被清理");
}

/** 把一份字节写入用户工作区（本地 + OSS 尽力），返回记录。 */
export async function saveWorkspaceFile(userId: string, rawName: string, buffer: Buffer): Promise<{ file: WorkspaceFile; url: string | null }> {
  const name = safeUploadName(rawName);
  const ext = extOf(name);
  if (buffer.byteLength > uploadMaxBytes()) throw new BadRequestException("文件超过 " + Math.trunc(uploadMaxBytes() / 1024 / 1024) + "MB 限制");
  if (!buffer.byteLength) throw new BadRequestException("文件内容为空");
  if (TEXT_EXTS.includes(ext) && buffer.byteLength > maxBytes()) throw new BadRequestException("文本文件不能超过 " + Math.trunc(maxBytes() / 1024) + "KB");
  const stored = storedName(name);
  const key = userPrefix(userId) + stored;
  const path = join(userDir(userId), stored);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
  const mime = MIME_BY_EXT[ext] || "application/octet-stream";
  let url: string | null = null;
  const client = ossClient();
  if (client) {
    try {
      const result = await client.put(key, buffer, { headers: { "Content-Type": mime, "Content-Disposition": "inline" } });
      url = result.url || null;
    } catch (error) {
      console.error("[file] OSS upload failed, fallback to local:", error instanceof Error ? error.message : error);
    }
  }
  if (!url && publicBase()) url = publicBase() + "/uploads/" + key;
  const info = await stat(path);
  return { file: { name, stored, key, ext, bytes: info.size, updatedAt: info.mtime.toISOString() }, url };
}

/** 删除用户工作区里的一个文件（本地 + OSS 尽力）。 */
export async function deleteWorkspaceFile(userId: string, params: any): Promise<{ key: string; deleted: boolean }> {
  const file = await resolveWorkspaceFile(userId, params);
  if (!file) throw new BadRequestException("文件不存在或已被清理");
  try { await unlink(join(userDir(userId), file.stored)); } catch { /* 本地没有就看 OSS */ }
  const client = ossClient();
  if (client) { try { await client.delete(file.key); } catch { /* 尽力而为 */ } }
  return { key: file.key, deleted: true };
}

export const handlers = {
  file_write: async ({ userId, params }: any) => {
    const name = safeFileName(String(params.name ?? ""));
    const content = String(params.content ?? "");
    if (!content) throw new BadRequestException("content 必填");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > maxBytes()) throw new BadRequestException("文件超过 " + Math.trunc(maxBytes() / 1024) + "KB 限制");
    const stored = storedName(name);
    const key = userPrefix(userId) + stored;
    const path = join(userDir(userId), stored);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    const ext = extOf(name);
    const mime = String(params.mime ?? "").trim() || MIME_BY_EXT[ext] || "application/octet-stream";
    let url: string | null = null;
    const client = ossClient();
    if (client) {
      try {
        const result = await client.put(key, Buffer.from(content, "utf8"), { headers: { "Content-Type": mime, "Content-Disposition": "inline" } });
        url = result.url || null;
      } catch (error) {
        console.error("[file] OSS upload failed, fallback to local:", error instanceof Error ? error.message : error);
      }
    }
    if (!url && publicBase()) url = publicBase() + "/uploads/" + key;
    return { name, bytes, url, key };
  },
  file_list: async ({ userId, params }: any) => {
    const limit = Math.min(Math.max(Math.trunc(Number(params?.limit) || 20), 1), 50);
    const rows = await listWorkspaceFiles(userId);
    const base = publicBase();
    const items = rows.slice(0, limit).map(row => ({
      name: row.name,
      key: row.key,
      ext: row.ext,
      bytes: row.bytes,
      updatedAt: row.updatedAt,
      url: base ? base + "/uploads/" + row.key : null,
    }));
    return { total: rows.length, items };
  },
  file_read: async ({ userId, params }: any) => {
    const maxChars = Math.min(Math.max(Math.trunc(Number(params?.maxChars) || 8000), 500), 40000);
    const file = await resolveWorkspaceFile(userId, params);
    if (!file) throw new BadRequestException("文件不存在或已被清理，先用 file_list 查看可用文件");
    if (!TEXT_EXTS.includes(file.ext)) throw new BadRequestException("file_read 只读文本文件，" + file.ext + " 请改用 doc_read");
    const buffer = await readWorkspaceBytes(userId, file);
    const text = buffer.toString("utf8");
    return { name: file.name, bytes: file.bytes, truncated: text.length > maxChars, text: text.slice(0, maxChars) };
  },
} as Record<string, CapabilityHandler>;
