import { Body, Controller, Get, HttpStatus, Post, Req, Res, UseGuards, UsePipes, ValidationPipe } from "@nestjs/common";
import type { Response } from "express";
import { ComputeAuthGuard } from "./compute-auth.guard";
import { ComputeService } from "./compute.service";
import { PrismaService } from "../prisma/prisma.service";
import { Public } from "../common/decorators";

@Public()
@Controller("compute")
@UseGuards(ComputeAuthGuard)
@UsePipes(new ValidationPipe({ whitelist: false, forbidNonWhitelisted: false, transform: false, skipMissingProperties: true }))
export class ComputeController {
  constructor(
    private compute: ComputeService,
    private prisma: PrismaService,
  ) {}

  @Post("chat/completions")
  async chatCompletions(@Req() req: any, @Res() res: Response) {
    const userId = req.user?.userId || req.user?.sub;
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
      const code = status === HttpStatus.PAYMENT_REQUIRED ? "INSUFFICIENT_CREDITS" : "COMPUTE_ERROR";
      if (!res.headersSent) {
        res.status(status).json({ error: { message, code } });
      } else {
        try {
          res.write(`data: ${JSON.stringify({ error: { message, code } })}\n\n`);
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