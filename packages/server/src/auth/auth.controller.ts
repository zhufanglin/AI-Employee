import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AuthService } from "./auth.service";
import {
  AdminLoginDto, ChangePasswordDto, PasswordLoginDto, RegisterDto, SendSmsCodeDto, SmsLoginDto,
} from "./auth.dto";
import { CurrentUser, Public } from "../common/decorators";
import type { AuthUser } from "../common/auth-user";

/** 把请求来源补进同意记录（ip / userAgent），用于合规审计追溯 */
function withClientMeta(consent: any, req: any) {
  if (!consent) return undefined;
  const ip = (req?.headers?.["x-forwarded-for"] || req?.ip || "").toString().split(",")[0].trim();
  return { ...consent, ip, userAgent: req?.headers?.["user-agent"] || "" };
}

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post("sms/send")
  sendSmsCode(@Body() dto: SendSmsCodeDto) {
    return this.auth.sendSmsCode(dto.phone, dto.purpose ?? "login");
  }

  @Public()
  @Post("sms/login")
  smsLogin(@Body() dto: SmsLoginDto, @Req() req: any) {
    return this.auth.smsLogin(dto.phone, dto.code, withClientMeta(dto.consent, req));
  }

  @Public()
  @Post("login/sms")
  loginWithSms(@Body() dto: SmsLoginDto, @Req() req: any) {
    return this.auth.smsLogin(dto.phone, dto.code, withClientMeta(dto.consent, req));
  }

  @Public()
  @Post("register")
  register(@Body() dto: RegisterDto, @Req() req: any) {
    return this.auth.register({ ...dto, consent: withClientMeta(dto.consent, req) });
  }

  @Public()
  @Post("login")
  passwordLogin(@Body() dto: PasswordLoginDto, @Req() req: any) {
    return this.auth.passwordLogin(dto.account, dto.password, withClientMeta(dto.consent, req));
  }

  @Public()
  @Post("admin/login")
  adminLogin(@Body() dto: AdminLoginDto) {
    return this.auth.adminLogin(dto.username, dto.password);
  }

  @Public()
  @Get("check")
  check() {
    return { authenticated: false };
  }

  @ApiBearerAuth()
  @Post("logout")
  logout(@Req() req: any) {
    return this.auth.logout(req.user.id);
  }

  @Public()
  @Post("refresh")
  refresh(@Body() body: { refreshToken?: string }) {
    return this.auth.refreshToken(body?.refreshToken ?? "");
  }

  @ApiBearerAuth()
  @Get("me")
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  /**
   * 已登录用户再次确认协议（例如条款改版后重新点「同意并继续」）。
   * 只补记同意，不重新签发 token。记录幂等（同用户同文档同版本只留一条）。
   */
  @ApiBearerAuth()
  @Post("consent")
  async recordConsent(@CurrentUser() user: AuthUser, @Body() dto: { consent?: any }, @Req() req: any) {
    const created = await this.auth.recordConsent(user.id, withClientMeta(dto?.consent, req), "desktop");
    return { success: true, created };
  }

  @ApiBearerAuth()
  @Post("password")
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user.id, dto.oldPassword, dto.newPassword);
  }
}


/** 原版管理端登录路径是 POST /admin/login（不是 /auth/admin/login），复刻保留别名。 */
@Public()
@Controller("admin")
export class AdminLoginAliasController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  login(@Body() dto: AdminLoginDto) {
    return this.auth.adminLogin(dto.username, dto.password);
  }
}
