import { Body, Controller, Get, Param, Post, Query, Req, UnauthorizedException } from "@nestjs/common";
import { MediaService } from "./media.service";
import { Public, Roles } from "../common/decorators";

@Controller("media")
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post("apps/indextts/submit") submitTts(@Req() req: any, @Body() body: any) { return this.media.submit(req.user.id, "indextts", body); }
  @Post("apps/lipsync/submit") submitLipsync(@Req() req: any, @Body() body: any) { return this.media.submit(req.user.id, "lipsync", body); }
  @Post("apps/smart_clip/realman_broadcast") realman(@Req() req: any, @Body() body: any) { return this.media.submit(req.user.id, "smart_clip", { ...body, mode: "realman_broadcast" }); }
  @Post("apps/smart_clip/broadcast_mixcut") broadcast(@Req() req: any, @Body() body: any) { return this.media.submit(req.user.id, "smart_clip", { ...body, mode: "broadcast_mixcut" }); }
  @Post("apps/smart_clip/news_mixcut") news(@Req() req: any, @Body() body: any) { return this.media.submit(req.user.id, "smart_clip", { ...body, mode: "news_mixcut" }); }
  @Post("images/generations") image(@Req() req: any, @Body() body: any) { return this.media.submit(req.user.id, "image_gen", body); }
  @Post("video/generations") video(@Req() req: any, @Body() body: any) { return this.media.submit(req.user.id, "video_gen", body); }
  @Get("apps/smart_clip/template") template() { return this.media.template(); }
  @Get("usage/summary") usage(@Req() req: any, @Query("days") days?: string) { return this.media.usageSummary(req.user.id, days); }
  @Get("tasks/:taskId") task(@Req() req: any, @Param("taskId") taskId: string) { return this.media.getTask(req.user.id, taskId); }
  @Post("tasks/:taskId/cancel") cancel(@Req() req: any, @Param("taskId") taskId: string) { return this.media.cancelTask(req.user.id, taskId); }
  @Public()
  @Post("tasks/:taskId/webhook") webhook(@Req() req: any, @Param("taskId") taskId: string, @Body() body: any) {
    const secret = process.env.RUNNINGHUB_WEBHOOK_SECRET;
    if (!secret || req.headers["x-runninghub-webhook-secret"] !== secret) throw new UnauthorizedException("媒体回调未配置或签名无效");
    return this.media.webhook(taskId, body);
  }
  @Post("files/upload") upload(@Req() req: any, @Body() body: any) { return this.media.upload(req.user.id, body); }
  @Post("files/temp") temp(@Req() req: any, @Body() body: any) { return this.media.tempFile(req.user.id, body); }
  @Post("files/oss-transfer") transfer(@Req() req: any, @Body() body: any) { return this.media.ossTransfer(req.user.id, body); }
}

@Controller("admin/media")
@Roles("admin")
export class AdminMediaUsageController {
  constructor(private readonly media: MediaService) {}
  @Get("usage") usage(@Query("days") days?: string) { return this.media.usageSummary(undefined, days); }
  @Get("pending-review") pendingReview() { return this.media.pendingReviews(); }
  @Post("pending-review/:taskId/resolve") resolveReview(@Req() req: any, @Param("taskId") taskId: string, @Body() body: any) { return this.media.resolveReview(taskId, req.user.id, body); }
}
