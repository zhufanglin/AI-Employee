import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { ComposeVideosService } from "./compose-videos.service";
import { Public } from "../common/decorators";

@Controller("compose-videos")
export class ComposeVideosController {
  constructor(private readonly service: ComposeVideosService) {}

  @Post()
  create(@Req() req: any, @Body() body: any) {
    return this.service.create(req.user, body);
  }

  @Get()
  query(@Req() req: any, @Query() query: any) {
    return this.service.query(req.user, query);
  }

  @Patch(":id")
  update(@Req() req: any, @Param("id") id: string, @Body() body: any) {
    return this.service.update(req.user, id, body);
  }

  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.service.remove(req.user, id);
  }

  @Post(":id/transfer-oss")
  transfer(@Req() req: any, @Param("id") id: string) {
    return this.service.transfer(req.user, id);
  }

  /** 上游 MuseTalk 回调：外部系统调用，无 JWT（与原版一致）；放在 :id 系列之后声明避免被通配 */
  @Public()
  @Post("musetalk-callback")
  callback(@Body() body: any) {
    return this.service.callback(body);
  }
}
