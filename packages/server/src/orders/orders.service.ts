import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

export interface PaidPayload {
  transactionId: string;
  amountTotal?: number;
}

/**
 * 积分充值订单：下单 → 微信 Native 支付 → 回调核销 → 入账（幂等）。
 */
@Injectable()
export class OrdersService {
  constructor(private prisma: PrismaService) {}

  private orderNo(prefix = "C") {
    const d = new Date();
    const p = (n: number, len = 2) => String(n).padStart(len, "0");
    const stamp =
      d.getFullYear() +
      p(d.getMonth() + 1) +
      p(d.getDate()) +
      p(d.getHours()) +
      p(d.getMinutes()) +
      p(d.getSeconds());
    return prefix + stamp + randomBytes(3).toString("hex");
  }

  async createCreditOrder(userId: string, packageId: string) {
    const pkg = await this.prisma.creditPackage.findUnique({ where: { id: packageId } });
    if (!pkg || !pkg.isActive) throw new NotFoundException("积分套餐不存在或已下架");
    const order = await this.prisma.order.create({
      data: {
        userId,
        packageId: pkg.id,
        orderNo: this.orderNo(),
        amount: pkg.price,
        credits: pkg.credits,
        payMethod: "wechat",
        status: "pending",
        expiredAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    });
    return { order, pkg };
  }

  async attachPrepay(orderId: string, data: { prepayId?: string; codeUrl?: string; payChannel?: string }) {
    return this.prisma.order.update({
      where: { id: orderId },
      data: { ...data, prepayId: data.prepayId ?? null, codeUrl: data.codeUrl ?? null },
    });
  }

  async findMine(userId: string, page = 1, limit = 20) {
    const skip = (Number(page) - 1) * Number(limit);
    const where = { userId };
    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: Number(limit),
        include: { package: true },
      }),
      this.prisma.order.count({ where }),
    ]);
    return { items, total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / Number(limit)) };
  }

  async findOne(userId: string, orderNo: string) {
    const order = await this.prisma.order.findFirst({ where: { orderNo, userId }, include: { package: true } });
    if (!order) throw new NotFoundException("订单不存在");
    return order;
  }

  async findOneById(id: string) {
    const order = await this.prisma.order.findUnique({ where: { id }, include: { package: true, user: true } });
    if (!order) throw new NotFoundException("订单不存在");
    return order;
  }

  async findOneByNo(orderNo: string) {
    const order = await this.prisma.order.findUnique({ where: { orderNo }, include: { package: true } });
    if (!order) throw new NotFoundException("订单不存在");
    return order;
  }

  /** 支付成功入账：条件更新占位，重复回调/并发回调只会入账一次 */
  async markPaid(orderNo: string, payload: PaidPayload) {
    // 金额校验必须在事务外完成：事务内抛异常会回滚 status=amount_mismatch 的落库
    const pre = await this.prisma.order.findUnique({ where: { orderNo } });
    if (!pre) throw new NotFoundException("订单不存在");
    if (pre.status === "pending" && payload.amountTotal !== undefined && payload.amountTotal !== null && Number(payload.amountTotal) !== pre.amount) {
      await this.prisma.order.update({
        where: { id: pre.id },
        data: { status: "amount_mismatch", wechatTransactionId: payload.transactionId ?? null },
      });
      throw new BadRequestException("支付金额与订单金额不一致，已冻结订单并标记待人工核对");
    }
    return this.prisma.$transaction(async (db) => {
      const order = await db.order.findUnique({ where: { orderNo }, include: { package: true } });
      if (!order) throw new NotFoundException("订单不存在");
      if (order.status === "paid") {
        return { alreadyPaid: true, order, credited: 0 };
      }
      if (order.status !== "pending") {
        throw new BadRequestException("订单状态为「" + order.status + "」，无法确认支付");
      }
      if (
        payload.amountTotal !== undefined &&
        payload.amountTotal !== null &&
        Number(payload.amountTotal) !== order.amount
      ) {
        await db.order.update({
          where: { id: order.id },
          data: { status: "amount_mismatch", wechatTransactionId: payload.transactionId ?? null },
        });
        throw new BadRequestException("支付金额与订单金额不一致，已冻结订单并标记待人工核对");
      }
      const claimed = await db.order.updateMany({
        where: { id: order.id, status: "pending" },
        data: {
          status: "paid",
          paidAt: new Date(),
          notifyAt: new Date(),
          wechatTransactionId: payload.transactionId ?? null,
        },
      });
      if (claimed.count === 0) return { alreadyPaid: true, order, credited: 0 };

      const users = await db.$queryRaw<Array<{ id: string; credits: number }>>`SELECT id, credits FROM User WHERE id = ${order.userId} FOR UPDATE`;
      const user = users[0];
      if (!user) throw new BadRequestException("订单用户不存在");
      const balanceBefore = user.credits;
      const balanceAfter = balanceBefore + order.credits;
      await db.user.update({
        where: { id: user.id },
        data: { credits: balanceAfter, totalCreditsRecharged: { increment: order.credits } },
      });
      await db.creditTransaction.create({
        data: {
          userId: user.id,
          type: "recharge",
          amount: order.credits,
          balanceBefore,
          balanceAfter,
          description: "购买" + (order.package?.name ?? "积分套餐") + "：" + order.credits + " 积分",
          relatedOrderId: order.id,
        },
      });
      return { alreadyPaid: false, order, credited: order.credits, balanceAfter };
    });
  }

  /** 把超时未支付订单标记为 expired（惰性执行，无定时器依赖） */
  async expireStale(userId?: string) {
    const res = await this.prisma.order.updateMany({
      where: { status: "pending", expiredAt: { lt: new Date() }, ...(userId ? { userId } : {}) },
      data: { status: "expired" },
    });
    return res.count;
  }
}
