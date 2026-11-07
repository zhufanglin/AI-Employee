import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../prisma/prisma.service";
import { ProxyTokenService } from "./proxy-token.service";

/** 与原版一致：rrclaw-proxy- 前缀 → ProxyToken；eyJ 前缀 → JWT */
@Injectable()
export class ComputeAuthGuard implements CanActivate {
  constructor(
    private jwt: JwtService,
    private prisma: PrismaService,
    private proxyToken: ProxyTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new UnauthorizedException("未提供认证令牌");
    }
    const token = authHeader.slice(7);

    if (token.startsWith("rrclaw-proxy-")) {
      try {
        const userId = await this.proxyToken.validateProxyToken(token);
        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, credits: true, status: true },
        });
        if (user && user.status === "active") {
          request.user = { userId, ...user };
          return true;
        }
      } catch {
        // fallthrough
      }
      throw new UnauthorizedException("无效的代理令牌");
    }

    if (token.startsWith("eyJ")) {
      try {
        const payload: any = await this.jwt.verifyAsync(token);
        if (payload?.sub) {
          const user = await this.prisma.user.findUnique({
            where: { id: payload.sub },
            select: { id: true, credits: true, status: true },
          });
          if (user && user.status === "active") {
            request.user = { userId: payload.sub, ...user };
            return true;
          }
        }
      } catch {
        // fallthrough
      }
    }
    throw new UnauthorizedException("无效的认证令牌");
  }
}
