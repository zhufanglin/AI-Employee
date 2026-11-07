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
    if (isPublic) return true;

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
