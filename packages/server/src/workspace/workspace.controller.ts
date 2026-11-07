import { Body, Controller, Get, Post, Query, Req } from "@nestjs/common";
import { WorkspaceService } from "./workspace.service";

@Controller("workspace")
export class WorkspaceController {
  constructor(private readonly service: WorkspaceService) {}

  @Post("upload")
  upload(@Req() req: any, @Body() body: any) {
    return this.service.upload(req.user, body);
  }

  @Get("files")
  files(@Req() req: any, @Query("limit") limit?: string) {
    return this.service.list(req.user, limit);
  }

  @Post("delete")
  remove(@Req() req: any, @Body() body: any) {
    return this.service.remove(req.user, body);
  }
}
