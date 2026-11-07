import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import type { Response } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { CreditsService } from "../billing/credits.service";
import { PricingService } from "../billing/pricing.service";
import { QuotaService } from "../billing/quota.service";
import { ProvidersService } from "../providers/providers.service";

@Injectable()
export class ComputeService {
  private readonly logger = new Logger(ComputeService.name);

  constructor(
    private prisma: PrismaService,
    private credits: CreditsService,
    private pricing: PricingService,
    private quota: QuotaService,
    private providers: ProvidersService,
  ) {}

  async processComputeRequest(userId: string, body: any) {
    const model: string = body?.model;
    if (!model) throw new BadRequestException("缺少模型参数");

    const [balance, monthlyUsage] = await Promise.all([
      this.credits.getBalance(userId),
      this.quota.getMonthlyUsage(userId),
    ]);
    if (monthlyUsage.quotaRemaining <= 0 && balance.balance <= 0) {
      throw new HttpException("算力不足，请充值", HttpStatus.PAYMENT_REQUIRED);
    }
    if (monthlyUsage.quotaRemaining <= 0) {
      const minPrice = await this.pricing.calculatePrice(model, 0, 0);
      if (balance.balance < minPrice) throw new HttpException("算力不足，请充值", HttpStatus.PAYMENT_REQUIRED);
    }

    const target = await this.providers.resolve(model);
    const agentResponse = await this.providers.chat(target, { ...body, stream: false });

    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    if (agentResponse?.usage) {
      inputTokens = agentResponse.usage.prompt_tokens || agentResponse.usage.inputTokens || 0;
      outputTokens = agentResponse.usage.completion_tokens || agentResponse.usage.outputTokens || 0;
      totalTokens =
        agentResponse.usage.total_tokens ||
        agentResponse.usage.totalTokens ||
        inputTokens + outputTokens;
    }
    const requestId = `req_${Date.now()}_${userId.substring(0, 8)}`;
    await this.processBilling(userId, model, inputTokens, outputTokens, totalTokens, requestId);
    return agentResponse;
  }

  async processComputeStreamRequest(userId: string, body: any, res: Response) {
    const model: string = body?.model;
    if (!model) throw new BadRequestException("缺少模型参数");

    const [balance, monthlyUsage] = await Promise.all([
      this.credits.getBalance(userId),
      this.quota.getMonthlyUsage(userId),
    ]);
    if (monthlyUsage.quotaRemaining <= 0 && balance.balance <= 0) {
      throw new HttpException("算力不足，请充值", HttpStatus.PAYMENT_REQUIRED);
    }

    // 免费额度优先：额度内不预扣积分
    const quotaPath = monthlyUsage.quotaRemaining > 0;
    let preDeductCredits = 0;
    let preDeductTxId: string | undefined;
    if (!quotaPath) {
      try {
        preDeductCredits = await this.pricing.calculatePrice(model, 0, 0);
      } catch {
        preDeductCredits = 1;
      }
      if (balance.balance < preDeductCredits) {
        throw new HttpException("算力不足，请充值", HttpStatus.PAYMENT_REQUIRED);
      }
      // 预扣也走流水，保证余额与 creditTransaction 永远对得上（原版是裸 update，无流水）
      const tx = await this.credits.consumeCredits(userId, preDeductCredits, `AI调用预扣: ${model}`);
      preDeductTxId = tx.id;
    }

    const target = await this.providers.resolve(model);
    // 让上游在最后一个 SSE 包里带 usage，否则流式请求记 0 token（与原版缺陷一致，这里修掉）
    const streamBody = { ...body, stream: true, stream_options: { ...(body.stream_options || {}), include_usage: true } };
    const upstream = await this.providers.streamChat(target, streamBody);

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const chunks: string[] = [];
    const decoder = new TextDecoder();
    let interrupted = false;
    try {
      // 同时兼容 Node 18+ 的 web ReadableStream 异步迭代
      for await (const value of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        const chunk = decoder.decode(value, { stream: true });
        chunks.push(chunk);
        res.write(chunk);
      }
    } catch (err: any) {
      interrupted = true;
      this.logger.error("Stream read interrupted: " + (err?.message || err));
      try {
        res.write(`data: ${JSON.stringify({ error: { message: "流式传输中断", code: "STREAM_INTERRUPTED" } })}\n\n`);
      } catch {
        /* ignore */
      }
    } finally {
      res.end();
    }

    const usage = this.extractUsageFromStream(chunks);
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const totalTokens = usage?.totalTokens ?? inputTokens + outputTokens;

    // 结算规则（用户 2026-11-04 确认）：
    // 1) 有实际 usage（含中断前已产生的部分）→ 按实际用量计费；
    // 2) 上游未返回 usage → 本次不计费，记录标记待核对，人工可补扣。
    let actualCredits = 0;
    let needsReview = false;
    let reviewNote: string | undefined;
    let isPartialDeduct = false;
    if (!usage) {
      needsReview = true;
      actualCredits = 0;
      reviewNote = interrupted
        ? "流式中断且上游未返回实际用量，本次不计费，待核对"
        : "上游未返回实际用量，本次不计费，待核对";
    } else {
      try {
        actualCredits = await this.pricing.calculatePrice(model, inputTokens, outputTokens);
      } catch (err: any) {
        this.logger.error("calculatePrice failed, fallback to pre-deduct: " + (err?.message || err));
        actualCredits = preDeductCredits;
      }
    }

    // 余额封顶（用户 2026-11-05 决定）：实际费用 > 余额时只扣到余额，差额不向客户追扣。
    let chargedCredits = 0;
    if (!quotaPath) {
      chargedCredits = Math.min(actualCredits, preDeductCredits);
      const diff = actualCredits - preDeductCredits;
      if (diff > 0) {
        try {
          const extra = await this.credits.consumeCreditsWithPartial(userId, diff, `AI调用补扣: ${model}`);
          chargedCredits = preDeductCredits + extra.actualAmount;
          if (extra.actualAmount < diff) {
            isPartialDeduct = true;
            reviewNote = reviewNote ?? "余额不足，已按余额封顶扣费，差额未追扣";
          }
        } catch (err: any) {
          this.logger.error("补充扣费失败，标记待核对: " + (err?.message || err));
          needsReview = true;
          reviewNote = reviewNote ?? "差额补扣失败，待核对";
        }
      } else if (diff < 0) {
        await this.credits.addCredits(userId, Math.abs(diff), "refund", `AI调用退回: ${model}`);
        chargedCredits = actualCredits;
      }
    }

    const requestId = `req_${Date.now()}_${userId.substring(0, 8)}`;
    await this.processBilling(userId, model, inputTokens, outputTokens, totalTokens, requestId, {
      creditsOverride: quotaPath ? 0 : actualCredits,
      preCharged: quotaPath ? undefined : chargedCredits,
      preChargeTxId: preDeductTxId,
      needsReview,
      reviewNote,
      isPartialDeduct,
    });
    this.logger.log(
      `Stream complete for user ${userId}, credits charged: ${quotaPath ? 0 : chargedCredits}${isPartialDeduct ? " (capped)" : ""}${needsReview ? " (needs review)" : ""}`,
    );
  }

  extractUsageFromStream(chunks: string[]) {
    const fullText = chunks.join("");
    const lines = fullText.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.usage) {
          return {
            inputTokens: parsed.usage.prompt_tokens || 0,
            outputTokens: parsed.usage.completion_tokens || 0,
            totalTokens: parsed.usage.total_tokens || 0,
          };
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  async processBilling(
    userId: string,
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    totalTokens: number,
    requestId: string,
    opts: {
      creditsOverride?: number;
      preCharged?: number;
      preChargeTxId?: string;
      needsReview?: boolean;
      reviewNote?: string;
      isPartialDeduct?: boolean;
    } = {},
  ) {
    let price = 1;
    let pricingMode = "per_request";
    try {
      price = opts.creditsOverride ?? (await this.pricing.calculatePrice(modelId, inputTokens, outputTokens));
      const pricing = await this.pricing.getPricing(modelId);
      pricingMode = pricing.pricingMode;
    } catch (err: any) {
      this.logger.error("getPricing failed, using defaults: " + (err?.message || err));
    }

    let creditsCharged = 0;
    let isPartialDeduct = opts.isPartialDeduct ?? false;
    let creditTransactionId: string | undefined;

    const monthlyUsage = await this.quota.getMonthlyUsage(userId);
    if (opts.preCharged !== undefined) {
      // 流式请求已在预扣/补扣阶段结算，这里只记账，绝不二次扣款
      creditsCharged = opts.preCharged;
      creditTransactionId = opts.preChargeTxId;
    } else if (monthlyUsage.quotaRemaining > 0) {
      await this.quota.consumeQuota(userId);
      creditsCharged = 0;
    } else if (price > 0) {
      try {
        const tx = await this.credits.consumeCredits(userId, price, `AI调用: ${modelId}`);
        creditsCharged = price;
        creditTransactionId = tx.id;
      } catch {
        try {
          const result = await this.credits.consumeCreditsWithPartial(userId, price, `AI调用(部分扣费): ${modelId}`);
          creditsCharged = result.actualAmount;
          isPartialDeduct = result.isPartialDeduct;
          creditTransactionId = result.transaction.id;
        } catch (deductErr: any) {
          this.logger.error("consumeCreditsWithPartial failed: " + (deductErr?.message || deductErr));
          isPartialDeduct = true;
        }
      }
    }

    await this.prisma.aiUsageRecord.create({
      data: {
        userId,
        modelId,
        inputTokens,
        outputTokens,
        totalTokens,
        creditsCharged,
        pricingMode,
        requestId,
        isPartialDeduct,
        creditTransactionId,
        needsReview: opts.needsReview ?? false,
        reviewNote: opts.reviewNote ?? null,
      },
    });
  }
}
