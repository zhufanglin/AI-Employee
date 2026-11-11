import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { randomBytes, randomInt } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { SmsSender } from "./sms.sender";
import { env, envInt } from "../common/env";

// 原版 sms.service.js 的验证码有效期是 10 分钟，这里与之一致。
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_RESEND_MS = 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly sms: SmsSender,
  ) {}

  // ---------- 短信验证码 ----------
  async sendSmsCode(phone: string, purpose = "login") {
    const last = await this.prisma.verificationCode.findFirst({
      where: { phone, purpose },
      orderBy: { createdAt: "desc" },
    });
    if (last && Date.now() - last.createdAt.getTime() < CODE_RESEND_MS) {
      throw new BadRequestException("验证码发送过于频繁，请稍后再试");
    }
    const code = String(randomInt(100000, 1000000));
    await this.prisma.verificationCode.create({
      data: { phone, code, purpose, expiresAt: new Date(Date.now() + CODE_TTL_MS) },
    });
    const res = await this.sms.send(phone, code, purpose);
    if (!res.sent) throw new BadRequestException("短信通道未配置");
    return { success: true, devCode: res.devCode ?? null };
  }

  private async consumeCode(phone: string, code: string, purpose: string) {
    const row = await this.prisma.verificationCode.findFirst({
      where: { phone, code, purpose, used: false },
      orderBy: { createdAt: "desc" },
    });
    if (!row) throw new BadRequestException("验证码错误");
    const now = new Date();
    if (row.expiresAt.getTime() <= now.getTime()) throw new BadRequestException("验证码已过期");
    const consumed = await this.prisma.verificationCode.updateMany({
      where: { id: row.id, used: false, expiresAt: { gt: now } },
      data: { used: true },
    });
    if (consumed.count !== 1) throw new BadRequestException("验证码错误或已过期");
    return row;
  }

  // ---------- 登录 ----------
  async smsLogin(phone: string, code: string) {
    await this.consumeCode(phone, code, "login");
    let user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          phone,
          passwordHash: await bcrypt.hash(randomBytes(16).toString("hex"), 10),
          nickname: "用户" + phone.slice(-4),
          source: "sms",
        },
      });
    }
    if (user.status !== "active") throw new ForbiddenException("账号已被禁用");
    return this.issueToken(user);
  }

  async register(dto: { phone?: string; email?: string; password: string; code?: string; name?: string }) {
    if (!dto.phone && !dto.email) throw new BadRequestException("手机号或邮箱至少填写一项");
    // 手机号注册必须验短信验证码（P43-A P1：原先不传 code 就能直接用任意手机号注册）。
    if (dto.phone) {
      if (!dto.code) throw new BadRequestException("请先获取短信验证码");
      await this.consumeCode(dto.phone, dto.code, "register");
    }
    const exists = await this.prisma.user.findFirst({ where: { OR: [{ phone: dto.phone ?? undefined }, { email: dto.email ?? undefined }] } });
    if (exists) throw new BadRequestException("用户已存在");
    const user = await this.prisma.user.create({
      data: {
        phone: dto.phone,
        email: dto.email,
        passwordHash: await bcrypt.hash(dto.password, 10),
        nickname: dto.name ?? (dto.phone ? "用户" + dto.phone.slice(-4) : "用户"),
        source: "register",
      },
    });
    return this.issueToken(user);
  }

  async logout(userId: string) {
    await this.prisma.session.deleteMany({ where: { userId } });
    return { success: true };
  }

  async refreshToken(refreshToken: string) {
    if (!refreshToken) throw new UnauthorizedException("缺少刷新令牌");
    const session = await this.prisma.session.findUnique({ where: { refreshToken }, include: { user: true } });
    if (!session || session.expiresAt <= new Date()) throw new UnauthorizedException("刷新令牌无效或已过期");
    await this.prisma.session.delete({ where: { id: session.id } });
    const tokens = await this.issueToken(session.user);
    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresIn: Math.max(0, Math.floor((tokens.expiresAt.getTime() - Date.now()) / 1000)), tokenType: "Bearer" };
  }

  async passwordLogin(account: string, password: string) {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ phone: account }, { email: account }] },
    });
    if (!user) throw new UnauthorizedException("账号或密码错误");
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException("账号或密码错误");
    if (user.status !== "active") throw new ForbiddenException("账号已被禁用");
    return this.issueToken(user);
  }

  async adminLogin(username: string, password: string) {
    const adminUser = env("ADMIN_USERNAME", "admin");
    const adminPass = env("ADMIN_PASSWORD", "admin");
    if (username !== adminUser || password !== adminPass) {
      throw new UnauthorizedException("管理员账号或密码错误");
    }
    const token = await this.jwt.signAsync(
      { sub: "admin:" + username, role: "admin", kind: "admin" },
      { expiresIn: env("JWT_EXPIRES_IN", "7d") as any },
    );
    return { accessToken: token, user: { id: "admin:" + username, username, role: "admin" } };
  }

  private async issueToken(user: { id: string; phone: string | null; role: string }) {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, role: user.role, phone: user.phone, kind: "user" },
      { expiresIn: env("JWT_EXPIRES_IN", "7d") as any },
    );
    const refreshToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + envInt("JWT_EXPIRES_DAYS", 7) * 86400000);
    await this.prisma.session.create({
      data: { userId: user.id, accessToken, refreshToken, expiresAt },
    });
    return {
      accessToken,
      refreshToken,
      expiresAt,
      user: await this.me(user.id),
    };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, phone: true, email: true, nickname: true, avatar: true,
        role: true, status: true, credits: true, createdAt: true,
      },
    });
    if (!user) throw new UnauthorizedException("用户不存在");
    return user;
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException("用户不存在");
    const ok = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!ok) throw new BadRequestException("原密码错误");
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(newPassword, 10) },
    });
    return { success: true };
  }
}
