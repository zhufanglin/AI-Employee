import { Controller, Get, Logger, Param, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Public } from "../common/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { escapeHtml, renderResultPage, resultToken } from "./result-page";

/**
 * 渠道长结果页（T-11 后续：微信里看全文）
 *
 * URL：/api/channels/result/:taskId?t=<签名>
 * - 免鉴权（微信用户没有平台账号），靠 URL 里的 HMAC 签名做访问控制；
 * - 只读任务产出文本，不暴露用户信息、不提供任何写操作；
 * - 链接不过期（客户隔天还能点开），换 CHANNEL_RESULT_SECRET 可整体失效。
 */
@Controller("channels")
export class ChannelResultController {
  private readonly logger = new Logger("ChannelResultPage");

  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get("result/:taskId")
  async page(
    @Param("taskId") taskId: string,
    @Query("t") token: string,
    @Res() res: Response,
  ) {
    res.type("text/html; charset=utf-8");
    if (!taskId || String(token ?? "") !== resultToken(taskId)) {
      res.status(403).send(simplePage("链接无效", "这个链接缺少校验参数或者已经失效，请让 AI 员工重新发一次。"));
      return;
    }
    const task: any = await this.prisma.employeeTask.findUnique({ where: { id: taskId } });
    if (!task) {
      res.status(404).send(simplePage("结果不存在", "任务可能已被删除。"));
      return;
    }
    const content = await this.readText(taskId, task);
    if (!content) {
      res.status(404).send(simplePage("暂无产出", "这个任务还没有可展示的文本结果。"));
      return;
    }
    res.status(200).send(
      renderResultPage({
        title: typeof task.title === "string" && task.title.trim() ? task.title.trim() : "AI 员工运行结果",
        taskId,
        status: task.status,
        createdAt: task.createdAt ?? null,
        content,
      }),
    );
    this.logger.log("长结果页已访问 task=" + taskId + " chars=" + content.length);
  }

  /** 与 dispatcher 一致：先取 outputText，空则取第一个 artifact 的文本 */
  private async readText(taskId: string, task: any): Promise<string> {
    const direct = typeof task?.outputText === "string" ? task.outputText.trim() : "";
    if (direct) return direct;
    const artifact = await this.prisma.employeeTaskArtifact.findFirst({
      where: { taskId },
      orderBy: { createdAt: "asc" },
    });
    return typeof artifact?.text === "string" ? artifact.text.trim() : "";
  }
}

const PAGE_STYLE = [
  "body{margin:0;background:#f6f7f9;font:16px/1.7 -apple-system,sans-serif;color:#1f2329;}",
  ".box{max-width:520px;margin:80px auto;padding:28px 24px;background:#fff;border-radius:12px;text-align:center;}",
  "h1{font-size:19px;margin:0 0 12px;}p{color:#646a73;margin:0;}",
].join("");

function simplePage(title: string, message: string): string {
  return [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>" + escapeHtml(title) + "</title>",
    "<style>" + PAGE_STYLE + "</style></head><body>",
    '<div class="box"><h1>' + escapeHtml(title) + "</h1><p>" + escapeHtml(message) + "</p></div>",
    "</body></html>",
  ].join("\n");
}
