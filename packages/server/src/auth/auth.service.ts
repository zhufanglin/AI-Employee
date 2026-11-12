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

// ---------- P45：合规同意 ----------
// 造账号（新用户）时必须带上用户对《用户协议》《隐私政策》《AI 生成内容标识说明》的同意，
// 且个人信息跨境传输需要「单独同意」（crossBorder=true）。老用户不强制，避免打断既有账号。
export type ConsentInput = {
  version?: string;
  crossBorder?: boolean;
  source?: string;
  ip?: string;
  userAgent?: string;
};

/** 用户点了「同意」时要落库的文档清单 */
const CONSENT_DOCS = ["terms", "privacy", "aigc"] as const;

/** 服务端兜底版本号：客户端没带 version 时用它（与 legal.pages.ts 的 LEGAL_VERSION 对齐） */
const CONSENT_FALLBACK_VERSION = "2026-11-12";

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
  async smsLogin(phone: string, code: string, consent?: ConsentInput) {
    await this.consumeCode(phone, code, "login");
    let user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) {
      this.assertConsentForNewAccount(consent);
      user = await this.prisma.user.create({
        data: {
          phone,
          passwordHash: await bcrypt.hash(randomBytes(16).toString("hex"), 10),
          nickname: "用户" + phone.slice(-4),
          source: "sms",
        },
      });
      await this.recordConsent(user.id, consent, "sms-login");
    } else {
      // 老账号也补记一次（幂等：同用户同文档同版本只记一条），便于合规审计
      await this.recordConsent(user.id, consent, "sms-login");
    }
    if (user.status !== "active") throw new ForbiddenException("账号已被禁用");
    return this.issueToken(user);
  }

  /** 新账号必须显式同意三份文本；未提供时给出可操作的中文错误 */
  private assertConsentForNewAccount(consent?: ConsentInput) {
    if (env("AUTH_REQUIRE_CONSENT", "1") === "0") return;
    if (!consent || !consent.version) {
      throw new BadRequestException(
        "请先阅读并同意《用户协议》《隐私政策》《AI 生成内容标识说明》后再登录（首次登录将自动创建账号）",
      );
    }
  }

  /**
   * 落同意记录。同一 (userId, docKey, version) 只会有一条。
   * crossBorder 只有显式为 true 才记录 —— 跨境传输属于「单独同意」，不能靠勾选一次通用条款推定。
   */
  async recordConsent(userId: string, consent?: ConsentInput, fallbackSource = "settings") {
    if (!consent || !consent.version) return 0;
    const version = String(consent.version).slice(0, 32);
    const source = String(consent.source || fallbackSource).slice(0, 32);
    const docs = [...CONSENT_DOCS];
    if (consent.crossBorder) docs.push("cross-border" as any);
    let created = 0;
    for (const docKey of docs) {
      try {
        await this.prisma.consentRecord.create({
          data: {
            userId,
            docKey,
            version,
            source,
            ip: consent.ip ? String(consent.ip).slice(0, 64) : null,
            userAgent: consent.userAgent ? String(consent.userAgent).slice(0, 255) : null,
          },
        });
        created += 1;
      } catch (e: any) {
        // P2002 = 唯一键冲突（同版本已同意过），属预期，忽略
        if (e?.code !== "P2002") throw e;
      }
    }
    return created;
  }

  async register(dto: {
    phone?: string; email?: string; password: string; code?: string; name?: string; consent?: ConsentInput;
  }) {
    if (!dto.phone && !dto.email) throw new BadRequestException("手机号或邮箱至少填写一项");
    this.assertConsentForNewAccount(dto.consent);
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
    await this.recordConsent(user.id, dto.consent, "register");
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

  async passwordLogin(account: string, password: string, consent?: ConsentInput) {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ phone: account }, { email: account }] },
    });
    if (!user) throw new UnauthorizedException("账号或密码错误");
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException("账号或密码错误");
    if (user.status !== "active") throw new ForbiddenException("账号已被禁用");
    await this.recordConsent(user.id, consent, "password-login");
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
    // jti 必须加：同一用户在同一秒内登录两次，签名载荷完全一致会得到同一个 JWT，
    // 写入 Session.accessToken（唯一键）时会撞 P2002 直接 500。加随机 jti 后天然唯一。
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, role: user.role, phone: user.phone, kind: "user", jti: randomBytes(8).toString("hex") },
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
