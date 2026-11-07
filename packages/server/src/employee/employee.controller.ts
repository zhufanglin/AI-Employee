import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
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

  @Get("marketplace")
  marketplace(@Query() query: any) {
    return this.employees.catalog(query);
  }

  @Get("mine")
  mine(@Req() req: any) {
    return this.employees.mine(req.user.id);
  }

  @Get("my")
  my(@Req() req: any) {
    return this.employees.mine(req.user.id);
  }

  @Get(":slug")
  detail(@Param("slug") slug: string) {
    return this.employees.detail(slug);
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
