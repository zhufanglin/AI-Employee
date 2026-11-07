import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreditsService } from "../billing/credits.service";
import { OrdersService } from "../orders/orders.service";

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    private readonly orders: OrdersService,
  ) {}

  async overview() {
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const [users, paidAgg, pendingCount, todayUsers, todayRevenue, aiCalls, creditsConsumed] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.order.aggregate({ where: { status: "paid" }, _sum: { amount: true, credits: true }, _count: true }),
      this.prisma.order.count({ where: { status: "pending" } }),
      this.prisma.user.count({ where: { createdAt: { gte: dayStart } } }),
      this.prisma.order.aggregate({ where: { status: "paid", paidAt: { gte: dayStart } }, _sum: { amount: true }, _count: true }),
      this.prisma.aiUsageRecord.count({ where: { createdAt: { gte: dayStart } } }),
      this.prisma.aiUsageRecord.aggregate({ where: { createdAt: { gte: dayStart } }, _sum: { creditsCharged: true } }),
    ]);
    return {
      users,
      todayNewUsers: todayUsers,
      paidOrders: paidAgg._count,
      revenueTotal: paidAgg._sum.amount ?? 0,
      creditsSold: paidAgg._sum.credits ?? 0,
      pendingOrders: pendingCount,
      todayRevenue: todayRevenue._sum.amount ?? 0,
      todayPaidOrders: todayRevenue._count,
      todayAiCalls: aiCalls,
      todayCreditsConsumed: creditsConsumed._sum.creditsCharged ?? 0,
    };
  }

  listPackages(includeInactive = true) {
    return this.prisma.creditPackage.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ sort: "asc" }, { createdAt: "asc" }],
    });
  }

  async createPackage(body: any) {
    const name = String(body?.name ?? "").trim();
    const credits = Number(body?.credits);
    const priceYuan = Number(body?.price);
    if (!name) throw new BadRequestException("套餐名称不能为空");
    if (!Number.isInteger(credits) || credits <= 0) throw new BadRequestException("积分数必须为正整数");
    if (!Number.isFinite(priceYuan) || priceYuan <= 0) throw new BadRequestException("价格（元）必须大于 0");
    const price = Math.round(priceYuan * 100);
    return this.prisma.creditPackage.create({
      data: {
        name,
        credits,
        price,
        priceDisplay: String(body?.priceDisplay ?? "¥" + (price / 100).toFixed(2)),
        description: body?.description ?? null,
        sort: Number(body?.sort ?? 0),
        isActive: body?.isActive !== false,
      },
    });
  }

  async updatePackage(id: string, body: any) {
    const exists = await this.prisma.creditPackage.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException("套餐不存在");
    const data: any = {};
    if (body?.name !== undefined) data.name = String(body.name);
    if (body?.credits !== undefined) data.credits = Number(body.credits);
    if (body?.price !== undefined) {
      const yuan = Number(body.price);
      if (!Number.isFinite(yuan) || yuan <= 0) throw new BadRequestException("价格（元）必须大于 0");
      data.price = Math.round(yuan * 100);
    }
    if (body?.priceDisplay !== undefined) data.priceDisplay = String(body.priceDisplay);
    if (body?.description !== undefined) data.description = body.description;
    if (body?.sort !== undefined) data.sort = Number(body.sort);
    if (body?.isActive !== undefined) data.isActive = Boolean(body.isActive);
    return this.prisma.creditPackage.update({ where: { id }, data });
  }

  /** 软下架：已有订单仍可查（外键依赖），只是不再对外售卖 */
  async deletePackage(id: string) {
    const exists = await this.prisma.creditPackage.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException("套餐不存在");
    return this.prisma.creditPackage.update({ where: { id }, data: { isActive: false } });
  }

  async listOrders(query: { status?: string; keyword?: string; page?: number; limit?: number }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.keyword) {
      where.OR = [
        { orderNo: { contains: query.keyword } },
        { user: { phone: { contains: query.keyword } } },
        { wechatTransactionId: { contains: query.keyword } },
      ];
    }
    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: { package: true, user: { select: { id: true, phone: true, nickname: true } } },
      }),
      this.prisma.order.count({ where }),
    ]);
    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async confirmOrder(orderNo: string, note?: string) {
    const order = await this.orders.findOneByNo(orderNo);
    if (order.status === "paid") return { alreadyPaid: true, order };
    const res = await this.orders.markPaid(orderNo, { transactionId: "admin_manual_" + Date.now() });
    if (note) {
      await this.prisma.order.update({ where: { orderNo }, data: { adminNote: note } });
    }
    return res;
  }

  async listUsers(query: { keyword?: string; page?: number; limit?: number }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const where: any = {};
    if (query.keyword) {
      where.OR = [
        { phone: { contains: query.keyword } },
        { nickname: { contains: query.keyword } },
        { id: { contains: query.keyword } },
      ];
    }
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          phone: true,
          nickname: true,
          role: true,
          status: true,
          credits: true,
          createdAt: true,
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async adjustCredits(userId: string, amount: number, reason?: string) {
    if (!Number.isInteger(amount) || amount === 0) throw new BadRequestException("调整数量必须为非零整数");
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("用户不存在");
    if (amount < 0) {
      const tx = await this.credits.consumeCredits(userId, Math.abs(amount), reason || "管理员扣减积分");
      return { balance: (await this.credits.getBalance(userId)).balance, transaction: tx };
    }
    const tx = await this.credits.addCredits(userId, amount, "gift", reason || "管理员赠送积分", undefined, "admin");
    return { balance: (await this.credits.getBalance(userId)).balance, transaction: tx };
  }

  listTransactions(query: { page?: number; limit?: number; type?: string }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const where: any = query.type ? { type: query.type } : {};
    return Promise.all([
      this.prisma.creditTransaction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: { user: { select: { phone: true, nickname: true } } },
      }),
      this.prisma.creditTransaction.count({ where }),
    ]).then(([items, total]) => ({ items, total, page, limit, totalPages: Math.ceil(total / limit) }));
  }
}
