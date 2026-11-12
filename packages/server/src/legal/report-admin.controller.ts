import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import { Roles } from "../common/decorators";
import { ReportService } from "./report.service";

/**
 * 管理端举报工单（P45-4）。
 * 与 LegalController 同属 LegalModule，但守卫生效（@Roles("admin")，全局 RolesGuard）。
 * 路径刻意放在 /admin/reports 而不是 /legal/admin/*：后台路由统一在 /admin 前缀下更好做权限审计。
 */
@Controller("admin/reports")
@Roles("admin")
export class ReportAdminController {
  constructor(private readonly reports: ReportService) {}

  @Get()
  list(@Query("status") status?: string, @Query("category") category?: string, @Query("limit") limit?: string) {
    return this.reports.list({ status, category, limit });
  }

  @Post(":id/resolve")
  @HttpCode(HttpStatus.OK)
  resolve(@Param("id") id: string, @Body() body: any) {
    return this.reports.resolve(id, body || {});
  }
}
