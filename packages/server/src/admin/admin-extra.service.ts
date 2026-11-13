import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomInt } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PricingService } from "../billing/pricing.service";
import { PackageService } from "../employee/package.service";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import { SmsSender, invalidateSmsConfigCache } from "../auth/sms.sender";
import { invalidateWechatPayConfigCache } from "../payments/wechat-pay.service";

/** 密钥类字段一律脱敏返回；写入时空值或含 **** 视为“不修改”。 */
function mask(v?: string | null): string {
  if (!v) return "";
  if (v.length <= 8) return "****";
  return v.slice(0, 4) + "****" + v.slice(-4);
}
function unwrap(v?: string | null): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  if (!s.trim()) return undefined;
  if (s.includes("****")) return undefined;
  return s;
}
function dayStart(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

@Injectable()
export class AdminExtraService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly packages: PackageService,
    private readonly sms: SmsSender,
    private readonly pricing: PricingService,
  ) {}

  // ================= 站点 / 集成配置 =================
  async getSiteConfig() {
    const c = await this.prisma.siteConfig.findFirst({ orderBy: { createdAt: "asc" } });
    const models = await this.prisma.modelPricing.findMany({ where: { isActive: true }, orderBy: { modelId: "asc" } });
    const info = await this.prisma.systemInfo.findFirst();
    return {
      siteName: c?.siteName ?? "AI员工",
      defaultProviderName: c?.defaultProviderName ?? "",
      defaultModelDisplayName: c?.defaultModelDisplayName ?? "",
      customerServiceQrCodeUrl: c?.customerServiceQrCodeUrl ?? "",
      freeMonthlyQuota: c?.freeMonthlyQuota ?? 10,
      winClientUrl: c?.winClientUrl ?? "",
      macClientUrl: c?.macClientUrl ?? "",
      volcengineModels: models.map((m) => ({ modelId: m.modelId, modelName: m.modelName })),
      activeVolcPlanType: c?.activeVolcPlanType ?? "coding",
      codingPlanDefaultModel: c?.codingPlanDefaultModel ?? "",
      agentPlanDefaultModel: c?.agentPlanDefaultModel ?? "",
      agentPlanAfpToCreditsRate: info?.agentPlanAfpToCreditsRate ?? 5,
      agentQuoteRateToAdmin: info?.agentQuoteRateToAdmin ?? 0.005,
      smsLoginEnabled: c?.smsLoginEnabled ?? true,
      voiceAsrApiKey: mask(c?.voiceAsrApiKey),
    };
  }

  async updateSiteConfig(body: any) {
    const c = await this.prisma.siteConfig.findFirst({ orderBy: { createdAt: "asc" } });
    if (!c) throw new NotFoundException("站点配置不存在");
    const data: any = {};
    const strFields = [
      "siteName",
      "defaultProviderName",
      "defaultModelDisplayName",
      "customerServiceQrCodeUrl",
      "winClientUrl",
      "macClientUrl",
      "activeVolcPlanType",
      "codingPlanDefaultModel",
      "agentPlanDefaultModel",
    ] as const;
    for (const f of strFields) if (body?.[f] !== undefined) data[f] = String(body[f]);
    if (body?.freeMonthlyQuota !== undefined) data.freeMonthlyQuota = Math.max(0, Math.trunc(Number(body.freeMonthlyQuota)));
    if (body?.smsLoginEnabled !== undefined) data.smsLoginEnabled = Boolean(body.smsLoginEnabled);
    const asr = unwrap(body?.voiceAsrApiKey);
    if (asr) data.voiceAsrApiKey = asr;
    await this.prisma.siteConfig.update({ where: { id: c.id }, data });
    const info = await this.prisma.systemInfo.findFirst();
    if (info) {
      const iData: any = {};
      if (body?.agentPlanAfpToCreditsRate !== undefined) iData.agentPlanAfpToCreditsRate = Number(body.agentPlanAfpToCreditsRate);
      if (body?.agentQuoteRateToAdmin !== undefined) iData.agentQuoteRateToAdmin = Number(body.agentQuoteRateToAdmin);
      if (Object.keys(iData).length) await this.prisma.systemInfo.update({ where: { id: info.id }, data: iData });
    }
    return { message: "站点配置已保存" };
  }

  async getAiApiConfig() {
    const c = await this.prisma.siteConfig.findFirst({ orderBy: { createdAt: "asc" } });
    return {
      configured: Boolean(c?.aiApiBaseUrl && c?.aiApiToken),
      aiApiToken: mask(c?.aiApiToken),
      aiApiBaseUrl: c?.aiApiBaseUrl ?? "",
      aiApiChatModel: c?.aiApiChatModel ?? "",
      aiApiImageModel: c?.aiApiImageModel ?? "",
    };
  }

  async updateAiApiConfig(body: any) {
    const c = await this.prisma.siteConfig.findFirst({ orderBy: { createdAt: "asc" } });
    if (!c) throw new NotFoundException("站点配置不存在");
    const data: any = {};
    for (const f of ["aiApiBaseUrl", "aiApiChatModel", "aiApiImageModel"] as const) {
      if (body?.[f] !== undefined) data[f] = String(body[f]);
    }
    const token = unwrap(body?.aiApiToken);
    if (token) data.aiApiToken = token;
    await this.prisma.siteConfig.update({ where: { id: c.id }, data });
    return { message: "AI 接口配置已保存" };
  }

  async getSmsConfig() {
    const c = await this.prisma.smsConfig.findFirst({ orderBy: { createdAt: "asc" } });
    if (!c) return { configured: false, provider: "aliyun" };
    return {
      configured: true,
      provider: c.provider,
      secretId: mask(c.secretId),
      secretKey: mask(c.secretKey),
      signName: c.signName,
      templateCode: c.templateCode,
      sdkAppId: c.sdkAppId,
      region: c.region,
      isActive: c.isActive,
      updatedAt: c.updatedAt,
    };
  }

  async updateSmsConfig(body: any) {
    const c = await this.prisma.smsConfig.findFirst({ orderBy: { createdAt: "asc" } });
    const data: any = {};
    if (body?.provider !== undefined) data.provider = String(body.provider);
    if (body?.signName !== undefined) data.signName = String(body.signName);
    if (body?.templateCode !== undefined) data.templateCode = String(body.templateCode);
    if (body?.sdkAppId !== undefined) data.sdkAppId = body.sdkAppId ? String(body.sdkAppId) : null;
    if (body?.region !== undefined) data.region = String(body.region);
    if (body?.isActive !== undefined) data.isActive = Boolean(body.isActive);
    const sid = unwrap(body?.secretId);
    if (sid) data.secretId = sid;
    const skey = unwrap(body?.secretKey);
    if (skey) data.secretKey = skey;
    if (c) {
      await this.prisma.smsConfig.update({ where: { id: c.id }, data });
    } else {
      await this.prisma.smsConfig.create({
        data: {
          provider: data.provider ?? "aliyun",
          secretId: data.secretId ?? "",
          secretKey: data.secretKey ?? "",
          signName: data.signName ?? "",
          templateCode: data.templateCode ?? "",
          sdkAppId: data.sdkAppId ?? null,
          region: data.region ?? "cn-hangzhou",
          isActive: data.isActive ?? true,
        },
      });
    }
    // 保存后立即失效缓存，下一次发送/测试立刻使用新配置
    invalidateSmsConfigCache();
    return { message: "短信配置已保存" };
  }

  /** 真实下发一条测试短信：生成 6 位随机码走 SmsSender（DB > env > devMode）。 */
  async testSms(body: any) {
    const phone = String(body?.phone ?? "").trim();
    if (!/^1\d{10}$/.test(phone)) throw new BadRequestException("手机号格式不正确");
    const code = String(randomInt(100000, 1000000));
    const res = await this.sms.send(phone, code, "admin-test");
    // 生产环境绝不回传验证码；沿用 SmsSender.returnCodeAllowed 的「非生产 + 显式开关」语义
    const devCode = this.sms.returnCodeAllowed ? res.devCode : undefined;
    return {
      sent: res.sent,
      provider: res.provider ?? "",
      message: res.message ?? (res.sent ? "测试短信已发送" : "测试短信发送失败"),
      ...(devCode ? { devCode } : {}),
    };
  }

  async getOssConfig() {
    const c = await this.prisma.ossConfig.findFirst({ orderBy: { createdAt: "asc" } });
    if (!c) return { configured: false };
    return {
      configured: true,
      accessKeyId: mask(c.accessKeyId),
      accessKeySecret: mask(c.accessKeySecret),
      bucketName: c.bucketName,
      endpoint: c.endpoint,
      region: c.region,
      isActive: c.isActive,
      updatedAt: c.updatedAt,
    };
  }

  async updateOssConfig(body: any) {
    const c = await this.prisma.ossConfig.findFirst({ orderBy: { createdAt: "asc" } });
    const data: any = {};
    for (const f of ["bucketName", "endpoint", "region"] as const) if (body?.[f] !== undefined) data[f] = String(body[f]);
    if (body?.isActive !== undefined) data.isActive = Boolean(body.isActive);
    const ak = unwrap(body?.accessKeyId);
    if (ak) data.accessKeyId = ak;
    const sk = unwrap(body?.accessKeySecret);
    if (sk) data.accessKeySecret = sk;
    if (c) await this.prisma.ossConfig.update({ where: { id: c.id }, data });
    else
      await this.prisma.ossConfig.create({
        data: {
          accessKeyId: data.accessKeyId ?? "",
          accessKeySecret: data.accessKeySecret ?? "",
          bucketName: data.bucketName ?? "",
          endpoint: data.endpoint ?? "oss-cn-beijing.aliyuncs.com",
          region: data.region ?? "oss-cn-beijing",
          isActive: data.isActive ?? true,
        },
      });
    return { message: "OSS 配置已保存" };
  }

  async getWechatPayConfig() {
    const c = await this.prisma.wechatPayConfig.findFirst({ orderBy: { createdAt: "asc" } });
    if (!c) return { configured: false };
    return {
      configured: true,
      appId: c.appId,
      mchId: c.mchId,
      apiKey: mask(c.apiKey),
      apiV3Key: mask(c.apiV3Key),
      certSerialNo: c.certSerialNo,
      publicKey: mask(c.publicKey),
      privateKey: mask(c.privateKey),
      description: c.description,
      isActive: c.isActive,
      updatedAt: c.updatedAt,
    };
  }

  async updateWechatPayConfig(body: any) {
    const c = await this.prisma.wechatPayConfig.findFirst({ orderBy: { createdAt: "asc" } });
    const data: any = {};
    for (const f of ["appId", "mchId", "certSerialNo", "description"] as const) {
      if (body?.[f] !== undefined) data[f] = body[f] === null ? null : String(body[f]);
    }
    if (body?.isActive !== undefined) data.isActive = Boolean(body.isActive);
    for (const f of ["apiKey", "apiV3Key", "publicKey", "privateKey"] as const) {
      const v = unwrap(body?.[f]);
      if (v) data[f] = v;
    }
    if (c) await this.prisma.wechatPayConfig.update({ where: { id: c.id }, data });
    else
      await this.prisma.wechatPayConfig.create({
        data: {
          appId: data.appId ?? "",
          mchId: data.mchId ?? "",
          apiKey: data.apiKey ?? "",
          apiV3Key: data.apiV3Key ?? null,
          certSerialNo: data.certSerialNo ?? null,
          privateKey: data.privateKey ?? null,
          publicKey: data.publicKey ?? null,
          description: data.description ?? null,
          isActive: data.isActive ?? true,
        },
      });
    // 保存后立即失效 60 秒 DB 配置缓存，下一次下单/回调马上用新配置
    invalidateWechatPayConfigCache();
    return { message: "微信支付配置已保存" };
  }

  async getSystemInfo() {
    const c = await this.prisma.systemInfo.findFirst({ orderBy: { createdAt: "asc" } });
    if (!c) return {};
    return {
      id: c.id,
      agentServerUrl: c.agentServerUrl,
      computeApiToken: mask(c.computeApiToken),
      siteDomain: c.siteDomain,
      serverIp: c.serverIp,
      isAuthorized: c.isAuthorized,
      lastVerifiedAt: c.lastVerifiedAt,
      authorizedAt: c.authorizedAt,
      piracyContactWechat: c.piracyContactWechat,
      agentPlanEnabled: c.agentPlanEnabled,
      agentPlanAfpToCreditsRate: c.agentPlanAfpToCreditsRate,
      agentQuoteRateToAdmin: c.agentQuoteRateToAdmin,
      agentVolcCostRate: c.agentVolcCostRate,
      updatedAt: c.updatedAt,
    };
  }

  async updateSystemInfo(body: any) {
    const c = await this.prisma.systemInfo.findFirst({ orderBy: { createdAt: "asc" } });
    if (!c) throw new NotFoundException("系统信息不存在");
    const data: any = {};
    for (const f of ["agentServerUrl", "siteDomain", "serverIp", "piracyContactWechat"] as const) {
      if (body?.[f] !== undefined) data[f] = String(body[f]);
    }
    if (body?.agentPlanEnabled !== undefined) data.agentPlanEnabled = Boolean(body.agentPlanEnabled);
    for (const f of ["agentPlanAfpToCreditsRate", "agentQuoteRateToAdmin", "agentVolcCostRate"] as const) {
      if (body?.[f] !== undefined) data[f] = Number(body[f]);
    }
    const token = unwrap(body?.computeApiToken);
    if (token) data.computeApiToken = token;
    await this.prisma.systemInfo.update({ where: { id: c.id }, data });
    return { message: "系统信息已保存" };
  }

  async piracyWarning() {
    const c = await this.prisma.systemInfo.findFirst({ orderBy: { createdAt: "asc" } });
    return {
      isAuthorized: c?.isAuthorized ?? false,
      lastVerifiedAt: c?.lastVerifiedAt ?? null,
      piracyContactWechat: c?.piracyContactWechat ?? "",
      warning: c?.isAuthorized ? "" : "检测到未授权部署，请联系服务商获取授权",
    };
  }

  // ================= 定价 =================
  listModelPricing() {
    return this.prisma.modelPricing.findMany({ orderBy: { modelId: "asc" } });
  }

  async createModelPricing(body: any) {
    const modelId = String(body?.modelId ?? "").trim();
    const modelName = String(body?.modelName ?? "").trim();
    if (!modelId) throw new BadRequestException("模型 ID 不能为空");
    if (!modelName) throw new BadRequestException("模型名称不能为空");
    const exists = await this.prisma.modelPricing.findUnique({ where: { modelId } });
    if (exists) throw new BadRequestException("该模型已存在定价");
    this.pricing.clearCache();
    return this.prisma.modelPricing.create({
      data: {
        modelId,
        modelName,
        pricingMode: body?.pricingMode === "per_token" ? "per_token" : "per_request",
        pricePerRequest: Math.max(1, Math.trunc(Number(body?.pricePerRequest ?? 1))),
        pricePerInputToken: Math.max(0, Math.trunc(Number(body?.pricePerInputToken ?? 0))),
        pricePerOutputToken: Math.max(0, Math.trunc(Number(body?.pricePerOutputToken ?? 0))),
        provider: body?.provider ?? "ark",
        upstreamModelId: body?.upstreamModelId ?? null,
        upstreamCostInputPerMillionCny: Math.max(0, Number(body?.upstreamCostInputPerMillionCny ?? 1.8)),
        upstreamCostOutputPerMillionCny: Math.max(0, Number(body?.upstreamCostOutputPerMillionCny ?? 14.4)),
        costNote: body?.costNote ? String(body.costNote).slice(0, 255) : null,
        isActive: body?.isActive !== false,
      },
    });
  }

  async updateModelPricing(id: string, body: any) {
    const row = await this.prisma.modelPricing.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("模型定价不存在");
    const data: any = {};
    for (const f of ["modelName", "pricingMode", "provider", "upstreamModelId"] as const) {
      if (body?.[f] !== undefined) data[f] = body[f] === null ? null : String(body[f]);
    }
    for (const f of ["pricePerRequest", "pricePerInputToken", "pricePerOutputToken"] as const) {
      if (body?.[f] !== undefined) data[f] = Math.trunc(Number(body[f]));
    }
    for (const f of ["upstreamCostInputPerMillionCny", "upstreamCostOutputPerMillionCny"] as const) {
      if (body?.[f] !== undefined) {
        const v = Number(body[f]);
        if (!Number.isFinite(v) || v < 0) throw new BadRequestException("上游成本必须是大于等于 0 的数字");
        data[f] = v;
      }
    }
    if (body?.costNote !== undefined) data.costNote = body.costNote ? String(body.costNote).slice(0, 255) : null;
    if (body?.isActive !== undefined) data.isActive = Boolean(body.isActive);
    this.pricing.clearCache();
    return this.prisma.modelPricing.update({ where: { id }, data });
  }

  async deleteModelPricing(id: string) {
    const row = await this.prisma.modelPricing.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("模型定价不存在");
    await this.prisma.modelPricing.delete({ where: { id } });
    this.pricing.clearCache();
    return { success: true };
  }

  listMediaPricing() {
    return this.prisma.mediaPricing.findMany({ orderBy: { taskType: "asc" } });
  }

  async createMediaPricing(body: any) {
    const taskType = String(body?.taskType ?? "").trim();
    const taskName = String(body?.taskName ?? "").trim();
    if (!taskType) throw new BadRequestException("任务类型不能为空");
    if (!taskName) throw new BadRequestException("任务名称不能为空");
    const exists = await this.prisma.mediaPricing.findUnique({ where: { taskType } });
    if (exists) throw new BadRequestException("该媒体任务已存在定价");
    this.pricing.clearCache();
    return this.prisma.mediaPricing.create({
      data: {
        taskType,
        taskName,
        pricingMode: body?.pricingMode === "per_input_second" ? "per_input_second" : "per_request",
        pricePerRequest: Math.max(1, Math.trunc(Number(body?.pricePerRequest ?? 1))),
        pricePerInputSecond: Number(body?.pricePerInputSecond ?? 0),
        defaultEstimatedSeconds: Math.max(1, Math.trunc(Number(body?.defaultEstimatedSeconds ?? 60))),
        upstreamUnit: body?.upstreamUnit === "coins" ? "coins" : "cny",
        upstreamCoinsPerUnit: Math.max(0, Number(body?.upstreamCoinsPerUnit ?? 0)),
        upstreamUnitCostCny: Math.max(0, Number(body?.upstreamUnitCostCny ?? 0)),
        costNote: body?.costNote ? String(body.costNote).slice(0, 255) : null,
        isActive: body?.isActive !== false,
      },
    });
  }

  async updateMediaPricing(id: string, body: any) {
    const row = await this.prisma.mediaPricing.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("媒体定价不存在");
    const data: any = {};
    for (const f of ["taskName", "pricingMode"] as const) if (body?.[f] !== undefined) data[f] = String(body[f]);
    if (body?.pricePerRequest !== undefined) data.pricePerRequest = Math.trunc(Number(body.pricePerRequest));
    if (body?.pricePerInputSecond !== undefined) data.pricePerInputSecond = Number(body.pricePerInputSecond);
    if (body?.defaultEstimatedSeconds !== undefined) data.defaultEstimatedSeconds = Math.trunc(Number(body.defaultEstimatedSeconds));
    if (body?.upstreamUnit !== undefined) data.upstreamUnit = body.upstreamUnit === "coins" ? "coins" : "cny";
    for (const f of ["upstreamCoinsPerUnit", "upstreamUnitCostCny"] as const) {
      if (body?.[f] !== undefined) {
        const v = Number(body[f]);
        if (!Number.isFinite(v) || v < 0) throw new BadRequestException("上游成本必须是大于等于 0 的数字");
        data[f] = v;
      }
    }
    if (body?.costNote !== undefined) data.costNote = body.costNote ? String(body.costNote).slice(0, 255) : null;
    if (body?.isActive !== undefined) data.isActive = Boolean(body.isActive);
    this.pricing.clearCache();
    return this.prisma.mediaPricing.update({ where: { id }, data });
  }

  async deleteMediaPricing(id: string) {
    const row = await this.prisma.mediaPricing.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("媒体定价不存在");
    await this.prisma.mediaPricing.delete({ where: { id } });
    return { success: true };
  }

  // ================= 定价（成本驱动） =================
  pricingOverview(days?: number) {
    const d = Number(days);
    return this.pricing.overview(Number.isFinite(d) && d > 0 ? Math.min(365, Math.trunc(d)) : 30);
  }

  updatePricingConfig(body: any, operator?: string) {
    return this.pricing.updateConfig(body ?? {}, operator);
  }

  recalcPricing(body: any, operator?: string) {
    return this.pricing.recalc({ mode: body?.mode === "apply" ? "apply" : "preview", operator, days: Number(body?.days) || 30 });
  }

  pricingChangeLog(limit?: number) {
    return this.pricing.listChangeLog(Number(limit) || 50);
  }

  // ================= 兑换码（管理端 CRUD） =================
  async listRedemptionCodes(query: any) {
    const page = Number(query?.page) || 1;
    const limit = Number(query?.limit) || 20;
    const where: any = {};
    if (query?.status) where.status = query.status;
    if (query?.packageId) where.packageId = query.packageId;
    if (query?.keyword) where.code = { contains: query.keyword };
    const [items, total] = await Promise.all([
      this.prisma.redemptionCode.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
      this.prisma.redemptionCode.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  async updateRedemptionCode(id: string, body: any) {
    const row = await this.prisma.redemptionCode.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("兑换码不存在");
    const data: any = {};
    for (const f of ["status", "note"] as const) if (body?.[f] !== undefined) data[f] = body[f] === null ? null : String(body[f]);
    if (body?.validDays !== undefined) data.validDays = body.validDays === null ? null : Math.trunc(Number(body.validDays));
    if (body?.expiresAt !== undefined) data.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    return this.prisma.redemptionCode.update({ where: { id }, data });
  }

  async deleteRedemptionCode(id: string) {
    const row = await this.prisma.redemptionCode.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("兑换码不存在");
    if (row.status === "used") throw new BadRequestException("已使用的兑换码不可删除");
    await this.prisma.redemptionCode.delete({ where: { id } });
    return { success: true };
  }

  // ================= 用户 =================
  async createUser(body: any) {
    const phone = body?.phone ? String(body.phone).trim() : null;
    const email = body?.email ? String(body.email).trim() : null;
    if (!phone && !email) throw new BadRequestException("手机号或邮箱至少填一项");
    if (phone && !/^1\d{10}$/.test(phone)) throw new BadRequestException("手机号格式不正确");
    if (phone) {
      const dup = await this.prisma.user.findUnique({ where: { phone } });
      if (dup) throw new BadRequestException("手机号已注册");
    }
    if (email) {
      const dup = await this.prisma.user.findUnique({ where: { email } });
      if (dup) throw new BadRequestException("邮箱已注册");
    }
    const password = String(body?.password ?? "").trim() || Math.random().toString(36).slice(-10);
    const user = await this.prisma.user.create({
      data: {
        phone,
        email,
        passwordHash: await bcrypt.hash(password, 10),
        nickname: body?.nickname ? String(body.nickname) : (phone ? "用户" + phone.slice(-4) : email),
        role: body?.role === "admin" ? "admin" : "user",
        status: "active",
        credits: Math.max(0, Math.trunc(Number(body?.credits ?? 0))),
        source: "admin",
      },
    });
    return { id: user.id, phone: user.phone, email: user.email, nickname: user.nickname, role: user.role, status: user.status, credits: user.credits, createdAt: user.createdAt, source: user.source };
  }

  async updateUserStatus(id: string, body: any) {
    const status = String(body?.status ?? "");
    if (!["active", "disabled"].includes(status)) throw new BadRequestException("状态只能是 active 或 disabled");
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException("用户不存在");
    const { passwordHash, ...rest } = await this.prisma.user.update({ where: { id }, data: { status } });
    void passwordHash;
    return rest;
  }

  async updateUserPassword(id: string, body: any) {
    const pwd = String(body?.password ?? "");
    if (pwd.length < 6) throw new BadRequestException("密码至少 6 位");
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException("用户不存在");
    await this.prisma.user.update({ where: { id }, data: { passwordHash: await bcrypt.hash(pwd, 10) } });
    return { success: true, message: "密码已更新" };
  }

  // ================= 员工 =================
  async listEmployees() {
    return this.prisma.aiEmployee.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: { _count: { select: { purchases: true } } },
    });
  }

  async employeeDetail(id: string) {
    const row = await this.prisma.aiEmployee.findFirst({ where: { OR: [{ id }, { slug: id }] } });
    if (!row) throw new NotFoundException("员工不存在");
    return row;
  }

  async createEmployee(body: any) {
    const slug = String(body?.slug ?? "").trim();
    const name = String(body?.name ?? "").trim();
    if (!slug) throw new BadRequestException("slug 不能为空");
    if (!name) throw new BadRequestException("员工名称不能为空");
    const dup = await this.prisma.aiEmployee.findUnique({ where: { slug } });
    if (dup) throw new BadRequestException("该 slug 已存在");
    return this.prisma.aiEmployee.create({
      data: {
        slug,
        name,
        nameEn: String(body?.nameEn ?? ""),
        title: String(body?.title ?? ""),
        titleEn: String(body?.titleEn ?? ""),
        avatarUrl: String(body?.avatarUrl ?? ""),
        avatarEmoji: String(body?.avatarEmoji ?? ""),
        description: String(body?.description ?? ""),
        mission: String(body?.mission ?? ""),
        coreDirective: String(body?.coreDirective ?? ""),
        price: Math.max(0, Math.trunc(Number(body?.price ?? 0))),
        priceDisplay: String(body?.priceDisplay ?? ""),
        category: String(body?.category ?? ""),
        skillName: String(body?.skillName ?? ""),
        skillVersion: String(body?.skillVersion ?? "1.0.0"),
        cliRequirement: String(body?.cliRequirement ?? "none"),
        tier: String(body?.tier ?? "standard"),
        usageExample: String(body?.usageExample ?? ""),
        sortOrder: Math.trunc(Number(body?.sortOrder ?? 0)),
        isActive: body?.isActive !== false,
        isBundled: Boolean(body?.isBundled),
        requiredPackage: body?.requiredPackage ?? null,
      },
    });
  }

  async updateEmployee(id: string, body: any) {
    const row = await this.prisma.aiEmployee.findFirst({ where: { OR: [{ id }, { slug: id }] } });
    if (!row) throw new NotFoundException("员工不存在");
    const data: any = {};
    for (const f of [
      "name",
      "nameEn",
      "title",
      "titleEn",
      "avatarUrl",
      "avatarEmoji",
      "description",
      "mission",
      "coreDirective",
      "priceDisplay",
      "category",
      "skillName",
      "skillVersion",
      "cliRequirement",
      "tier",
      "usageExample",
      "requiredPackage",
    ] as const) {
      if (body?.[f] !== undefined) data[f] = body[f] === null ? null : String(body[f]);
    }
    for (const f of ["price", "sortOrder"] as const) if (body?.[f] !== undefined) data[f] = Math.trunc(Number(body[f]));
    for (const f of ["isActive", "isBundled"] as const) if (body?.[f] !== undefined) data[f] = Boolean(body[f]);
    return this.prisma.aiEmployee.update({ where: { id: row.id }, data });
  }

  async toggleEmployee(id: string) {
    const row = await this.prisma.aiEmployee.findFirst({ where: { OR: [{ id }, { slug: id }] } });
    if (!row) throw new NotFoundException("员工不存在");
    return this.prisma.aiEmployee.update({ where: { id: row.id }, data: { isActive: !row.isActive } });
  }

  async sortEmployees(body: any) {
    const items = Array.isArray(body?.items) ? body.items : [];
    if (!items.length) throw new BadRequestException("排序列表不能为空");
    await this.prisma.$transaction(
      items.map((it: any, idx: number) =>
        this.prisma.aiEmployee.updateMany({
          where: { OR: [{ id: String(it.id ?? "") }, { slug: String(it.slug ?? "") }] },
          data: { sortOrder: Number(it.sortOrder ?? idx) },
        }),
      ),
    );
    return { success: true, count: items.length };
  }

  async deleteEmployee(id: string) {
    const row = await this.prisma.aiEmployee.findFirst({ where: { OR: [{ id }, { slug: id }] } });
    if (!row) throw new NotFoundException("员工不存在");
    const [purchases, orders] = await Promise.all([
      this.prisma.aiEmployeePurchase.count({ where: { employeeId: row.id } }),
      this.prisma.employeeOrder.count({ where: { employeeId: row.id } }),
    ]);
    if (purchases || orders) {
      // 有购买/订单记录：软下架，保历史可查
      await this.prisma.aiEmployee.update({ where: { id: row.id }, data: { isActive: false } });
      return { success: true, softDeleted: true };
    }
    await this.prisma.aiEmployee.delete({ where: { id: row.id } });
    return { success: true, softDeleted: false };
  }

  async listEmployeePurchases(query: any) {
    const page = Number(query?.page) || 1;
    const limit = Number(query?.limit) || 20;
    const where: any = {};
    if (query?.status) where.status = query.status;
    if (query?.employeeSlug) where.employeeSlug = query.employeeSlug;
    const [items, total] = await Promise.all([
      this.prisma.aiEmployeePurchase.findMany({
        where,
        orderBy: { purchasedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: { user: { select: { id: true, phone: true, nickname: true } } },
      }),
      this.prisma.aiEmployeePurchase.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  // ================= 用量（管理端） =================
  async listAiUsageRecords(query: any) {
    const page = Number(query?.page) || 1;
    const limit = Number(query?.limit) || 20;
    const where: any = {};
    if (query?.userId) where.userId = query.userId;
    if (query?.modelId) where.modelId = query.modelId;
    if (query?.startDate || query?.endDate) {
      where.createdAt = {};
      if (query.startDate) where.createdAt.gte = new Date(query.startDate);
      if (query.endDate) where.createdAt.lte = new Date(query.endDate);
    }
    const [items, total] = await Promise.all([
      this.prisma.aiUsageRecord.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: { user: { select: { id: true, phone: true, nickname: true } } },
      }),
      this.prisma.aiUsageRecord.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  async aiUsageStats(query: any) {
    const where: any = {};
    if (query?.startDate || query?.endDate) {
      where.createdAt = {};
      if (query.startDate) where.createdAt.gte = new Date(query.startDate);
      if (query.endDate) where.createdAt.lte = new Date(query.endDate);
    }
    const [agg, byModel, byUser] = await Promise.all([
      this.prisma.aiUsageRecord.aggregate({
        where,
        _count: true,
        _sum: { inputTokens: true, outputTokens: true, totalTokens: true, creditsCharged: true },
      }),
      this.prisma.aiUsageRecord.groupBy({
        by: ["modelId"],
        where,
        _count: true,
        _sum: { totalTokens: true, creditsCharged: true },
      }),
      this.prisma.aiUsageRecord.groupBy({ by: ["userId"], where, _count: true, _sum: { totalTokens: true, creditsCharged: true } }),
    ]);
    const users = await this.prisma.user.findMany({
      where: { id: { in: byUser.map((u) => u.userId) } },
      select: { id: true, phone: true, nickname: true },
    });
    const um = new Map(users.map((u) => [u.id, u]));
    return {
      totalRequests: agg._count,
      totalInputTokens: agg._sum.inputTokens ?? 0,
      totalOutputTokens: agg._sum.outputTokens ?? 0,
      totalTokens: agg._sum.totalTokens ?? 0,
      totalCreditsCharged: agg._sum.creditsCharged ?? 0,
      modelBreakdown: byModel.map((m) => ({
        modelId: m.modelId,
        requests: m._count,
        totalTokens: m._sum.totalTokens ?? 0,
        creditsCharged: m._sum.creditsCharged ?? 0,
      })),
      userBreakdown: byUser
        .map((u) => ({
          userId: u.userId,
          phone: um.get(u.userId)?.phone ?? null,
          nickname: um.get(u.userId)?.nickname ?? null,
          requests: u._count,
          totalTokens: u._sum.totalTokens ?? 0,
          creditsCharged: u._sum.creditsCharged ?? 0,
        }))
        .sort((a, b) => b.totalTokens - a.totalTokens),
    };
  }

  /** 按天聚合（近 N 天，默认 30） */
  async dailyUsage(days = 30) {
    const since = dayStart(new Date(Date.now() - (days - 1) * 86400000));
    const rows = await this.prisma.aiUsageRecord.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true, totalTokens: true, creditsCharged: true, modelId: true },
    });
    const map = new Map<string, { date: string; requests: number; totalTokens: number; creditsCharged: number }>();
    for (const r of rows) {
      const d = r.createdAt.toISOString().slice(0, 10);
      const cur = map.get(d) ?? { date: d, requests: 0, totalTokens: 0, creditsCharged: 0 };
      cur.requests += 1;
      cur.totalTokens += r.totalTokens;
      cur.creditsCharged += r.creditsCharged;
      map.set(d, cur);
    }
    return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  // ================= 统计 =================
  async statisticsRevenue(days = 30) {
    const since = dayStart(new Date(Date.now() - (days - 1) * 86400000));
    const orders = await this.prisma.order.findMany({
      where: { status: "paid", paidAt: { gte: since } },
      select: { paidAt: true, amount: true, credits: true },
    });
    const map = new Map<string, { date: string; amount: number; credits: number; orders: number }>();
    for (const o of orders) {
      const d = (o.paidAt ?? new Date()).toISOString().slice(0, 10);
      const cur = map.get(d) ?? { date: d, amount: 0, credits: 0, orders: 0 };
      cur.amount += o.amount;
      cur.credits += o.credits;
      cur.orders += 1;
      map.set(d, cur);
    }
    return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  async statisticsUsers(days = 30) {
    const since = dayStart(new Date(Date.now() - (days - 1) * 86400000));
    const users = await this.prisma.user.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } });
    const map = new Map<string, number>();
    for (const u of users) {
      const d = u.createdAt.toISOString().slice(0, 10);
      map.set(d, (map.get(d) ?? 0) + 1);
    }
    return [...map.entries()].map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date));
  }

  async statisticsCredits() {
    const [byType, totals] = await Promise.all([
      this.prisma.creditTransaction.groupBy({ by: ["type"], _count: true, _sum: { amount: true } }),
      this.prisma.user.aggregate({ _sum: { credits: true, totalCreditsConsumed: true, totalCreditsRecharged: true } }),
    ]);
    return {
      byType: byType.map((t) => ({ type: t.type, count: t._count, amount: t._sum.amount ?? 0 })),
      balanceTotal: totals._sum.credits ?? 0,
      consumedTotal: totals._sum.totalCreditsConsumed ?? 0,
      rechargedTotal: totals._sum.totalCreditsRecharged ?? 0,
    };
  }

  async statisticsTeam() {
    const [grants, purchases, orders] = await Promise.all([
      this.prisma.userPackageGrant.findMany({ select: { packageId: true, expiresAt: true } }),
      this.prisma.aiEmployeePurchase.findMany({ select: { employeeSlug: true, status: true, expiresAt: true } }),
      this.prisma.order.count({ where: { status: "paid" } }),
    ]);
    const now = new Date();
    const byPackage = new Map<string, { packageId: string; total: number; active: number }>();
    for (const g of grants) {
      const cur = byPackage.get(g.packageId) ?? { packageId: g.packageId, total: 0, active: 0 };
      cur.total += 1;
      if (!g.expiresAt || g.expiresAt > now) cur.active += 1;
      byPackage.set(g.packageId, cur);
    }
    const byEmployee = new Map<string, number>();
    for (const p of purchases) byEmployee.set(p.employeeSlug, (byEmployee.get(p.employeeSlug) ?? 0) + 1);
    return {
      packages: [...byPackage.values()],
      activeEmployees: purchases.filter((p) => !p.expiresAt || p.expiresAt > now).length,
      employeeRank: [...byEmployee.entries()]
        .map(([slug, count]) => ({ slug, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20),
      paidOrders: orders,
    };
  }

  // ================= 上传（复刻口径：base64 落盘，返回可访问 URL） =================
  /**
   * 原版用 multer + ali-oss 直传；复刻先落本地 uploads/ 并由 PUBLIC_BASE_URL 拼 URL。
   * 契约保持 { url }，且同步回写 SiteConfig/AiEmployee 字段（与原版一致）。
   */
  async uploadAsset(kind: "customer-service-qr" | "win-client" | "mac-client" | "employee-avatar", body: any) {
    const raw = String(body?.data ?? body?.base64 ?? body?.dataUrl ?? "");
    if (!raw) throw new BadRequestException("缺少文件内容（data/dataUrl/base64）");
    const m = /^data:([^;]+);base64,(.*)$/.exec(raw);
    const b64 = m ? m[2] : raw.replace(/^data:[^,]*,/, "");
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      throw new BadRequestException("文件内容不是合法的 base64");
    }
    if (!buf.length) throw new BadRequestException("文件内容为空");
    if (buf.length > 200 * 1024 * 1024) throw new BadRequestException("文件不能超过 200MB");
    const defaultExt = kind === "win-client" ? "exe" : kind === "mac-client" ? "dmg" : "png";
    const name = String(body?.filename ?? "");
    const ext = (name.includes(".") ? name.split(".").pop() : defaultExt) || defaultExt;
    const safeExt = ext.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || defaultExt;
    const dir = path.join(process.cwd(), "uploads", kind);
    fs.mkdirSync(dir, { recursive: true });
    const file = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${safeExt}`;
    fs.writeFileSync(path.join(dir, file), buf);
    const baseUrl = (process.env.PUBLIC_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
    const url = `${baseUrl}/uploads/${kind}/${file}`;

    if (kind === "employee-avatar") {
      const target = String(body?.employeeId ?? body?.slug ?? "");
      if (!target) throw new BadRequestException("缺少 employeeId 或 slug");
      const emp = await this.prisma.aiEmployee.findFirst({ where: { OR: [{ id: target }, { slug: target }] } });
      if (!emp) throw new NotFoundException("员工不存在");
      await this.prisma.aiEmployee.update({ where: { id: emp.id }, data: { avatarUrl: url } });
      return { url };
    }

    const c = await this.prisma.siteConfig.findFirst({ orderBy: { createdAt: "asc" } });
    const field =
      kind === "customer-service-qr" ? "customerServiceQrCodeUrl" : kind === "win-client" ? "winClientUrl" : "macClientUrl";
    if (c) await this.prisma.siteConfig.update({ where: { id: c.id }, data: { [field]: url } as any });
    else await this.prisma.siteConfig.create({ data: { [field]: url } as any });
    return { url };
  }

  // ================= 系统信息维护 =================
  async detectIp() {
    let ip = "";
    let source = "network-interfaces";
    try {
      const resp = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(4000) });
      if (resp.ok) {
        const j: any = await resp.json();
        if (j?.ip) {
          ip = String(j.ip);
          source = "ipify";
        }
      }
    } catch {
      // 离线环境回落本机网卡地址
    }
    if (!ip) {
      const nets = os.networkInterfaces();
      for (const list of Object.values(nets)) {
        for (const n of list ?? []) {
          if (n.family === "IPv4" && !n.internal) {
            ip = n.address;
            break;
          }
        }
        if (ip) break;
      }
    }
    const c = await this.prisma.systemInfo.findFirst({ orderBy: { createdAt: "asc" } });
    if (c && ip) await this.prisma.systemInfo.update({ where: { id: c.id }, data: { serverIp: ip } });
    return { ip: ip || "", source, saved: Boolean(c && ip) };
  }

  /** 复刻不接在线授权校验（用户已定：删除授权校验）；该路由只做本地置位，保持接口存在。 */
  async verifySystem() {
    const c = await this.prisma.systemInfo.findFirst({ orderBy: { createdAt: "asc" } });
    const now = new Date();
    if (c) {
      await this.prisma.systemInfo.update({
        where: { id: c.id },
        data: { isAuthorized: true, lastVerifiedAt: now, authorizedAt: c.authorizedAt ?? now },
      });
    }
    return { isAuthorized: true, lastVerifiedAt: now, onlineVerification: false, message: "复刻版不做在线授权校验，已本地置为已授权" };
  }

  // ================= 兑换码批发生成（原版 POST /admin/redemption-codes） =================
  createRedemptionCodes(body: any) {
    return this.packages.createCodes({
      packageId: String(body?.packageId ?? ""),
      count: body?.count === undefined ? undefined : Number(body.count),
      validDays: body?.validDays === undefined ? undefined : Number(body.validDays),
      expiresAt: body?.expiresAt ? String(body.expiresAt) : undefined,
      note: body?.note ? String(body.note) : undefined,
    });
  }

}