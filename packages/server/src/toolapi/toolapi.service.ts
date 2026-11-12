import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ComputeService } from "../compute/compute.service";

/** 宽容解析模型输出：优先 JSON 数组，其次「1. 策略」这种编号行，全都失败就返回空数组 */
function parseStrategies(raw: unknown, expected: number): string[] {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return [];
  const out: string[] = new Array(expected).fill("");
  const jsonStart = text.indexOf("[");
  const jsonEnd = text.lastIndexOf("]");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== "object") continue;
          const index = Number((item as any).index);
          const strategy = typeof (item as any).strategy === "string" ? (item as any).strategy.trim() : "";
          if (Number.isInteger(index) && index >= 1 && index <= expected && strategy) out[index - 1] = strategy;
        }
      }
    } catch {
      /* 落到编号行解析 */
    }
  }
  if (out.every((item) => !item)) {
    const lines = text.split(/\r?\n+/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      const matched = /^(\d+)[.、)．]\s*(.+)$/.exec(line);
      if (!matched) continue;
      const index = Number(matched[1]);
      if (Number.isInteger(index) && index >= 1 && index <= expected) out[index - 1] = matched[2].trim();
    }
  }
  return out;
}

const FALLBACK_PREFIX = "（模板兜底，非个性化生成：本次模型调用失败）";
type PageQuery = { phone: string; company?: string; wechatNickname?: string; industry?: string; lastCommDays?: number; addWechatDays?: number };

@Injectable()
export class ToolapiService {
  private readonly logger = new Logger(ToolapiService.name);

  constructor(private readonly prisma: PrismaService, private readonly compute: ComputeService) {}

  private owner(phone: string) {
    if (!phone || typeof phone !== "string") throw new BadRequestException("手机号不能为空");
    return phone;
  }

  async createContent(dto: any) { const phone = this.owner(dto.phone); return this.prisma.contentCollection.create({ data: { phone, title: dto.title, link: dto.link ?? null, contentSummary: dto.contentSummary, category: dto.category, mustUse: dto.mustUse ?? false, isUsed: dto.isUsed ?? false, operationType: dto.operationType ?? null } }); }
  async queryContent(dto: any) { const where: any = { phone: this.owner(dto.phone) }; for (const k of ["category", "mustUse", "isUsed", "operationType"]) if (dto[k] !== undefined) where[k] = dto[k]; return this.prisma.contentCollection.findMany({ where, orderBy: { createdAt: "desc" } }); }
  async updateContent(id: string, phone: string, dto: any) { const row = await this.prisma.contentCollection.findFirst({ where: { id, phone: this.owner(phone) } }); if (!row) throw new NotFoundException("内容不存在"); return this.prisma.contentCollection.update({ where: { id }, data: { title: dto.title, link: dto.link, contentSummary: dto.contentSummary, category: dto.category, mustUse: dto.mustUse, isUsed: dto.isUsed, operationType: dto.operationType } }); }
  async deleteContent(id: string, phone: string) { const row = await this.prisma.contentCollection.findFirst({ where: { id, phone: this.owner(phone) } }); if (!row) throw new NotFoundException("内容不存在"); await this.prisma.contentCollection.delete({ where: { id } }); return { success: true }; }

  async generateMorningReport(phone: string) { const owner = this.owner(phone); const today = new Date(); today.setHours(0, 0, 0, 0); const [recent, required] = await Promise.all([this.prisma.contentCollection.findMany({ where: { phone: owner, createdAt: { gte: today } } }), this.prisma.contentCollection.findMany({ where: { phone: owner, mustUse: true } })]); const rows = [...new Map([...recent, ...required].map((row) => [row.id, row])).values()]; if (!rows.length) throw new NotFoundException("没有可用的内容数据"); const content = rows.map((row, i) => `${i + 1}. [${row.category}] ${row.title}: ${row.contentSummary}`).join("\n"); return this.aiText(owner, `${content}\n\n汇总以上内容，整理成今天的销售与运营早报条目。`); }
  async generatePoster(_phone: string, _content: string, _image?: string) { throw new BadRequestException("海报生成请使用媒体服务"); }
  async generateDailyDistribution(phone: string) { const summaryContent = await this.generateMorningReport(phone); return this.prisma.dailyDistribution.create({ data: { phone: this.owner(phone), summaryContent } }); }
  async queryDailyDistribution(phone: string) { const today = new Date(); today.setHours(0, 0, 0, 0); return this.prisma.dailyDistribution.findMany({ where: { phone: this.owner(phone), createdAt: { gte: today } }, orderBy: { createdAt: "desc" } }); }
  async aiText(phone: string, content: string, model?: string) { if (typeof content !== "string" || !content.trim()) throw new BadRequestException("聊天内容不能为空"); const target = model || (await this.prisma.modelPricing.findFirst({ where: { isActive: true }, orderBy: { createdAt: "asc" } }))?.modelId; if (!target) throw new BadRequestException("未配置可用模型"); const account = await this.prisma.user.findFirst({ where: { phone: this.owner(phone) }, select: { id: true, status: true } }); if (!account) throw new NotFoundException("账号不存在"); if (account.status !== "active") throw new BadRequestException("账号已被禁用"); const result: any = await this.compute.processComputeRequest(account.id, { model: target, messages: [{ role: "user", content: content.trim() }], stream: false }); return result?.choices?.[0]?.message?.content || result?.content || ""; }

  async createPotentialCustomer(dto: any) { return this.prisma.potentialCustomer.create({ data: { phone: this.owner(dto.phone), company: dto.company, wechatNickname: dto.wechatNickname, industry: dto.industry, position: dto.position, lastCommDate: dto.lastCommDate ? new Date(dto.lastCommDate) : null, addWechatDate: dto.addWechatDate ? new Date(dto.addWechatDate) : null, interaction: dto.interaction } }); }
  async queryPotentialCustomers(dto: PageQuery) { const where: any = { phone: this.owner(dto.phone) }; if (dto.company) where.company = { contains: dto.company }; if (dto.wechatNickname) where.wechatNickname = { contains: dto.wechatNickname }; if (dto.industry) where.industry = dto.industry; for (const [key, field] of [["lastCommDays", "lastCommDate"], ["addWechatDays", "addWechatDate"]] as const) if (dto[key]) { const date = new Date(); date.setDate(date.getDate() - Number(dto[key])); where[field] = { gte: date }; } return this.prisma.potentialCustomer.findMany({ where, orderBy: { createdAt: "desc" } }); }
  async updatePotentialCustomer(id: string, phone: string, dto: any) { const row = await this.prisma.potentialCustomer.findFirst({ where: { id, phone: this.owner(phone) } }); if (!row) throw new NotFoundException("潜在客户不存在"); return this.prisma.potentialCustomer.update({ where: { id }, data: { company: dto.company, wechatNickname: dto.wechatNickname, industry: dto.industry, position: dto.position, lastCommDate: dto.lastCommDate ? new Date(dto.lastCommDate) : undefined, addWechatDate: dto.addWechatDate ? new Date(dto.addWechatDate) : undefined, interaction: dto.interaction } }); }

  async createTodayCommunication(dto: any) { return this.prisma.todayCommunication.create({ data: { phone: this.owner(dto.phone), potentialCustomerId: dto.potentialCustomerId, wechatNickname: dto.wechatNickname, seedingContent: dto.seedingContent, communicationStrategy: dto.communicationStrategy, commDate: dto.commDate ? new Date(dto.commDate) : undefined, actualCommContent: dto.actualCommContent } }); }
  /**
   * 生成今日沟通建议（P43 P1）：原来是把固定文案写进每行，等于假生成。
   * 现在按「最久没联系」取前 N 个潜在客户，一次调用小模型批量给出跟进策略，
   * 模型失败时才回落到固定文案（不让接口整体失败）。
   */
  async generateTodayCommunications(phone: string, options: { limit?: number } = {}) {
    const owner = this.owner(phone);
    const limit = Math.min(20, Math.max(1, Number(options.limit) || 5));
    const rows = await this.prisma.potentialCustomer.findMany({
      where: { phone: owner },
      orderBy: [{ lastCommDate: "asc" }, { createdAt: "asc" }],
      take: limit,
    });
    if (!rows.length) throw new NotFoundException("没有可用的潜在客户数据");
    const profiles = rows
      .map((row, i) =>
        [
          (i + 1) + ". 微信昵称：" + (row.wechatNickname || "未知"),
          row.company ? "公司：" + row.company : "",
          row.industry ? "行业：" + row.industry : "",
          row.position ? "职位：" + row.position : "",
          row.lastCommDate ? "上次沟通：" + row.lastCommDate.toISOString().slice(0, 10) : "上次沟通：无记录",
          row.interaction ? "互动记录：" + String(row.interaction).slice(0, 200) : "",
        ]
          .filter(Boolean)
          .join("；"),
      )
      .join("\n");
    const prompt = [
      "你是私域销售助理。下面是" + rows.length + "位潜在客户（已按最久未联系排序）。",
      "请为每位客户写一条今天可以直接发出去的跟进策略：包含切入点、一句开场话术、下一步动作，每段 60–120 字，不要客套话。",
      '只输出 JSON 数组，形如 [{"index":1,"strategy":"..."}]，index 对应下面的编号，不要输出其他内容。',
      "",
      profiles,
    ].join("\n");
    let strategies: string[] = [];
    try {
      const raw = await this.aiText(owner, prompt);
      strategies = parseStrategies(raw, rows.length);
    } catch (error: any) {
      this.logger.warn("今日沟通建议生成失败，回落固定文案：" + (error?.message ?? error));
    }
    return Promise.all(
      rows.map(async (row, i) => {
        const degraded = !strategies[i];
        const saved = await this.prisma.todayCommunication.create({
          data: {
            phone: row.phone,
            potentialCustomerId: row.id,
            wechatNickname: row.wechatNickname,
            communicationStrategy: strategies[i] || FALLBACK_PREFIX + "根据客户资料生成首轮跟进建议",
          },
        });
        return { ...saved, degraded };
      }),
    );
  }
  async queryTodayCommunications(dto: any) { const where: any = { phone: this.owner(dto.phone) }; if (dto.wechatNickname) where.wechatNickname = dto.wechatNickname; if (dto.commDate) { const date = new Date(dto.commDate); where.commDate = { gte: date, lt: new Date(date.getTime() + 86400000) }; } const rows = await this.prisma.todayCommunication.findMany({ where, orderBy: { commDate: "desc" } }); return rows.map(row => ({ ...row, degraded: String(row.communicationStrategy ?? "").startsWith(FALLBACK_PREFIX) })); }
  async updateTodayCommunication(id: string, phone: string, dto: any) { const row = await this.prisma.todayCommunication.findFirst({ where: { id, phone: this.owner(phone) } }); if (!row) throw new NotFoundException("今日沟通不存在"); return this.prisma.todayCommunication.update({ where: { id }, data: { actualCommContent: dto.actualCommContent, communicationStrategy: dto.communicationStrategy, seedingContent: dto.seedingContent } }); }

  async createCustomerProfile(dto: any) { return this.prisma.customerProfile.create({ data: { phone: this.owner(dto.phone), company: dto.company, wechatNickname: dto.wechatNickname, industry: dto.industry, position: dto.position, customerId: dto.customerId, lastCommDate: dto.lastCommDate ? new Date(dto.lastCommDate) : null, dealAmount: dto.dealAmount ?? 0, collectDate: dto.collectDate ? new Date(dto.collectDate) : null, responsiblePerson: dto.responsiblePerson, addWechatDate: dto.addWechatDate ? new Date(dto.addWechatDate) : null, satisfaction: dto.satisfaction, dealDate: dto.dealDate ? new Date(dto.dealDate) : null, remark: dto.remark, potentialCustomerId: dto.potentialCustomerId } }); }
  async queryCustomerProfiles(dto: any) { const where: any = { phone: this.owner(dto.phone) }; if (dto.wechatNickname) where.wechatNickname = dto.wechatNickname; if (dto.company) where.company = { contains: dto.company }; return this.prisma.customerProfile.findMany({ where, orderBy: { createdAt: "desc" } }); }
  async updateCustomerProfile(id: string, phone: string, dto: any) { const row = await this.prisma.customerProfile.findFirst({ where: { id, phone: this.owner(phone) } }); if (!row) throw new NotFoundException("客户画像不存在"); return this.prisma.customerProfile.update({ where: { id }, data: { company: dto.company, wechatNickname: dto.wechatNickname, industry: dto.industry, position: dto.position, customerId: dto.customerId, dealAmount: dto.dealAmount, satisfaction: dto.satisfaction, remark: dto.remark } }); }
  async createStrategySummary(dto: any) { return this.prisma.strategySummary.create({ data: { phone: this.owner(dto.phone), name: dto.name, content: dto.content } }); }
  async queryStrategySummaries(phone: string) { return this.prisma.strategySummary.findMany({ where: { phone: this.owner(phone) }, orderBy: { createdAt: "desc" } }); }
  async updateStrategySummary(id: string, phone: string, dto: any) { const row = await this.prisma.strategySummary.findFirst({ where: { id, phone: this.owner(phone) } }); if (!row) throw new NotFoundException("策略不存在"); return this.prisma.strategySummary.update({ where: { id }, data: { name: dto.name, content: dto.content } }); }
  async createCustomerCollection(dto: any) { return this.prisma.customerCollection.create({ data: { phone: this.owner(dto.phone), platform: dto.platform, link: dto.link, wechat: dto.wechat, introduction: dto.introduction, followerCount: dto.followerCount, collectTime: dto.collectTime ? new Date(dto.collectTime) : null } }); }
  async queryCustomerCollections(dto: any) { const where: any = { phone: this.owner(dto.phone) }; if (dto.isWechatAdded !== undefined) where.isWechatAdded = dto.isWechatAdded; if (dto.platform) where.platform = dto.platform; return this.prisma.customerCollection.findMany({ where, orderBy: { createdAt: "desc" } }); }
  async markWechatAdded(id: string, phone: string) { const row = await this.prisma.customerCollection.findFirst({ where: { id, phone: this.owner(phone) } }); if (!row) throw new NotFoundException("客户采集记录不存在"); return this.prisma.customerCollection.update({ where: { id }, data: { isWechatAdded: true, wechatAddedAt: new Date() } }); }
  async createUserChatPrompt(dto: any) { return this.prisma.userChatPrompt.create({ data: { phone: this.owner(dto.phone), wechatNickname: dto.wechatNickname, prompt: dto.prompt, isActive: dto.isActive ?? true } }); }
  async queryUserChatPrompts(dto: any) { const where: any = { phone: this.owner(dto.phone) }; if (dto.wechatNickname) where.wechatNickname = dto.wechatNickname; if (dto.isActive !== undefined) where.isActive = dto.isActive; return this.prisma.userChatPrompt.findMany({ where, orderBy: { updatedAt: "desc" } }); }
  async updateUserChatPrompt(id: string, phone: string, dto: any) { const row = await this.prisma.userChatPrompt.findFirst({ where: { id, phone: this.owner(phone) } }); if (!row) throw new NotFoundException("聊天提示词不存在"); return this.prisma.userChatPrompt.update({ where: { id }, data: { prompt: dto.prompt, isActive: dto.isActive } }); }
  async deleteUserChatPrompt(id: string, phone: string) { const row = await this.prisma.userChatPrompt.findFirst({ where: { id, phone: this.owner(phone) } }); if (!row) throw new NotFoundException("聊天提示词不存在"); await this.prisma.userChatPrompt.delete({ where: { id } }); return { success: true }; }
}
