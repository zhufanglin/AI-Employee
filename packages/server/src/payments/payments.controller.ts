import { Body, Controller, Get, Headers, Param, Post, Query, Req } from "@nestjs/common";
import { Public } from "../common/decorators";
import { CurrentUser } from "../common/decorators";
import type { AuthUser } from "../common/auth-user";
import { PaymentsService } from "./payments.service";

@Controller("payments")
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get("wechat/status")
  @Public()
  status() {
    return this.payments.status();
  }

  @Post("orders")
  create(@CurrentUser() user: AuthUser, @Body() body: { packageId: string }) {
    return this.payments.createCreditOrder(user.id, body?.packageId);
  }

  @Get("orders/mine")
  mine(@CurrentUser() user: AuthUser, @Query("page") page?: string, @Query("limit") limit?: string) {
    return this.payments.findMine(user.id, Number(page) || 1, Number(limit) || 20);
  }

  @Get("orders/:orderNo")
  one(@CurrentUser() user: AuthUser, @Param("orderNo") orderNo: string) {
    return this.payments.findOne(user.id, orderNo);
  }

  @Get("orders/:orderNo/status")
  statusOf(@CurrentUser() user: AuthUser, @Param("orderNo") orderNo: string) {
    return this.payments.syncOrder(user.id, orderNo);
  }

  @Post("wechat/notify")
  @Public()
  async notify(@Headers() headers: Record<string, any>, @Req() req: any) {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    try {
      return await this.payments.handleNotify(headers, raw);
    } catch (err: any) {
      const message = err?.response?.error?.message ?? err?.message ?? "处理失败";
      return { code: "FAIL", message };
    }
  }

  @Post("wechat/mock-pay/:orderNo")
  @Public()
  mockPay(@Param("orderNo") orderNo: string) {
    return this.payments.mockPay(orderNo);
  }
}
