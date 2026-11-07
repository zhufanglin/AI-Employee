import { BadRequestException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import OSS from "ali-oss";
import type { CapabilityDescriptor, CapabilityHandler } from "../capability.types";
import { env } from "../../common/env";

/** 工作区文件读写：员工把清单/表格/长文落成文件并给出下载链接。 */
export const descriptors: CapabilityDescriptor[] = [
  {
    name: "file_write",
    title: "写入工作区文件",
    category: "file",
    description: "把一个文本文件写入当前用户的工作区，返回可下载链接；适合交付清单、表格、长文",
    params: { name: "必填，文件名（含扩展名，如 选品清单.md）", content: "必填，文件正文", mime: "可选，MIME 类型，默认按扩展名推断" },
  },
  {
    name: "file_read",
    title: "读取工作区文件",
    category: "file",
    description: "按 key 读取当前用户此前写入的工作区文件文本",
    params: { key: "必填，file_write 返回的 key", maxChars: "可选，最大字符数，默认 8000，上限 40000" },
  },
];

const EXT_WHITELIST = [".md", ".txt", ".csv", ".json", ".html", ".xml", ".log"];
const MIME_BY_EXT: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
};

export function workspaceRoot(): string {
  return env("WORKSPACE_DIR", "").trim() || join(process.cwd(), "uploads", "workspace");
}

export function maxBytes(): number {
  const value = Number(env("WORKSPACE_MAX_BYTES", "2000000"));
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 2000000;
}

/** 文件名白名单：中文/字母/数字/点/下划线/短横，长度 1-80，扩展名必须在白名单里。 */
export function safeFileName(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) throw new BadRequestException("name 必填");
  if (raw.length > 80) throw new BadRequestException("文件名过长（最多 80 字）");
  if (raw.includes("..") || raw.includes("/") || raw.includes("\\") || /[\u0000-\u001f]/.test(raw)) throw new BadRequestException("文件名不能包含路径分隔符或控制字符");
  if (!/^[\w\u4e00-\u9fa5.-]+$/.test(raw)) throw new BadRequestException("文件名只能包含中文、字母、数字、下划线、点与短横");
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) throw new BadRequestException("文件名必须带扩展名，可选：" + EXT_WHITELIST.join(" "));
  const ext = raw.slice(dot).toLowerCase();
  if (!EXT_WHITELIST.includes(ext)) throw new BadRequestException("不支持的文件类型 " + ext + "，可选：" + EXT_WHITELIST.join(" "));
  return raw;
}

/** 用户 workspace 前缀，读时用于防越权。 */
export function userPrefix(userId: string): string { return "workspace/" + userId + "/"; }

function ossClient() {
  const accessKeyId = env("OSS_ACCESS_KEY_ID", "");
  const accessKeySecret = env("OSS_ACCESS_KEY_SECRET", "");
  const bucket = env("OSS_BUCKET", "");
  const region = env("OSS_REGION", "");
  const endpoint = env("OSS_ENDPOINT", "");
  if (!accessKeyId || !accessKeySecret || !bucket || !region || !endpoint) return null;
  return new OSS({ region, accessKeyId, accessKeySecret, bucket, endpoint, secure: true });
}

function publicBase(): string { return env("PUBLIC_BASE_URL", "").replace(/\/$/, ""); }

/** key → 本地绝对路径；不是 workspace/<userId>/ 前缀的一律拒绝。 */
export function localPathFor(userId: string, key: string): string {
  const prefix = userPrefix(userId);
  if (!key.startsWith(prefix)) throw new BadRequestException("无权访问该文件");
  const rest = key.slice(prefix.length);
  if (!rest || rest.includes("/") || rest.includes("\\") || rest.includes("..")) throw new BadRequestException("文件 key 无效");
  return join(workspaceRoot(), userId, rest);
}

export const handlers = {
  file_write: async ({ userId, params }: any) => {
    const name = safeFileName(String(params.name ?? ""));
    const content = String(params.content ?? "");
    if (!content) throw new BadRequestException("content 必填");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > maxBytes()) throw new BadRequestException("文件超过 " + Math.trunc(maxBytes() / 1024) + "KB 限制");
    const dot = name.lastIndexOf(".");
    const ext = name.slice(dot).toLowerCase();
    const stored = randomUUID() + "-" + name;
    const key = userPrefix(userId) + stored;
    const path = join(workspaceRoot(), userId, stored);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
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
  file_read: async ({ userId, params }: any) => {
    const key = String(params.key ?? "").trim();
    if (!key) throw new BadRequestException("key 必填");
    const maxChars = Math.min(Math.max(Math.trunc(Number(params.maxChars) || 8000), 500), 40000);
    const path = localPathFor(userId, key);
    let text: string | null = null;
    try {
      text = await readFile(path, "utf8");
    } catch {
      const client = ossClient();
      if (client) {
        try {
          const result: any = await client.get(key);
          const buffer: Buffer = Buffer.isBuffer(result?.content) ? result.content : Buffer.from(result?.content ?? "");
          text = buffer.toString("utf8");
        } catch {
          text = null;
        }
      }
    }
    if (text === null) throw new BadRequestException("文件不存在或已被清理");
    const bytes = Buffer.byteLength(text, "utf8");
    const name = key.slice(key.lastIndexOf("/") + 1).replace(/^[0-9a-f-]{36}-/i, "");
    return { name, bytes, truncated: text.length > maxChars, text: text.slice(0, maxChars) };
  },
} as Record<string, CapabilityHandler>;
