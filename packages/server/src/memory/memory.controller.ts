import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { MemoryService } from "./memory.service";

/** 记忆管理页 REST（前缀 /api/memory，全局 JWT 守卫） */
@Controller("memory")
export class MemoryController {
  constructor(private readonly service: MemoryService) {}

  @Get("list")
  list(@Req() req: any, @Query() query: any) {
    return this.service.list(req.user, query);
  }

  @Get("stats")
  stats(@Req() req: any) {
    return this.service.stats(req.user);
  }

  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.service.remove(req.user, id);
  }

  @Post("merge")
  @HttpCode(200)
  merge(@Req() req: any, @Body() body: any) {
    return this.service.merge(req.user, body);
  }

  @Post("dedupe")
  @HttpCode(200)
  dedupe(@Req() req: any, @Body() body: any) {
    return this.service.dedupe(req.user, body);
  }
}
