import { Controller, Get, Post, Req } from "@nestjs/common";
import { ProxyTokenService } from "./proxy-token.service";

/** 原版路由：GET|POST /volcengine/proxy-token —— 给桌面端/网关换代理令牌 */
@Controller("volcengine")
export class ProxyTokenController {
  constructor(private proxyToken: ProxyTokenService) {}

  @Get("proxy-token")
  async getToken(@Req() req: any) {
    const userId = req.user?.sub || req.user?.id;
    const token = await this.proxyToken.refreshProxyToken(userId);
    return { token: token.token, expiresAt: token.expiresAt };
  }

  @Post("proxy-token")
  async createToken(@Req() req: any) {
    const userId = req.user?.sub || req.user?.id;
    const token = await this.proxyToken.generateProxyToken(userId);
    return { token: token.token, expiresAt: token.expiresAt };
  }
}
