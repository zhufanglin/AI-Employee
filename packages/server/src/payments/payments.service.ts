import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { env, envInt } from "../common/env";
import { OrdersService } from "../orders/orders.service";
import { WechatPayService } from "./wechat-pay.service";

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger("Payments");

  constructor(
    private readonly orders: OrdersService,
    private readonly wechat: WechatPayService,
  ) {}

  async createCreditOrder(userId: string, packageId: string) {
    const { order, pkg } = await this.orders.createCreditOrder(userId, packageId);
    if (!this.wechat.isConfigured()) {
      throw new BadGatewayException({
        error: { message: "微信支付尚未配置完成，请联系管理员", code: "WECHAT_PAY_NOT_CONFIGURED" },
      });
    }
    const native = await this.wechat.createNativeOrder({
      orderNo: order.orderNo,
      description: "积分充值-" + pkg.name,
      amount: order.amount,
      attach: pkg.id,
      timeExpire: new Date(Math.min(order.expiredAt.getTime(), Date.now() + 30 * 60 * 1000)),
    });
    const updated = await this.orders.attachPrepay(order.id, { codeUrl: native.codeUrl, payChannel: "native" });
    return {
      orderNo: updated.orderNo,
      amount: updated.amount,
      credits: updated.credits,
      codeUrl: native.codeUrl,
      mock: native.mock,
      expiredAt: updated.expiredAt,
      packageName: pkg.name,
    };
  }

  /** 主动查单同步（前端轮询二维码支付结果时用；生产环境仍以回调为准） */
  async syncOrder(userId: string, orderNo: string) {
    await this.orders.expireStale(userId);
    let order = await this.orders.findOne(userId, orderNo);
    if (order.status !== "pending" || this.wechat.credentials().mock) {
      return this.publicView(order);
    }
    try {
      const remote = await this.wechat.queryOrder(orderNo);
      if (remote.tradeState === "SUCCESS") {
        await this.orders.markPaid(orderNo, {
          transactionId: remote.transactionId ?? "",
          amountTotal: remote.amountTotal,
        });
        order = await this.orders.findOne(userId, orderNo);
      }
    } catch (err: any) {
      this.logger.warn("sync order failed: " + (err?.message ?? err));
    }
    return this.publicView(order);
  }

  async handleNotify(headers: Record<string, any>, rawBody: string) {
    const result = await this.wechat.parseNotify(headers, rawBody);
    if (result.tradeState !== "SUCCESS") {
      this.logger.log("notify ignored: order=" + result.orderNo + " state=" + result.tradeState);
      return { handled: false, reason: "trade_state_" + result.tradeState };
    }
    const paid = await this.orders.markPaid(result.orderNo, {
      transactionId: result.transactionId,
      amountTotal: result.amountTotal,
    });
    this.logger.log(
      "notify paid: order=" + result.orderNo + " tx=" + result.transactionId + " credited=" + paid.credited + " already=" + paid.alreadyPaid,
    );
    return { handled: true, orderNo: result.orderNo, credited: paid.credited, alreadyPaid: paid.alreadyPaid };
  }

  /** 仅 WECHAT_PAY_MOCK=1 时可用：模拟支付成功回调 */
  async mockPay(orderNo: string) {
    if (env("WECHAT_PAY_MOCK", "0") !== "1") {
      throw new NotFoundException("接口不存在");
    }
    const order = await this.orders.findOneByNo(orderNo);
    if (order.status !== "pending") throw new BadRequestException("订单状态为「" + order.status + "」，无法支付");
    return this.orders.markPaid(orderNo, {
      transactionId: "mock_" + Date.now(),
      amountTotal: order.amount,
    });
  }

  findMine(userId: string, page?: number, limit?: number) {
    return this.orders.findMine(userId, page, limit);
  }

  findOne(userId: string, orderNo: string) {
    return this.orders.findOne(userId, orderNo);
  }

  status() {
    return { ...this.wechat.status(), currency: "CNY", channel: "native" };
  }

  private publicView(order: any) {
    return {
      orderNo: order.orderNo,
      amount: order.amount,
      credits: order.credits,
      status: order.status,
      paidAt: order.paidAt,
      expiredAt: order.expiredAt,
      codeUrl: order.codeUrl,
      packageName: order.package?.name,
    };
  }
}
