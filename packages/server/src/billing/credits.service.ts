import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export interface TransactionQuery {
  page?: number;
  limit?: number;
  type?: string;
  startDate?: string;
  endDate?: string;
  modelId?: string;
}

@Injectable()
export class CreditsService {
  constructor(private prisma: PrismaService) {}

  async getBalance(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { credits: true, totalCreditsConsumed: true, totalCreditsRecharged: true },
    });
    return {
      balance: user?.credits ?? 0,
      totalConsumed: user?.totalCreditsConsumed ?? 0,
      totalRecharged: user?.totalCreditsRecharged ?? 0,
    };
  }

  async getTransactions(userId: string, query: TransactionQuery) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;
    const where: any = { userId };
    if (query.type) where.type = query.type;
    if (query.startDate || query.endDate) {
      where.createdAt = {};
      if (query.startDate) where.createdAt.gte = new Date(query.startDate);
      if (query.endDate) where.createdAt.lte = new Date(query.endDate);
    }
    const [items, total] = await Promise.all([
      this.prisma.creditTransaction.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: limit }),
      this.prisma.creditTransaction.count({ where }),
    ]);
    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async addCredits(userId: string, amount: number, type: string, description: string, relatedOrderId?: string, createdBy?: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM User WHERE id = ${userId} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new Error("User not found");
      const balanceBefore = user.credits;
      const balanceAfter = balanceBefore + amount;
      await tx.user.update({
        where: { id: userId },
        data: {
          credits: balanceAfter,
          ...(type === "recharge" || type === "gift" ? { totalCreditsRecharged: { increment: amount } } : {}),
          ...(type === "consume" ? { totalCreditsConsumed: { increment: Math.abs(amount) } } : {}),
        },
      });
      return tx.creditTransaction.create({
        data: { userId, type, amount, balanceBefore, balanceAfter, description, relatedOrderId, createdBy },
      });
    });
  }

  async consumeCredits(userId: string, amount: number, description: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM User WHERE id = ${userId} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new Error("User not found");
      if (user.credits < amount) throw new HttpException("算力不足，请充值", HttpStatus.PAYMENT_REQUIRED);
      const balanceBefore = user.credits;
      const balanceAfter = balanceBefore - amount;
      await tx.user.update({
        where: { id: userId },
        data: { credits: balanceAfter, totalCreditsConsumed: { increment: amount } },
      });
      return tx.creditTransaction.create({
        data: { userId, type: "consume", amount: -amount, balanceBefore, balanceAfter, description },
      });
    });
  }

  async consumeCreditsWithPartial(userId: string, amount: number, description: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM User WHERE id = ${userId} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new Error("User not found");
      const isPartialDeduct = user.credits < amount;
      const actualAmount = isPartialDeduct ? user.credits : amount;
      if (actualAmount === 0) throw new HttpException("算力不足，请充值", HttpStatus.PAYMENT_REQUIRED);
      const balanceBefore = user.credits;
      const balanceAfter = balanceBefore - actualAmount;
      await tx.user.update({
        where: { id: userId },
        data: { credits: balanceAfter, totalCreditsConsumed: { increment: actualAmount } },
      });
      const transaction = await tx.creditTransaction.create({
        data: { userId, type: "consume", amount: -actualAmount, balanceBefore, balanceAfter, description },
      });
      return { transaction, isPartialDeduct, actualAmount };
    });
  }

  async getAiUsageRecords(userId: string, query: TransactionQuery) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;
    const where: any = { userId };
    if (query.modelId) where.modelId = query.modelId;
    if (query.startDate || query.endDate) {
      where.createdAt = {};
      if (query.startDate) where.createdAt.gte = new Date(query.startDate);
      if (query.endDate) where.createdAt.lte = new Date(query.endDate);
    }
    const [items, total, modelPricings] = await Promise.all([
      this.prisma.aiUsageRecord.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: limit }),
      this.prisma.aiUsageRecord.count({ where }),
      this.prisma.modelPricing.findMany({ select: { modelId: true, modelName: true } }),
    ]);
    const modelNameMap = new Map(modelPricings.map((m) => [m.modelId, m.modelName]));
    return {
      items: items.map((i) => ({ ...i, modelName: modelNameMap.get(i.modelId) || null })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getUserAiUsageStats(userId: string, query: TransactionQuery) {
    const where: any = { userId };
    if (query.startDate || query.endDate) {
      where.createdAt = {};
      if (query.startDate) where.createdAt.gte = new Date(query.startDate);
      if (query.endDate) where.createdAt.lte = new Date(query.endDate);
    }
    const [agg, byModel, modelPricings, daily] = await Promise.all([
      this.prisma.aiUsageRecord.aggregate({
        where,
        _sum: { totalTokens: true, creditsCharged: true, inputTokens: true, outputTokens: true },
        _count: true,
      }),
      this.prisma.aiUsageRecord.groupBy({
        by: ["modelId"],
        where,
        _sum: { totalTokens: true, creditsCharged: true },
        _count: true,
      }),
      this.prisma.modelPricing.findMany({ select: { modelId: true, modelName: true } }),
      this.prisma.aiUsageRecord.findMany({
        where,
        select: { createdAt: true, totalTokens: true, creditsCharged: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    const nameMap = new Map(modelPricings.map((m) => [m.modelId, m.modelName]));
    const dailyMap = new Map<string, { date: string; requests: number; totalTokens: number; creditsCharged: number }>();
    for (const rec of daily) {
      const date = rec.createdAt.toISOString().slice(0, 10);
      const cur = dailyMap.get(date) || { date, requests: 0, totalTokens: 0, creditsCharged: 0 };
      cur.requests += 1;
      cur.totalTokens += rec.totalTokens;
      cur.creditsCharged += rec.creditsCharged;
      dailyMap.set(date, cur);
    }
    return {
      totalRequests: agg._count,
      totalTokens: agg._sum.totalTokens || 0,
      totalInputTokens: agg._sum.inputTokens || 0,
      totalOutputTokens: agg._sum.outputTokens || 0,
      totalCreditsCharged: agg._sum.creditsCharged || 0,
      byModel: byModel.map((m) => ({
        modelId: m.modelId,
        modelName: nameMap.get(m.modelId) || null,
        requests: typeof m._count === "number" ? m._count : (m._count as any).modelId,
        totalTokens: m._sum.totalTokens || 0,
        creditsCharged: m._sum.creditsCharged || 0,
      })),
      daily: Array.from(dailyMap.values()),
    };
  }
}
