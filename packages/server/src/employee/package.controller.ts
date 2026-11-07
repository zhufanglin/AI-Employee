import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { Public, Roles } from "../common/decorators";
import { EmployeeOrderService } from "./employee-order.service";
import { PackageService } from "./package.service";

/** 套餐：三档预设 + 我的授权 */
@Controller("packages")
export class PackagesController {
  constructor(private readonly packages: PackageService) {}

  @Public()
  @Get()
  list() {
    return { items: this.packages.presets() };
  }

  @Public()
  @Get("presets")
  presets() {
    return { items: this.packages.presets() };
  }

  @Get("mine")
  mine(@Req() req: any) {
    return this.packages.mine(req.user.id);
  }

  /** 兑换码核销（客户端主入口 /redemption/redeem 的别名） */
  @Post("redeem")
  redeem(@Req() req: any, @Body() body: any) {
    return this.packages.redeem(req.user.id, body?.code);
  }
}

/** 兑换码：原版 redeem 返回 {packageId, validDays}，这里额外带回 expiresAt 便于前端展示 */
@Controller("redemption")
export class RedemptionController {
  constructor(private readonly packages: PackageService) {}

  @Post("redeem")
  redeem(@Req() req: any, @Body() body: any) {
    return this.packages.redeem(req.user.id, body?.code);
  }
}

/** 员工订单：按天购买（T-12 接入微信支付，此前由管理员 mark-paid 开通） */
@Controller("employee-orders")
export class EmployeeOrderController {
  constructor(private readonly orders: EmployeeOrderService) {}

  @Public()
  @Get("duration-options")
  durationOptions() {
    return { items: this.orders.durationOptions() };
  }

  @Post()
  create(@Req() req: any, @Body() body: any) {
    return this.orders.createOrder(req.user.id, body?.slug, body?.durationDays);
  }

  @Get("mine")
  mine(@Req() req: any) {
    return this.orders.mine(req.user.id);
  }

  @Get("my")
  my(@Req() req: any) {
    return this.orders.mine(req.user.id);
  }

  @Get(":id/status")
  statusById(@Req() req: any, @Param("id") id: string) {
    return this.orders.status(req.user.id, id);
  }

  @Get(":orderNo")
  status(@Req() req: any, @Param("orderNo") orderNo: string) {
    return this.orders.status(req.user.id, orderNo);
  }
}

// ---------------- 管理端 ----------------

@Roles("admin")
@Controller("admin/redemption")
export class AdminRedemptionController {
  constructor(private readonly packages: PackageService) {}

  @Post("batch")
  batch(@Body() body: any) {
    return this.packages.createCodes(body ?? {});
  }

  @Get()
  list(@Query() query: any) {
    return this.packages.listCodes(query);
  }
}

@Roles("admin")
@Controller("admin/packages")
export class AdminPackagesController {
  constructor(private readonly packages: PackageService) {}

  @Post("grant")
  grant(@Body() body: any) {
    return this.packages.adminGrant(body ?? {});
  }
}

@Roles("admin")
@Controller("admin/employee-orders")
export class AdminEmployeeOrderController {
  constructor(private readonly orders: EmployeeOrderService) {}

  @Get()
  list(@Query() query: any) {
    return this.orders.adminList(query);
  }

  @Post(":id/mark-paid")
  markPaid(@Param("id") id: string, @Body() body: any) {
    return this.orders.markPaid(id, body ?? {});
  }

  @Post("expire-scan")
  expireScan() {
    return this.orders.expireEmployees();
  }
}
