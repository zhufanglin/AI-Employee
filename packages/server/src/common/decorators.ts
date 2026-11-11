import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import type { AuthUser } from "./auth-user";

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest();
  return req.user;
});

export const Public = () => SetMetadata("isPublic", true);
/** 匿名可访问，但带了合法 token 时仍然解析出 req.user（用于返回个性化字段） */
export const OptionalAuth = () => SetMetadata("optionalAuth", true);
export const Roles = (...roles: string[]) => SetMetadata("roles", roles);
