import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { OptionalAuth, Public } from "../common/decorators";
import { EmployeeCronService } from "./employee-cron.service";
import { EmployeeService } from "./employee.service";

/** 员工目录 / 安装 / 运行（M6.5） */
@Controller("employees")
export class EmployeeController {
  constructor(private readonly employees: EmployeeService) {}

  @Get("catalog")
  catalog(@Query() query: any) {
    return this.employees.catalog(query);
  }

  // 原版员工市场游客可浏览（employee.controller.js:41-62），登录用户额外带购买状态
  @Public()
  @OptionalAuth()
  @Get("marketplace")
  marketplace(@Query() query: any, @Req() req: any) {
    return this.employees.marketplace(query, req.user?.id);
  }

  @Get("mine")
  mine(@Req() req: any) {
    return this.employees.mine(req.user.id);
  }

  @Get("my")
  my(@Req() req: any) {
    return this.employees.mine(req.user.id);
  }

  // 原版员工详情同样允许游客查看（安装/运行仍然需要登录与授权）
  @Public()
  @OptionalAuth()
  @Get(":slug")
  detail(@Param("slug") slug: string, @Req() req: any) {
    return this.employees.detail(slug, !!req.user?.id);
  }

  @Post(":slug/install")
  install(@Req() req: any, @Param("slug") slug: string, @Body() body: any) {
    return this.employees.install(req.user.id, slug, body);
  }

  @Delete(":slug/install")
  uninstall(@Req() req: any, @Param("slug") slug: string) {
    return this.employees.uninstall(req.user.id, slug);
  }

  @Delete("my/:slug")
  uninstallLegacy(@Req() req: any, @Param("slug") slug: string) {
    return this.employees.uninstall(req.user.id, slug);
  }

  @Post(":slug/run")
  run(@Req() req: any, @Param("slug") slug: string, @Body() body: any) {
    return this.employees.run(req.user.id, slug, body);
  }
}

/** 任务：列表 / 端上拉取 / 状态回写 / 验收 */
@Controller("employee-tasks")
export class EmployeeTaskController {
  constructor(private readonly employees: EmployeeService) {}

  @Get("pull")
  pull(@Req() req: any, @Query("limit") limit?: string) {
    return this.employees.pullTasks(req.user.id, limit);
  }

  @Get()
  list(@Req() req: any, @Query() query: any) {
    return this.employees.listTasks(req.user.id, query);
  }

  @Get(":id")
  get(@Req() req: any, @Param("id") id: string) {
    return this.employees.getTask(req.user.id, id);
  }

  @Patch(":id")
  update(@Req() req: any, @Param("id") id: string, @Body() body: any) {
    return this.employees.updateTask(req.user.id, id, body);
  }

  @Post(":id/approve")
  approve(@Req() req: any, @Param("id") id: string, @Body() body: any) {
    return this.employees.approve(req.user.id, id, body);
  }

  @Post(":id/reject")
  reject(@Req() req: any, @Param("id") id: string, @Body() body: any) {
    return this.employees.reject(req.user.id, id, body);
  }
}

@Controller("employee-crons")
export class EmployeeCronController {
  constructor(private readonly crons: EmployeeCronService) {}
  @Get() list(@Req() req: any) { return this.crons.list(req.user.id); }
  @Post() create(@Req() req: any, @Body() body: any) { return this.crons.create(req.user.id, body); }
  @Patch(":id") update(@Req() req: any, @Param("id") id: string, @Body() body: any) { return this.crons.update(req.user.id, id, body); }
  @Delete(":id") remove(@Req() req: any, @Param("id") id: string) { return this.crons.remove(req.user.id, id); }
}

@Controller("workbench")
export class WorkbenchController {
  constructor(private readonly crons: EmployeeCronService) {}
  @Get("summary") summary(@Req() req: any) { return this.crons.summary(req.user.id); }
}
