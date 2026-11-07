import { Injectable, UnauthorizedException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class ProxyTokenService {
  constructor(private prisma: PrismaService) {}

  async generateProxyToken(userId: string) {
    const token = `rrclaw-proxy-${userId}-${randomBytes(16).toString("hex")}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    return this.prisma.proxyToken.create({ data: { userId, token, expiresAt } });
  }

  async validateProxyToken(token: string): Promise<string> {
    const proxyToken = await this.prisma.proxyToken.findUnique({ where: { token } });
    if (!proxyToken) throw new UnauthorizedException("无效的代理令牌");
    if (proxyToken.expiresAt < new Date()) {
      await this.prisma.proxyToken.delete({ where: { id: proxyToken.id } });
      throw new UnauthorizedException("代理令牌已过期");
    }
    await this.prisma.proxyToken.update({ where: { id: proxyToken.id }, data: { lastUsedAt: new Date() } });
    return proxyToken.userId;
  }

  async refreshProxyToken(userId: string) {
    const existing = await this.findActiveProxyToken(userId);
    if (existing) return existing;
    return this.generateProxyToken(userId);
  }

  async findActiveProxyToken(userId: string) {
    return this.prisma.proxyToken.findFirst({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
  }

  async cleanExpiredTokens(): Promise<number> {
    const r = await this.prisma.proxyToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    return r.count;
  }
}
