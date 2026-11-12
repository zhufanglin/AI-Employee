import { Body, Controller, Get, NotFoundException, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { Public } from "../common/decorators";
import { LEGAL_DOCS, LEGAL_VERSION, OPERATOR, legalIndex } from "./legal.pages";
import type { LegalDoc } from "./legal.pages";
import { ReportService } from "./report.service";

/**
 * 合规文本公开页（P45 合规基线）
 *
 * - 全部 @Public：微信浏览器、支付审核、应用市场审核都会直接打开；
 * - HTML 走服务端渲染（不依赖前端构建产物），桌面端「设置」里也可直接 openExternal；
 * - ?format=json 返回结构化正文，供客户端内置展示/离线缓存。
 */

const PAGE_STYLE = [
  "body{margin:0;background:#f6f7f9;font:16px/1.75 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#1f2329;}",
  ".wrap{max-width:760px;margin:0 auto;padding:28px 20px 60px;}",
  ".card{background:#fff;border-radius:12px;padding:28px 22px;box-shadow:0 1px 3px rgba(0,0,0,.05);}",
  "h1{font-size:22px;margin:0 0 6px;}",
  ".meta{color:#8f959e;font-size:13px;margin:0 0 22px;}",
  "h2{font-size:16px;margin:26px 0 8px;}",
  "p{margin:8px 0;color:#3b3f45;}",
  "ul{margin:8px 0;padding-left:22px;color:#3b3f45;}",
  "li{margin:4px 0;}",
  ".notice{background:#fff7e6;border:1px solid #ffe4b5;color:#8a5a00;border-radius:8px;padding:10px 12px;font-size:13px;margin:18px 0 0;}",
  ".nav{margin-top:22px;font-size:13px;color:#8f959e;}",
  ".nav a{color:#3b7cff;text-decoration:none;margin-right:12px;}",
  ".foot{margin-top:18px;font-size:12px;color:#a8adb4;line-height:1.9;}",
].join("");

/** 取真实客户端 IP：生产在 nginx 后面，优先 X-Forwarded-For 第一段 */
function clientIp(req: any): string {
  const headers = (req && req.headers) || {};
  const fwd = String(headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (fwd) return fwd;
  const real = String(headers["x-real-ip"] || "").trim();
  if (real) return real;
  return String((req && req.ip) || "");
}

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderDoc(doc: LegalDoc): string {
  const body: string[] = [];
  body.push('<div class="wrap"><div class="card">');
  body.push("<h1>" + esc(doc.title) + "</h1>");
  body.push(
    '<p class="meta">' +
      esc(OPERATOR.productName) +
      " · 版本 " +
      esc(doc.version) +
      " · 更新日期 " +
      esc(doc.updatedAt) +
      "</p>",
  );
  body.push("<p>" + esc(doc.preamble) + "</p>");
  for (const sec of doc.sections) {
    body.push("<h2>" + esc(sec.heading) + "</h2>");
    for (const p of sec.paragraphs ?? []) body.push("<p>" + esc(p) + "</p>");
    if (sec.bullets?.length) {
      body.push("<ul>");
      for (const b of sec.bullets) body.push("<li>" + esc(b) + "</li>");
      body.push("</ul>");
    }
  }
  body.push(
    '<div class="notice">本页为对外公开的正式文本。若你需要盖章版或纸质版，请联系 ' +
      esc(OPERATOR.email) +
      "。</div>",
  );
  body.push(
    '<div class="nav"><a href="/api/legal/terms">用户协议</a><a href="/api/legal/privacy">隐私政策</a><a href="/api/legal/aigc">AI 生成内容标识说明</a></div>',
  );
  body.push(
    '<div class="foot">' +
      esc(OPERATOR.company) +
      " · " +
      esc(OPERATOR.domain) +
      "<br/>客服邮箱 " +
      esc(OPERATOR.email) +
      " · 客服电话 " +
      esc(OPERATOR.phone) +
      "</div>",
  );
  body.push("</div></div>");
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
    "<title>" +
    esc(doc.title) +
    " - " +
    esc(OPERATOR.productName) +
    "</title><style>" +
    PAGE_STYLE +
    "</style></head><body>" +
    body.join("\n") +
    "</body></html>"
  );
}

@Controller("legal")
export class LegalController {
  constructor(private readonly reports: ReportService) {}

  /** 目录 + 版本号（客户端用它判断是否需要重新弹同意） */
  @Public()
  @Get()
  index(@Query("format") format?: string) {
    if (format === "json") {
      return { ...legalIndex(), docs: LEGAL_DOCS };
    }
    return legalIndex();
  }

  /** 举报类别清单（桌面端「举报与投诉」下拉用） */
  @Public()
  @Get("report/categories")
  reportCategories() {
    return { categories: this.reports.categories() };
  }

  /**
   * 举报与投诉提交（P45-4）。
   * 必须 @Public：未登录用户、被侵权人、审核机构都要能提交；有 token 时自动带上 userId。
   * 限流：同一 IP 每小时 10 次（进程内计数）。
   */
  @Public()
  @Post("report")
  async report(@Body() body: any, @Req() req: any) {
    const user = req && req.user;
    return this.reports.submit(body || {}, {
      userId: user && user.id,
      ip: clientIp(req),
      userAgent: req && req.headers ? String(req.headers["user-agent"] || "") : "",
    });
  }

  @Public()
  @Get(":key")
  page(@Param("key") key: string, @Query("format") format: string | undefined, @Res() res: Response) {
    const doc = LEGAL_DOCS[String(key ?? "").toLowerCase()];
    if (!doc) {
      const err = new NotFoundException("没有这份文本");
      res.status(err.getStatus()).type("application/json").send({ ok: false, error: "没有这份文本" });
      return;
    }
    if (format === "json") {
      res.status(200).type("application/json").send(doc);
      return;
    }
    res.status(200).type("text/html; charset=utf-8").send(renderDoc(doc));
  }
}
