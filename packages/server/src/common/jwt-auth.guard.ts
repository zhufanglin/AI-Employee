import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>("isPublic", [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) {
      // 匿名接口（如员工市场）在带了合法 token 时要能拿到 req.user，无效 token 一律当游客处理
      const optional = this.reflector.getAllAndOverride<boolean>("optionalAuth", [ctx.getHandler(), ctx.getClass()]);
      if (optional) {
        const optionalReq = ctx.switchToHttp().getRequest();
        const optionalHeader: string | undefined = optionalReq.headers["authorization"];
        if (optionalHeader && optionalHeader.startsWith("Bearer ")) {
          try {
            const payload = await this.jwt.verifyAsync(optionalHeader.slice(7));
            optionalReq.user = { id: payload.sub, role: payload.role ?? "user", phone: payload.phone ?? null, kind: payload.kind ?? "user" };
          } catch {
            /* 匿名接口忽略坏 token */
          }
        }
      }
      return true;
    }

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers["authorization"];
    if (!header || !header.startsWith("Bearer ")) {
      throw new UnauthorizedException("缺少访问令牌");
    }
    try {
      const payload = await this.jwt.verifyAsync(header.slice(7));
      req.user = { id: payload.sub, role: payload.role ?? "user", phone: payload.phone ?? null, kind: payload.kind ?? "user" };
      return true;
    } catch {
      throw new UnauthorizedException("访问令牌无效或已过期");
    }
  }
}
