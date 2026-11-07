import { Body, Controller, Delete, Get, Param, Post, Req } from "@nestjs/common";
import { AudioMaterialsService } from "./audio-materials.service";

@Controller("audio-materials")
export class AudioMaterialsController {
  constructor(private readonly service: AudioMaterialsService) {}

  @Post("upload")
  upload(@Req() req: any, @Body() body: any) {
    return this.service.upload(req.user, body);
  }

  @Get()
  list(@Req() req: any) {
    return this.service.list(req.user);
  }

  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.service.remove(req.user, id);
  }
}
