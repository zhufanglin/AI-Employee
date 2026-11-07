import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AuthService } from "./auth.service";
import {
  AdminLoginDto, ChangePasswordDto, PasswordLoginDto, RegisterDto, SendSmsCodeDto, SmsLoginDto,
} from "./auth.dto";
import { CurrentUser, Public } from "../common/decorators";
import type { AuthUser } from "../common/auth-user";

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
  smsLogin(@Body() dto: SmsLoginDto) {
    return this.auth.smsLogin(dto.phone, dto.code);
  }

  @Public()
  @Post("login/sms")
  loginWithSms(@Body() dto: SmsLoginDto) {
    return this.auth.smsLogin(dto.phone, dto.code);
  }

  @Public()
  @Post("register")
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Public()
  @Post("login")
  passwordLogin(@Body() dto: PasswordLoginDto) {
    return this.auth.passwordLogin(dto.account, dto.password);
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
