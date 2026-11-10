import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req } from "@nestjs/common";
import { StrategyService } from "./strategy.service";

/** 人设规划表 REST（前缀 /api/personas，全局 JWT 守卫）。 */
@Controller("personas")
export class PersonaController {
  constructor(private readonly service: StrategyService) {}

  @Get()
  list(@Req() req: any) {
    return this.service.personas(req.user);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  upsert(@Req() req: any, @Body() body: any) {
    return this.service.upsertPersona(req.user, body);
  }

  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.service.removePersona(req.user, id);
  }
}
