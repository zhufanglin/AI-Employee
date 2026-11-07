import { BadRequestException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * 解析当前登录用户用于内容归属的 phone。
 * 原版三张媒体表（ComposeVideo / CloneRecord / AudioMaterial）都以 phone 作为归属键，
 * 复刻沿用该契约；短信登录用户自带 phone，邮箱登录用户回落到数据库查询。
 */
export async function resolvePhone(prisma: PrismaService, user: any): Promise<string> {
  const phone = typeof user?.phone === "string" ? user.phone.trim() : "";
  if (phone) return phone;
  const id = typeof user?.id === "string" ? user.id : "";
  if (!id) throw new BadRequestException("当前账号缺少归属标识");
  const row = await prisma.user.findUnique({ where: { id }, select: { phone: true } });
  const found = row?.phone?.trim() || "";
  if (!found) throw new BadRequestException("当前账号未绑定手机号，无法使用内容生产功能");
  return found;
}
