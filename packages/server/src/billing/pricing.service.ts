import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class PricingService {
  constructor(private prisma: PrismaService) {}

  async getPricing(modelId: string) {
    const pricing = await this.prisma.modelPricing.findUnique({ where: { modelId } });
    if (!pricing) {
      return {
        modelId,
        pricingMode: "per_request",
        pricePerRequest: 1,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
      };
    }
    return pricing;
  }

  /** 与原版 VolcPricingService 一致：按条 / 按千 token，最低 1 积分 */
  async calculatePrice(modelId: string, inputTokens: number, outputTokens: number): Promise<number> {
    const pricing = await this.prisma.modelPricing.findUnique({ where: { modelId } });
    if (!pricing) return 1;
    let price: number;
    if (pricing.pricingMode === "per_token") {
      price = Math.ceil(
        (inputTokens / 1000) * pricing.pricePerInputToken +
          (outputTokens / 1000) * pricing.pricePerOutputToken,
      );
    } else {
      price = pricing.pricePerRequest;
    }
    return Math.max(price, 1);
  }
}
