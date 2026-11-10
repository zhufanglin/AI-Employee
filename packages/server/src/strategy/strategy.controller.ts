import { Body, Controller, Get, Put, Req } from "@nestjs/common";
import { StrategyService } from "./strategy.service";

/** 战略文档 REST（前缀 /api/strategy，全局 JWT 守卫）。 */
@Controller("strategy")
export class StrategyController {
  constructor(private readonly service: StrategyService) {}

  @Get()
  get(@Req() req: any) {
    return this.service.get(req.user);
  }

  @Put()
  save(@Req() req: any, @Body() body: any) {
    return this.service.save(req.user, body);
  }

  @Get("iterations")
  iterations(@Req() req: any) {
    return this.service.iterations(req.user);
  }
}
