import { Body, Controller, Get, HttpStatus, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { ComputeService } from "./compute.service";
import { PrismaService } from "../prisma/prisma.service";
import { ComputeAuthGuard } from "./compute-auth.guard";
import { Public } from "../common/decorators";

/**
 * 原版：/volcengine-proxy/v3/* —— OpenAI 兼容透传口，供 openclaw 网关直接指向。
 * 同时接受 JWT 与 rrclaw-proxy- 代理令牌（网关用后者做 apiKey）。
 */
@Public()
@UseGuards(ComputeAuthGuard)
@Controller("volcengine-proxy/v3")
export class VolcengineProxyController {
  constructor(
    private compute: ComputeService,
    private prisma: PrismaService,
  ) {}

  @Post("chat/completions")
  async proxyChatCompletions(@Req() req: any, @Res() res: Response) {
    const userId = req.user?.userId || req.user?.sub || req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: { message: "未认证", code: "UNAUTHORIZED" } });
    }
    const body = req.body;
    const isStream = body?.stream === true;
    try {
      if (isStream) {
        await this.compute.processComputeStreamRequest(userId, body, res);
      } else {
        const result = await this.compute.processComputeRequest(userId, body);
        res.status(200).json(result);
      }
    } catch (err: any) {
      const message = err?.message || "内部服务器错误";
      const status = err?.status || err?.getStatus?.() || 500;
      if (!res.headersSent) {
        res.status(status).json({ error: { message, code: "COMPUTE_ERROR" } });
      } else {
        try {
          res.write(`data: ${JSON.stringify({ error: { message, code: "COMPUTE_ERROR" } })}\n\n`);
        } catch {
          /* ignore */
        }
        res.end();
      }
    }
  }

  @Get("models")
  async listModels(@Res() res: Response) {
    const pricings = await this.prisma.modelPricing.findMany({ where: { isActive: true } });
    const models = pricings.map((p) => ({
      id: p.modelId,
      name: p.modelName,
      pricingMode: p.pricingMode,
      pricePerRequest: p.pricePerRequest,
      pricePerInputToken: p.pricePerInputToken,
      pricePerOutputToken: p.pricePerOutputToken,
    }));
    res.status(200).json({ object: "list", data: models });
  }
}
