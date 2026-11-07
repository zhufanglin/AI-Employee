import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { CurrentUser } from "../common/decorators";
import type { AuthUser } from "../common/auth-user";
import { CapabilityService } from "./capability.service";

@Controller("capabilities")
export class CapabilityController {
  constructor(private readonly capabilities: CapabilityService) {}

  /** 能力清单（给桌面端/agent 自己看有哪些能力、要什么参数） */
  @Get()
  list() {
    return { total: this.capabilities.list().length, items: this.capabilities.list() };
  }

  /** 统一入口：{ name, params } → { success, data, error }（与原版 tool_box.py 同构） */
  @Post("run")
  run(@CurrentUser() user: AuthUser, @Body() body: { name?: string; params?: Record<string, any> }) {
    return this.capabilities.runStrict(user as any, String(body?.name || ""), body?.params || {});
  }

  /** 单能力快捷路径：POST /capabilities/:name */
  @Post(":name")
  runByName(@CurrentUser() user: AuthUser, @Param("name") name: string, @Body() params: Record<string, any>) {
    return this.capabilities.runStrict(user as any, name, params || {});
  }
}
