import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { Roles } from "../common/decorators";
import { AdminService } from "./admin.service";

@Controller("admin")
@Roles("admin")
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get("overview")
  overview() {
    return this.admin.overview();
  }

  @Get("packages")
  packages(@Query("all") all?: string) {
    return this.admin.listPackages(all !== "0");
  }

  @Post("packages")
  createPackage(@Body() body: any) {
    return this.admin.createPackage(body);
  }

  @Patch("packages/:id")
  updatePackage(@Param("id") id: string, @Body() body: any) {
    return this.admin.updatePackage(id, body);
  }

  @Delete("packages/:id")
  deletePackage(@Param("id") id: string) {
    return this.admin.deletePackage(id);
  }

  @Get("orders")
  orders(@Query() query: any) {
    return this.admin.listOrders(query);
  }

  @Post("orders/:orderNo/confirm")
  confirm(@Param("orderNo") orderNo: string, @Body() body: any) {
    return this.admin.confirmOrder(orderNo, body?.note);
  }

  @Get("users")
  users(@Query() query: any) {
    return this.admin.listUsers(query);
  }

  @Post("users/:id/credits")
  adjust(@Param("id") id: string, @Body() body: any) {
    return this.admin.adjustCredits(id, Number(body?.amount), body?.reason);
  }

  @Get("credit-transactions")
  transactions(@Query() query: any) {
    return this.admin.listTransactions(query);
  }
}
