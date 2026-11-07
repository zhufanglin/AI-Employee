import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { MediaService } from "../media/media.service";
import { resolvePhone } from "../common/owner";

@Injectable()
export class AudioMaterialsService {
  constructor(private readonly prisma: PrismaService, private readonly media: MediaService) {}

  private async scope(user: any) {
    return { phone: await resolvePhone(this.prisma, user), userId: String(user?.id ?? "") };
  }

  /** 支持两种入参：已上传好的 audioUrl，或 { fileName, mime, base64 } 交由媒体服务上传后入库 */
  async upload(user: any, body: any) {
    const { phone, userId } = await this.scope(user);
    let audioUrl = String(body?.audioUrl || body?.url || "").trim();
    if (!audioUrl) {
      const base64 = String(body?.base64 || body?.data || "");
      if (!base64) throw new BadRequestException("缺少音频素材（audioUrl 或 base64）");
      const uploaded: any = await this.media.upload(userId, {
        fileName: body?.fileName || "audio.wav",
        mime: body?.mime || "audio/wav",
        base64,
      });
      audioUrl = String(uploaded?.url || uploaded?.download_url || "");
      if (!audioUrl) throw new BadRequestException("音频上传失败");
    }
    return this.prisma.audioMaterial.create({ data: { phone, audioUrl } });
  }

  async list(user: any) {
    const { phone } = await this.scope(user);
    return this.prisma.audioMaterial.findMany({ where: { phone }, orderBy: { createdAt: "desc" }, take: 200 });
  }

  async remove(user: any, id: string) {
    const { phone } = await this.scope(user);
    const row = await this.prisma.audioMaterial.findFirst({ where: { id, phone } });
    if (!row) throw new NotFoundException("音频不存在");
    await this.prisma.audioMaterial.delete({ where: { id } });
    return { success: true };
  }
}
