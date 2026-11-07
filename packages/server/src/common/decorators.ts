import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import type { AuthUser } from "./auth-user";

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest();
  return req.user;
});

export const Public = () => SetMetadata("isPublic", true);
export const Roles = (...roles: string[]) => SetMetadata("roles", roles);
