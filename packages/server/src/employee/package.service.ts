import { randomBytes, randomInt } from "node:crypto";
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { envInt } from "../common/env";

/**
 * 团队套餐（与原版对齐）
 * 证据：原版 server dist/redemption/redemption.service.js 的 VALID_PACKAGE_IDS
 *       + 客户端 main bundle 里的三档常量（8 / 5 / 14 个角色）
 * 原版没有会员订阅：SubscriptionPlan/UserSubscription/SubscriptionOrder 生产库 0 行，本复刻不实现。
 */
export const PACKAGE_PRESETS = [
  {
    id: "traffic",
    name: "流量操盘版",
    emoji: "🚀",
    roleCount: 8,
    description: "流量操盘全链路：选题、脚本、剪辑、发布",
  },
  {
    id: "private-domain",
    name: "私域运营版",
    emoji: "💼",
    roleCount: 5,
    description: "私域客户分层、跟进与成交转化",
  },
  {
    id: "flagship",
    name: "旗舰版",
    emoji: "👑",
    roleCount: 14,
    description: "全部 14 个角色，覆盖流量、渠道、销售、私域全链路",
  },
] as const;

export const VALID_PACKAGE_IDS: string[] = PACKAGE_PRESETS.map((p) => p.id);
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

function generateRedeemCode(): string {
  // 用 CSPRNG 取模消除偏置（randomInt 上限为字母表长度，天然无偏）
  const chars: string[] = [];
  for (let i = 0; i < 15; i++) chars.push(CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
  return `${chars.slice(0, 5).join("")}-${chars.slice(5, 10).join("")}-${chars.slice(10, 15).join("")}`;
}

/** 管理员手工开通的幂等键用 CSPRNG（随机码撞库成本），确保同一码不会被重复生成 */
function randomSuffix(bytes = 8): string {
  return randomBytes(bytes).toString("hex");
}

@Injectable()
export class PackageService {
  constructor(private readonly prisma: PrismaService) {}

  /** 默认有效期（天），价格与期限走 env，不写死 */
  defaultValidDays(): number {
    return envInt("PACKAGE_VALID_DAYS", 30);
  }

  presets() {
    return PACKAGE_PRESETS.map((p) => ({
      ...p,
      validDays: this.defaultValidDays(),
    }));
  }

  private ensureValidPackage(packageId: string) {
    if (!VALID_PACKAGE_IDS.includes(packageId)) {
      throw new BadRequestException(`无效的套餐：${packageId}`);
    }
  }

  async activeGrants(userId: string) {
    const now = new Date();
    return this.prisma.userPackageGrant.findMany({
      where: { userId, expiresAt: { gt: now } },
      orderBy: { expiresAt: "desc" },
    });
  }

  async mine(userId: string) {
    const grants = await this.activeGrants(userId);
    const expired = await this.prisma.userPackageGrant.findMany({
      where: { userId, expiresAt: { lte: new Date() } },
      orderBy: { expiresAt: "desc" },
      take: 20,
    });
    const activeIds = new Set(grants.map((g) => g.packageId));
    return {
      active: grants.map((g) => ({
        ...g,
        preset: PACKAGE_PRESETS.find((p) => p.id === g.packageId) ?? null,
      })),
      expired: expired.map((g) => ({
        ...g,
        preset: PACKAGE_PRESETS.find((p) => p.id === g.packageId) ?? null,
      })),
      presets: this.presets().map((p) => ({ ...p, owned: activeIds.has(p.id) })),
      /** 旗舰版包含全部角色，等价于任意套餐的超集 */
      effectivePackages: activeIds.has("flagship") ? VALID_PACKAGE_IDS : Array.from(activeIds),
    };
  }

  /** 员工安装/运行前的套餐校验：requiredPackage 为空表示不需要套餐 */
  async assertAccess(userId: string, requiredPackage: string | null | undefined) {
    if (!requiredPackage) return;
    const now = new Date();
    const grant = await this.prisma.userPackageGrant.findFirst({
      where: { userId, packageId: { in: [requiredPackage, "flagship"] }, expiresAt: { gt: now } },
    });
    if (!grant) {
      const preset = PACKAGE_PRESETS.find((p) => p.id === requiredPackage);
      throw new ForbiddenException(preset ? `套餐已到期，续费后恢复使用（需要${preset.name}）` : "未开通所需套餐");
    }
  }

  // ---------------- 兑换码 ----------------

  async redeem(userId: string, rawCode: string) {
    const code = String(rawCode ?? "").trim().toUpperCase();
    if (!code) throw new BadRequestException("请输入兑换码");
    const record = await this.prisma.redemptionCode.findUnique({ where: { code } });
    if (!record) throw new BadRequestException("兑换码不存在，请检查后重试");
    if (record.status === "disabled") throw new BadRequestException("兑换码已被禁用");
    if (record.status === "used") throw new BadRequestException("兑换码已被使用");
    if (record.expiresAt && record.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException("兑换码已过期");
    }
    this.ensureValidPackage(record.packageId);

    const validDays = record.validDays ?? this.defaultValidDays();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + validDays * 86400000);

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.redemptionCode.updateMany({
        where: { id: record.id, status: "unused" },
        data: { status: "used", usedByUserId: userId, usedAt: now },
      });
      if (updated.count === 0) throw new BadRequestException("兑换码已被使用");
      const grant = await tx.userPackageGrant.create({
        data: {
          userId,
          packageId: record.packageId,
          source: "redemption",
          validDays,
          grantedAt: now,
          expiresAt,
          codeId: record.id,
        },
      });
      return grant;
    });

    return {
      packageId: record.packageId,
      validDays,
      expiresAt,
      grantId: result.id,
      preset: PACKAGE_PRESETS.find((p) => p.id === record.packageId) ?? null,
    };
  }

  /** 管理员批量生成兑换码（原版 batchCreate 语义） */
  async createCodes(params: { packageId: string; count?: number; validDays?: number; expiresAt?: string; note?: string }) {
    this.ensureValidPackage(params.packageId);
    const count = Math.min(200, Math.max(1, Number(params.count) || 1));
    const batchId = `batch_${Date.now().toString(36)}_${randomSuffix(3)}`;
    const data = Array.from({ length: count }, () => ({
      code: generateRedeemCode(),
      packageId: params.packageId,
      batchId,
      validDays: params.validDays ?? this.defaultValidDays(),
      expiresAt: params.expiresAt ? new Date(params.expiresAt) : null,
      note: params.note ?? null,
    }));
    const created = await this.prisma.redemptionCode.createMany({ data });
    return { batchId, count: created.count, codes: data.map((d) => d.code) };
  }

  async listCodes(query: any) {
    const page = Math.max(1, Number(query?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query?.limit) || 20));
    const where: any = {};
    if (query?.status) where.status = query.status;
    if (query?.packageId) where.packageId = query.packageId;
    const [total, items] = await Promise.all([
      this.prisma.redemptionCode.count({ where }),
      this.prisma.redemptionCode.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    ]);
    return { total, page, limit, items };
  }

  /** 管理员手工开通（支付未接、线下收款场景） */
  async adminGrant(params: { userId?: string; phone?: string; packageId: string; validDays?: number; note?: string }) {
    this.ensureValidPackage(params.packageId);
    let userId = params.userId;
    if (!userId && params.phone) {
      const user = await this.prisma.user.findUnique({ where: { phone: params.phone } });
      if (!user) throw new NotFoundException("用户不存在");
      userId = user.id;
    }
    if (!userId) throw new BadRequestException("请指定用户");
    const validDays = params.validDays ?? this.defaultValidDays();
    const now = new Date();
    return this.prisma.userPackageGrant.create({
      data: {
        userId,
        packageId: params.packageId,
        source: "admin",
        validDays,
        grantedAt: now,
        expiresAt: new Date(now.getTime() + validDays * 86400000),
        note: params.note ?? null,
      },
    });
  }
}
