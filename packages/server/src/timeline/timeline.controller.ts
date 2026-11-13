import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { TimelineService } from "./timeline.service";

/**
 * 时间线剪辑（第二步）：素材上传 → 创建任务 → 轮询 → /uploads 取成片。
 * 这是复刻版新增能力（原版 0.4.29 没有时间线剪辑），路由前缀 /api/timeline。
 */
@Controller("timeline")
export class TimelineController {
  constructor(private readonly service: TimelineService) {}

  /** 上传一段素材（base64），返回可复用的 /uploads 引用与时长/分辨率 */
  @Post("sources")
  upload(@Req() req: any, @Body() body: any) {
    return this.service.uploadSource(req.user, body);
  }

  /** 创建剪辑任务：clips + voiceover + person + cues + style */
  @Post("jobs")
  create(@Req() req: any, @Body() body: any) {
    return this.service.createJob(req.user, body);
  }

  @Get("jobs")
  list(@Req() req: any, @Query() query: any) {
    return this.service.listJobs(req.user, query);
  }

  @Get("jobs/:id")
  detail(@Req() req: any, @Param("id") id: string) {
    return this.service.getJob(req.user, id);
  }
}
