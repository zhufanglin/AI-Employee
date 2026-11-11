import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { ChatService } from "./chat.service";

/** 对话持久化 REST（前缀 /api/chat，全局 JWT 守卫，按 req.user.id 隔离） */
@Controller("chat")
export class ChatController {
  constructor(private readonly service: ChatService) {}

  @Get("sessions")
  list(@Req() req: any, @Query("limit") limit: string) {
    return this.service.list(req.user, limit);
  }

  @Post("sessions")
  create(@Req() req: any, @Body() body: any) {
    return this.service.create(req.user, body);
  }

  @Get("sessions/:id")
  detail(@Req() req: any, @Param("id") id: string) {
    return this.service.detail(req.user, id);
  }

  @Patch("sessions/:id")
  @HttpCode(HttpStatus.OK)
  update(@Req() req: any, @Param("id") id: string, @Body() body: any) {
    return this.service.update(req.user, id, body);
  }

  @Delete("sessions/:id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.service.remove(req.user, id);
  }

  @Post("sessions/:id/messages")
  @HttpCode(HttpStatus.OK)
  append(@Req() req: any, @Param("id") id: string, @Body() body: any) {
    return this.service.append(req.user, id, body);
  }
}
