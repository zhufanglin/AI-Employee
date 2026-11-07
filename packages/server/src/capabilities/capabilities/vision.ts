import { BadRequestException } from "@nestjs/common";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { CapabilityDescriptor, CapabilityHandler } from "../capability.types";
import type { ProvidersService } from "../../providers/providers.service";
import { env } from "../../common/env";
import { readWorkspaceBytes, resolveWorkspaceFile, ossPublicUrl } from "./files";
import { isDenied, pickPublicAddress } from "./web-extract";

/** 视觉能力：把用户工作区里的图片（或公网图片链接）交给多模态模型理解。 */
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_QUESTION = "用中文详细描述这张图片：主体、场景、画面上的文字（逐字抄写）、整体风格与可能的用途。";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

export const descriptors: CapabilityDescriptor[] = [
  {
    name: "image_understand",
    title: "看图理解",
    category: "ai",
    description: "把一张图片交给多模态模型，回答关于图片的问题（识别内容、抄写文字、判断风格）。图片可以是工作区文件，也可以是公网链接",
    params: {
      source: "必填，工作区图片文件名或 key，或 http(s) 图片链接",
      question: "可选，想问的问题；缺省为详细描述图片内容",
      model: "可选，模型别名；缺省用 VISION_MODEL_ALIAS（默认 doubao-seed-2.0-lite）",
    },
  },
];

async function publicUrlOf(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException("图片链接不合法");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new BadRequestException("图片链接只支持 http/https");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  if (family) {
    if (isDenied(host, family)) throw new BadRequestException("该地址不允许访问");
    return url;
  }
  let addresses: Array<{ address: string; family: number }> = [];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new BadRequestException("图片链接的域名解析失败");
  }
  let chosen: { address: string; family: number } | null = null;
  try {
    chosen = pickPublicAddress(addresses);
  } catch {
    chosen = null;
  }
  if (!chosen) throw new BadRequestException("该地址不允许访问");
  return url;
}

export function buildVisionHandlers(providers: ProvidersService): Record<string, CapabilityHandler> {
  return {
    image_understand: async ({ userId, params }: any) => {
      const source = String(params?.source ?? "").trim();
      if (!source) throw new BadRequestException("source 必填，请给工作区图片文件名或 http(s) 链接");
      const question = String(params?.question ?? "").trim() || DEFAULT_QUESTION;
      const alias = String(params?.model ?? "").trim() || env("VISION_MODEL_ALIAS", "doubao-seed-2.0-lite");

      let imageUrl = "";
      let detail: { name: string; bytes: number; kind: string };

      if (/^https?:\/\//i.test(source)) {
        const url = await publicUrlOf(source);
        imageUrl = url.toString();
        detail = { name: url.pathname.split("/").pop() || "remote-image", bytes: 0, kind: "url" };
      } else {
        const locator = source.startsWith("workspace/") ? { key: source } : { name: source };
        const file = await resolveWorkspaceFile(userId, locator);
        if (!file) throw new BadRequestException("工作区里找不到这张图片，可先用 file_list 查看已有文件");
        if (!IMAGE_EXTS.includes(file.ext)) throw new BadRequestException("只支持图片文件：" + IMAGE_EXTS.join("、"));
        if (file.bytes > MAX_IMAGE_BYTES) throw new BadRequestException("图片超过 8MB，请先压缩后再试");
        const bytes = await readWorkspaceBytes(userId, file);
        const publicUrl = ossPublicUrl(file.key);
        imageUrl = publicUrl || "data:" + (MIME_BY_EXT[file.ext] || "image/jpeg") + ";base64," + bytes.toString("base64");
        detail = { name: file.name, bytes: bytes.byteLength, kind: publicUrl ? "url" : "inline" };
      }

      const target = await providers.resolve(alias);
      const payload = await providers.chat(target, {
        model: target.upstreamModel,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: question },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
        max_tokens: 1500,
        temperature: 0.3,
      } as any);
      const text = payload?.choices?.[0]?.message?.content;
      const answer = typeof text === "string" ? text.trim() : Array.isArray(text) ? text.map((part: any) => part?.text ?? "").join("") : "";
      if (!answer) throw new BadRequestException("模型没有返回可读内容，请换个问题或换张图片重试");
      const usage = payload?.usage || null;
      return { model: alias, text: answer, source: detail, usage };
    },
  };
}
