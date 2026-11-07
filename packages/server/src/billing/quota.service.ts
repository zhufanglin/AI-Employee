import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class QuotaService {
  constructor(private prisma: PrismaService) {}

  async getFreeQuota(): Promise<number> {
    const siteConfig = await this.prisma.siteConfig.findFirst();
    return siteConfig?.freeMonthlyQuota ?? 10;
  }

  /** 本期无订阅系统（P2），额度=站点免费额度 */
  async getUserQuotaLimit(_userId: string): Promise<number> {
    return this.getFreeQuota();
  }

  async getMonthlyUsage(userId: string) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const usage = await this.prisma.userMonthlyUsage.findUnique({
      where: { userId_year_month: { userId, year, month } },
    });
    if (usage) {
      return {
        quotaLimit: usage.quotaLimit,
        quotaUsed: usage.quotaUsed,
        quotaRemaining: usage.quotaRemaining,
        resetAt: usage.resetAt,
      };
    }
    const quotaLimit = await this.getUserQuotaLimit(userId);
    const resetAt = new Date(year, month, 1);
    const created = await this.prisma.userMonthlyUsage.create({
      data: { userId, year, month, quotaLimit, quotaUsed: 0, quotaRemaining: quotaLimit, resetAt },
    });
    return {
      quotaLimit: created.quotaLimit,
      quotaUsed: created.quotaUsed,
      quotaRemaining: created.quotaRemaining,
      resetAt: created.resetAt,
    };
  }

  async checkQuota(userId: string): Promise<boolean> {
    const usage = await this.getMonthlyUsage(userId);
    return usage.quotaRemaining > 0;
  }

  async consumeQuota(userId: string): Promise<void> {
    if (!(await this.checkQuota(userId))) {
      throw new HttpException("本月AI调用次数已用完，请升级会员或等待下月重置", HttpStatus.PAYMENT_REQUIRED);
    }
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    await this.prisma.userMonthlyUsage.update({
      where: { userId_year_month: { userId, year, month } },
      data: { quotaUsed: { increment: 1 }, quotaRemaining: { decrement: 1 } },
    });
  }
}
