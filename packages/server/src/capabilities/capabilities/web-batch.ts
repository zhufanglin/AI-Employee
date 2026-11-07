import { BadRequestException } from "@nestjs/common";
import type { CapabilityDescriptor, CapabilityHandler } from "../capability.types";
import { handler as extractHandler } from "./web-extract";

/**
 * 批量网页正文提取：模型每一步只能调一次工具，单页 web_extract 在 10 步预算里最多读 7-8 页，
 * 做不了「扫一批链接」。这里一次抓 1-5 个 URL，逐条容错（单条失败不影响其它条）。
 */
export const descriptor: CapabilityDescriptor = {
  name: "web_batch",
  title: "批量网页正文提取",
  category: "web",
  description: "一次抓取最多 5 个 URL 的标题与正文纯文本，逐条返回，适合扫一批链接做汇总",
  params: {
    urls: "必填，http(s) 网址数组，1-5 个",
    maxChars: "可选，每个 URL 正文最大字符数，默认 4000，上限 12000",
    totalChars: "可选，全部正文合计字符上限，默认 12000，上限 30000",
  },
};

const MAX_URLS = 5;

function normUrls(input: any): string[] {
  const list = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[\s,]+/) : [];
  const clean: string[] = [];
  for (const item of list) {
    const url = String(item ?? "").trim();
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) throw new BadRequestException("urls 里必须是 http(s) 网址：" + url);
    clean.push(url);
  }
  return clean;
}

export type BatchExtractFn = (ctx: any) => Promise<any>;

export function buildHandler(extract: BatchExtractFn = extractHandler as any): CapabilityHandler {
  return async ({ userId, phone, params }: any) => {
    const urls = normUrls(params?.urls ?? params?.url);
    if (!urls.length) throw new BadRequestException("urls 必填，1-5 个 http(s) 网址");
    if (urls.length > MAX_URLS) throw new BadRequestException("一次最多抓 " + MAX_URLS + " 个网址，收到 " + urls.length + " 个");
    const perMax = Math.min(Math.max(Math.trunc(Number(params?.maxChars) || 4000), 500), 12000);
    const totalMax = Math.min(Math.max(Math.trunc(Number(params?.totalChars) || 12000), 1000), 30000);

    let budget = totalMax;
    const items: any[] = [];
    for (const url of urls) {
      if (budget <= 0) {
        items.push({ url, title: null, chars: 0, text: "", error: "已达总字数上限，未抓取" });
        continue;
      }
      const maxChars = Math.min(perMax, budget);
      try {
        const one: any = await extract({ userId, phone, params: { url, maxChars } });
        const text = String(one?.text ?? "");
        const title = one?.title ? String(one.title) : null;
        budget -= text.length;
        items.push({ url, title, chars: text.length, text, truncated: Boolean(one?.truncated) });
      } catch (error: any) {
        const message = error?.response?.message ?? error?.message ?? "抓取失败";
        items.push({ url, title: null, chars: 0, text: "", error: String(message).slice(0, 200) });
      }
    }

    const ok = items.filter(item => !item.error).length;
    return {
      total: items.length,
      ok,
      failed: items.length - ok,
      chars: items.reduce((sum, item) => sum + item.chars, 0),
      items,
    };
  };
}

export const handler = buildHandler();
