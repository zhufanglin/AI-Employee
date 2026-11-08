import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from "@nestjs/common";
import { MemoryCleanupService } from "../capabilities/memory-cleanup.service";
import { Roles } from "../common/decorators";
import { AdminExtraService } from "./admin-extra.service";
import { AdminService } from "./admin.service";

/**
 * 管理端扩展路由：站点/集成配置、定价、兑换码、用户与员工管理、用量与统计。
 * 与 AdminController 共用 /admin 前缀（后者覆盖 overview/packages/orders/users 列表/流水）。
 * 注意：静态段 "employees/sort" 必须声明在参数段之前。
 */
@Controller("admin")
@Roles("admin")
export class AdminExtraController {
  constructor(
    private readonly extra: AdminExtraService,
    private readonly admin: AdminService,
    private readonly memoryCleanup: MemoryCleanupService,
  ) {}

  // ---------- 长期记忆清理（P22 定时任务） ----------
  /** 定时清理的状态：开关、周期、下次执行、上次结果。 */
  @Get("memory-cleanup")
  memoryCleanupStatus() {
    return this.memoryCleanup.status();
  }

  /** 立即手动跑一轮（默认 apply；body.mode=report 只出报告）。 */
  @Post("memory-cleanup/run")
  @HttpCode(HttpStatus.OK)
  memoryCleanupRun(@Body() body: any) {
    const mode = body && body.mode === "report" ? "report" : "apply";
    return this.memoryCleanup.runOnce("管理员手动", mode);
  }

  // ---------- 站点 / 集成 ----------
  @Get("site-config")
  siteConfig() {
    return this.extra.getSiteConfig();
  }

  @Put("site-config")
  updateSiteConfig(@Body() body: any) {
    return this.extra.updateSiteConfig(body);
  }

  @Get("ai-api-config")
  aiApiConfig() {
    return this.extra.getAiApiConfig();
  }

  @Put("ai-api-config")
  updateAiApiConfig(@Body() body: any) {
    return this.extra.updateAiApiConfig(body);
  }

  @Get("oss-config")
  ossConfig() {
    return this.extra.getOssConfig();
  }

  @Put("oss-config")
  updateOssConfig(@Body() body: any) {
    return this.extra.updateOssConfig(body);
  }

  @Get("sms-config")
  smsConfig() {
    return this.extra.getSmsConfig();
  }

  @Put("sms-config")
  updateSmsConfig(@Body() body: any) {
    return this.extra.updateSmsConfig(body);
  }

  @Post("sms-test")
  testSms(@Body() body: any) {
    return this.extra.testSms(body);
  }

  @Get("wechat-pay-config")
  wechatPayConfig() {
    return this.extra.getWechatPayConfig();
  }

  @Put("wechat-pay-config")
  updateWechatPayConfig(@Body() body: any) {
    return this.extra.updateWechatPayConfig(body);
  }

  @Get("system-info/piracy-warning")
  piracyWarning() {
    return this.extra.piracyWarning();
  }

  @Get("system-info")
  systemInfo() {
    return this.extra.getSystemInfo();
  }

  @Put("system-info")
  updateSystemInfo(@Body() body: any) {
    return this.extra.updateSystemInfo(body);
  }

  // ---------- 定价 ----------
  @Get("model-pricing")
  modelPricing() {
    return this.extra.listModelPricing();
  }

  @Post("model-pricing")
  createModelPricing(@Body() body: any) {
    return this.extra.createModelPricing(body);
  }

  @Put("model-pricing/:id")
  updateModelPricing(@Param("id") id: string, @Body() body: any) {
    return this.extra.updateModelPricing(id, body);
  }

  @Delete("model-pricing/:id")
  deleteModelPricing(@Param("id") id: string) {
    return this.extra.deleteModelPricing(id);
  }

  @Get("media-pricing")
  mediaPricing() {
    return this.extra.listMediaPricing();
  }

  @Post("media-pricing")
  createMediaPricing(@Body() body: any) {
    return this.extra.createMediaPricing(body);
  }

  @Put("media-pricing/:id")
  updateMediaPricing(@Param("id") id: string, @Body() body: any) {
    return this.extra.updateMediaPricing(id, body);
  }

  @Delete("media-pricing/:id")
  deleteMediaPricing(@Param("id") id: string) {
    return this.extra.deleteMediaPricing(id);
  }

  // ---------- 兑换码 ----------
  @Get("redemption-codes")
  redemptionCodes(@Query() query: any) {
    return this.extra.listRedemptionCodes(query);
  }

  @Put("redemption-codes/:id")
  updateRedemptionCode(@Param("id") id: string, @Body() body: any) {
    return this.extra.updateRedemptionCode(id, body);
  }

  @Delete("redemption-codes/:id")
  deleteRedemptionCode(@Param("id") id: string) {
    return this.extra.deleteRedemptionCode(id);
  }

  @Post("redemption-codes")
  createRedemptionCodes(@Body() body: any) {
    return this.extra.createRedemptionCodes(body);
  }

  // ---------- 用户 ----------
  @Post("users")
  createUser(@Body() body: any) {
    return this.extra.createUser(body);
  }

  @Put("users/:id/credits")
  adjustCredits(@Param("id") id: string, @Body() body: any) {
    return this.admin.adjustCredits(id, Number(body?.amount), body?.reason);
  }

  @Put("users/:id/status")
  updateUserStatus(@Param("id") id: string, @Body() body: any) {
    return this.extra.updateUserStatus(id, body);
  }

  @Put("users/:id/password")
  updateUserPassword(@Param("id") id: string, @Body() body: any) {
    return this.extra.updateUserPassword(id, body);
  }

  // ---------- 员工 ----------
  @Get("employees")
  employees() {
    return this.extra.listEmployees();
  }

  @Post("employees")
  createEmployee(@Body() body: any) {
    return this.extra.createEmployee(body);
  }

  @Put("employees/sort")
  sortEmployees(@Body() body: any) {
    return this.extra.sortEmployees(body);
  }

  @Put("employees/:id/toggle")
  toggleEmployee(@Param("id") id: string) {
    return this.extra.toggleEmployee(id);
  }

  @Get("employees/:id")
  employeeDetail(@Param("id") id: string) {
    return this.extra.employeeDetail(id);
  }

  @Put("employees/:id")
  updateEmployee(@Param("id") id: string, @Body() body: any) {
    return this.extra.updateEmployee(id, body);
  }

  @Delete("employees/:id")
  deleteEmployee(@Param("id") id: string) {
    return this.extra.deleteEmployee(id);
  }

  @Get("employee-purchases")
  employeePurchases(@Query() query: any) {
    return this.extra.listEmployeePurchases(query);
  }

  // ---------- 用量 ----------
  @Get("ai-usage-records")
  usageRecords(@Query() query: any) {
    return this.extra.listAiUsageRecords(query);
  }

  @Get("ai-usage-stats")
  usageStats(@Query() query: any) {
    return this.extra.aiUsageStats(query);
  }

  @Get("usage/summary")
  usageSummary(@Query() query: any) {
    return this.extra.aiUsageStats(query);
  }

  @Get("usage/by-model")
  async usageByModel(@Query() query: any) {
    const s = await this.extra.aiUsageStats(query);
    return s.modelBreakdown;
  }

  @Get("usage/by-user")
  async usageByUser(@Query() query: any) {
    const s = await this.extra.aiUsageStats(query);
    return s.userBreakdown;
  }

  @Get("usage/daily")
  usageDaily(@Query("days") days?: string) {
    return this.extra.dailyUsage(Number(days) || 30);
  }

  @Get("usage/details")
  usageDetails(@Query() query: any) {
    return this.extra.listAiUsageRecords(query);
  }

  // ---------- 上传 ----------
  @Post("upload-customer-service-qr")
  uploadQr(@Body() body: any) {
    return this.extra.uploadAsset("customer-service-qr", body);
  }

  @Post("upload-win-client")
  uploadWin(@Body() body: any) {
    return this.extra.uploadAsset("win-client", body);
  }

  @Post("upload-mac-client")
  uploadMac(@Body() body: any) {
    return this.extra.uploadAsset("mac-client", body);
  }

  @Post("employees/upload-avatar")
  uploadAvatar(@Body() body: any) {
    return this.extra.uploadAsset("employee-avatar", body);
  }

  @Post("system-info/detect-ip")
  detectIp() {
    return this.extra.detectIp();
  }

  @Post("system-info/verify")
  verifySystem() {
    return this.extra.verifySystem();
  }

  // ---------- 统计 ----------
  @Get("statistics/overview")
  statisticsOverview() {
    return this.admin.overview();
  }

  @Get("statistics/revenue")
  statisticsRevenue(@Query("days") days?: string) {
    return this.extra.statisticsRevenue(Number(days) || 30);
  }

  @Get("statistics/users")
  statisticsUsers(@Query("days") days?: string) {
    return this.extra.statisticsUsers(Number(days) || 30);
  }

  @Get("statistics/credits")
  statisticsCredits() {
    return this.extra.statisticsCredits();
  }

  @Get("statistics/team")
  statisticsTeam() {
    return this.extra.statisticsTeam();
  }
}
