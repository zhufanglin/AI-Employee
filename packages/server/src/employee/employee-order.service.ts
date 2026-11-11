import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/** 原版 employee-order.service.js 的购买时长选项 */
export const DURATION_OPTIONS = [
  { label: "1天", days: 1 },
  { label: "周", days: 7 },
  { label: "月", days: 30 },
  { label: "季度", days: 90 },
  { label: "年", days: 365 },
];
const VALID_DAYS = DURATION_OPTIONS.map((o) => o.days);
/** 未支付订单 30 分钟过期（原版 expiredAt = now + 30min） */
const ORDER_TTL_MS = 30 * 60 * 1000;
/**
 * 员工订单号前缀：EO + yyyyMMddHHmmss + 6 位随机。
 * 微信支付回调据此区分员工订单与积分订单（积分订单前缀为 C）。
 */
export const EMPLOYEE_ORDER_NO_PREFIX = "EO";

function generateOrderNo(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds());
  return `${EMPLOYEE_ORDER_NO_PREFIX}${stamp}${Math.floor(Math.random() * 1000000).toString().padStart(6, "0")}`;
}

@Injectable()
export class EmployeeOrderService {
  constructor(private readonly prisma: PrismaService) {}

  durationOptions() {
    return DURATION_OPTIONS;
  }

  /** 按天购买员工：totalAmount = pricePerDay * durationDays（原版语义） */
  async createOrder(userId: string, slug: string, durationDaysRaw: unknown) {
    const emp = await this.prisma.aiEmployee.findUnique({ where: { slug } });
    if (!emp || !emp.isActive) throw new NotFoundException("员工不存在或已下架");
    if (emp.isBundled) throw new BadRequestException("预装员工无需购买");
    if (emp.price <= 0) throw new BadRequestException("免费员工请直接添加，无需下单");
    const durationDays = Number(durationDaysRaw);
    if (!VALID_DAYS.includes(durationDays)) throw new BadRequestException("无效的购买天数");

    const now = new Date();
    const order = await this.prisma.employeeOrder.create({
      data: {
        userId,
        employeeId: emp.id,
        employeeSlug: emp.slug,
        orderNo: generateOrderNo(),
        durationDays,
        pricePerDay: emp.price,
        totalAmount: emp.price * durationDays,
        payMethod: "wechat",
        status: "pending",
        expiredAt: new Date(now.getTime() + ORDER_TTL_MS),
      },
    });
    return {
      order,
      employee: { slug: emp.slug, name: emp.name, price: emp.price, priceDisplay: emp.priceDisplay },
      amount: order.totalAmount,
      /** 微信支付在 T-12 接入；未配置时只能用管理员 mark-paid 手工开通 */
      payHint: "支付渠道尚未开通，请联系管理员在后台确认收款后开通",
    };
  }

  async mine(userId: string) {
    const rows = await this.prisma.employeeOrder.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const now = Date.now();
    const items = rows.map((o) => ({
      ...o,
      /** pending 且已过期 → 视为 closed */
      expired: o.status === "pending" && o.expiredAt.getTime() <= now,
    }));
    return { items, total: items.length, durationOptions: DURATION_OPTIONS };
  }

  /** 既能按 orderNo 查，也能按主键 id 查（原版 /employee-orders/:id/status 传的是 id） */
  private async findOwn(userId: string, ref: string) {
    const order = await this.prisma.employeeOrder.findFirst({ where: { OR: [{ orderNo: ref }, { id: ref }] } });
    if (!order) throw new NotFoundException("订单不存在");
    if (order.userId !== userId) throw new ForbiddenException("无权查看该订单");
    return order;
  }

  async status(userId: string, orderNo: string) {
    const order = await this.findOwn(userId, orderNo);
    const now = Date.now();
    return { ...order, expired: order.status === "pending" && order.expiredAt.getTime() <= now };
  }

  /**
   * 前台发起微信支付前的校验：订单归属 → pending → 未超过 30 分钟支付窗口。
   * 已超时的 pending 顺手置为 closed（与 mine/expireScan 的惰性口径一致）。
   */
  async findPayable(userId: string, ref: string) {
    const order = await this.findOwn(userId, ref);
    if (order.status === "pending" && order.expiredAt.getTime() <= Date.now()) {
      await this.prisma.employeeOrder.updateMany({
        where: { id: order.id, status: "pending" },
        data: { status: "closed" },
      });
      throw new BadRequestException("订单已过期，请重新下单");
    }
    if (order.status !== "pending") {
      throw new BadRequestException("订单状态为「" + order.status + "」，无法支付");
    }
    return order;
  }

  /** 管理员确认收款（手工开通；支付回调复用同一函数，amountTotal 仅在回调传） */
  async markPaid(orderId: string, params: { transactionId?: string; amountTotal?: number } = {}) {
    const order = await this.prisma.employeeOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException("订单不存在");
    // 已支付直接返回：微信重复回调不会重复开通/续期
    if (order.status === "paid") return this.statusForAdmin(order.id);
    // 金额校验在事务外：与积分订单一致，异常时不回滚 amount_mismatch 落库
    if (
      order.status === "pending" &&
      params.amountTotal !== undefined &&
      params.amountTotal !== null &&
      Number(params.amountTotal) !== order.totalAmount
    ) {
      await this.prisma.employeeOrder.update({
        where: { id: order.id },
        data: { status: "amount_mismatch", wechatTransactionId: params.transactionId ?? null },
      });
      throw new BadRequestException("支付金额与订单金额不一致，已冻结订单并标记待人工核对");
    }
    if (order.status !== "pending") throw new BadRequestException("订单状态不允许确认收款");

    const now = new Date();
    const expiresAt = new Date(now.getTime() + order.durationDays * 86400000);
    await this.prisma.$transaction(async (tx) => {
      // 条件更新占位：并发回调/重复点击只有一次能把 pending 改成 paid，避免重复续期
      const claimed = await tx.employeeOrder.updateMany({
        where: { id: order.id, status: "pending" },
        data: {
          status: "paid",
          paidAt: now,
          wechatTransactionId: params.transactionId ?? null,
          employeeExpiresAt: expiresAt,
        },
      });
      if (claimed.count === 0) return;
      const existing = await tx.aiEmployeePurchase.findUnique({
        where: { userId_employeeId: { userId: order.userId, employeeId: order.employeeId } },
      });
      const base =
        existing?.expiresAt && existing.expiresAt.getTime() > now.getTime() ? existing.expiresAt : now;
      const newExpiry = new Date(base.getTime() + order.durationDays * 86400000);
      await tx.aiEmployeePurchase.upsert({
        where: { userId_employeeId: { userId: order.userId, employeeId: order.employeeId } },
        update: {
          status: "active",
          expiresAt: newExpiry,
          durationDays: order.durationDays,
          orderNo: order.orderNo,
          pricePerDay: order.pricePerDay,
          purchasedAt: now,
        },
        create: {
          userId: order.userId,
          employeeId: order.employeeId,
          employeeSlug: order.employeeSlug,
          status: "active",
          purchasedAt: now,
          expiresAt: newExpiry,
          durationDays: order.durationDays,
          orderNo: order.orderNo,
          pricePerDay: order.pricePerDay,
        },
      });
      // 授权后立即把安装记录的到期时间同步（幂等）
      await tx.aiEmployeeInstall.updateMany({
        where: { userId: order.userId, employeeId: order.employeeId },
        data: { enabled: true, expiresAt: newExpiry },
      });
    });
    return this.statusForAdmin(order.id);
  }

  /**
   * 支付回调入口：按 orderNo 查单后复用 markPaid 的开通路径（不另复制一份）。
   * alreadyPaid 用于回调返回值/日志，真正的幂等由 markPaid 的条件更新保证。
   */
  async markPaidByOrderNo(orderNo: string, params: { transactionId?: string; amountTotal?: number } = {}) {
    const order = await this.prisma.employeeOrder.findUnique({ where: { orderNo } });
    if (!order) throw new NotFoundException("订单不存在");
    const alreadyPaid = order.status === "paid";
    const updated = await this.markPaid(order.id, params);
    return { order: updated, alreadyPaid };
  }

  private async statusForAdmin(id: string) {
    const rows = await this.prisma.employeeOrder.findMany({ where: { id } });
    return rows[0];
  }

  /** 管理员订单列表 */
  async adminList(query: any) {
    const page = Math.max(1, Number(query?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query?.limit) || 20));
    const where: any = {};
    if (query?.status) where.status = query.status;
    const [total, items] = await Promise.all([
      this.prisma.employeeOrder.count({ where }),
      this.prisma.employeeOrder.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    ]);
    return { total, page, limit, items };
  }

  /** 到期失效扫描（供定时任务/巡检调用；install/run 已实时判定） */
  async expireEmployees() {
    const now = new Date();
    const res = await this.prisma.aiEmployeePurchase.updateMany({
      where: { status: "active", expiresAt: { lte: now } },
      data: { status: "expired" },
    });
    const closed = await this.prisma.employeeOrder.updateMany({
      where: { status: "pending", expiredAt: { lte: now } },
      data: { status: "closed" },
    });
    return { expiredPurchases: res.count, closedOrders: closed.count };
  }
}
