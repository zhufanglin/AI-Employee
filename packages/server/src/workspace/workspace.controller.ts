import { Body, Controller, Get, Post, Query, Req, Res, StreamableFile } from "@nestjs/common";
import type { Response } from "express";
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

  @Get("download")
  async download(@Req() req: any, @Query("key") key: string, @Res({ passthrough: true }) res: Response) {
    const file = await this.service.download(req.user, key);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(file.name));
    res.setHeader("Content-Type", "application/octet-stream");
    return new StreamableFile(file.bytes);
  }

  @Post("delete")
  remove(@Req() req: any, @Body() body: any) {
    return this.service.remove(req.user, body);
  }
}
