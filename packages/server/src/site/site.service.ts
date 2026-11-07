import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SiteService {
  constructor(private readonly prisma: PrismaService) {}

  /** 客户端启动时拉取的公开站点配置（不含任何密钥） */
  async publicConfig() {
    const [site, packages, models] = await Promise.all([
      this.prisma.siteConfig.findFirst(),
      this.prisma.creditPackage.findMany({ where: { isActive: true }, orderBy: { sort: "asc" } }),
      this.prisma.modelPricing.findMany({ where: { isActive: true }, orderBy: { modelId: "asc" } }),
    ]);
    return {
      siteName: site?.siteName ?? "AI员工",
      defaultModelDisplayName: site?.defaultModelDisplayName ?? "40+模型自动切换",
      defaultProviderName: site?.defaultProviderName ?? "超级大模型",
      customerServiceQrCodeUrl: site?.customerServiceQrCodeUrl ?? "",
      aiApiChatModel: site?.aiApiChatModel ?? "",
      aiApiImageModel: site?.aiApiImageModel ?? "",
      freeMonthlyQuota: site?.freeMonthlyQuota ?? 10,
      smsLoginEnabled: site?.smsLoginEnabled ?? true,
      winClientUrl: site?.winClientUrl ?? "",
      macClientUrl: site?.macClientUrl ?? "",
      activeVolcPlanType: site?.activeVolcPlanType ?? "coding",
      codingPlanDefaultModel: site?.codingPlanDefaultModel ?? "",
      agentPlanDefaultModel: site?.agentPlanDefaultModel ?? "",
      creditPackages: packages.map((p) => ({
        id: p.id, name: p.name, credits: p.credits, price: p.price,
        priceDisplay: p.priceDisplay, description: p.description,
      })),
      models: models.map((m) => ({
        modelId: m.modelId, modelName: m.modelName,
        pricingMode: m.pricingMode, pricePerRequest: m.pricePerRequest,
      })),
    };
  }
}
