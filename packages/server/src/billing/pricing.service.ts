import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/** 单例定价参数：1 元 = 多少积分、目标毛利、试用赠送、RunningHub 币价 */
export interface PricingConfigShape {
  creditsPerYuan: number;
  targetMarginPercent: number;
  minCreditsPerRequest: number;
  trialCredits: number;
  mediaCoinCny: number;
  updatedBy?: string | null;
  updatedAt?: Date | null;
}

const CONFIG_ID = "global";
const CONFIG_CACHE_MS = 30_000;
const DEFAULTS: PricingConfigShape = {
  creditsPerYuan: 100,
  targetMarginPercent: 100,
  minCreditsPerRequest: 1,
  trialCredits: 200,
  mediaCoinCny: 0.01,
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * 定价服务：价格一律由「上游成本 × 目标毛利」推导，代码里不写死任何金额。
 * - 模型：per_request / per_token（每千 token，原版口径）/ per_token_million（每百万 token，成本驱动）
 * - 媒体：per_request / per_input_second
 */
@Injectable()
export class PricingService {
  private configCache: { at: number; value: any } | null = null;
  private rowsCache: { at: number; rows: any[] } | null = null;

  constructor(private prisma: PrismaService) {}

  /** 模型名归一化：忽略大小写与 . - _ 空格差异（doubao-seed-2.0-lite ≈ doubao-seed-2-0-lite） */
  private normModel(value: string): string {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  /** 全部定价行（30s 缓存，只有 10 余行） */
  private async allRows(): Promise<any[]> {
    const now = Date.now();
    if (this.rowsCache && now - this.rowsCache.at < CONFIG_CACHE_MS) return this.rowsCache.rows;
    const rows = await this.prisma.modelPricing.findMany();
    this.rowsCache = { at: now, rows };
    return rows;
  }

  /** 清缓存（后台改价后立即生效） */
  clearCache() {
    this.rowsCache = null;
    this.configCache = null;
  }

  /**
   * 按任意模型标识找定价行：别名（ModelPricing.modelId）→ 上游 id → 去掉日期后缀 → 归一化模糊匹配。
   * 计费与调用方传入的 model 字符串可能不同写法（别名 / 上游 id / 带版本号），必须都能命中。
   */
  async findPricingRow(modelId: string): Promise<any | null> {
    const key = String(modelId || "").trim();
    if (!key) return null;
    let row = await this.prisma.modelPricing.findUnique({ where: { modelId: key } });
    if (row) return row;
    row = await this.prisma.modelPricing.findFirst({ where: { upstreamModelId: key } });
    if (row) return row;
    const base = key.replace(/-(\d{6,8})$/, "");
    if (base !== key) {
      row = await this.prisma.modelPricing.findFirst({ where: { upstreamModelId: base } });
      if (row) return row;
    }
    const rows = await this.allRows();
    const want = this.normModel(key);
    if (!want) return null;
    const byAlias = rows.find((r) => this.normModel(r.modelId) === want);
    if (byAlias) return byAlias;
    const byUpstream = rows.find((r) => this.normModel(r.upstreamModelId || "") === want);
    if (byUpstream) return byUpstream;
    return (
      rows.find((r) => {
        const up = this.normModel(r.upstreamModelId || "");
        return up && (up.startsWith(want) || want.startsWith(up));
      }) || null
    );
  }

  /** 读全局定价参数（单例自动创建，30s 缓存） */
  async getConfig(force = false): Promise<any> {
    const now = Date.now();
    if (!force && this.configCache && now - this.configCache.at < CONFIG_CACHE_MS) return this.configCache.value;
    let row = await this.prisma.pricingConfig.findUnique({ where: { id: CONFIG_ID } });
    if (!row) {
      row = await this.prisma.pricingConfig.upsert({ where: { id: CONFIG_ID }, update: {}, create: { id: CONFIG_ID } });
    }
    this.configCache = { at: now, value: row };
    return row;
  }

  /** 新用户试用赠送积分（0 = 关闭） */
  async trialCredits(): Promise<number> {
    try {
      const cfg = await this.getConfig();
      return Math.max(0, Number(cfg.trialCredits ?? 0));
    } catch {
      return DEFAULTS.trialCredits;
    }
  }

  async getPricing(modelId: string) {
    const pricing = await this.findPricingRow(modelId);
    if (!pricing) {
      return {
        modelId,
        pricingMode: "per_request",
        pricePerRequest: 1,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
      };
    }
    return pricing;
  }

  /** 与原版 VolcPricingService 一致：按条 / 按千 token；新增按百万 token 口径；最低取全局配置 */
  async calculatePrice(modelId: string, inputTokens: number, outputTokens: number): Promise<number> {
    const pricing = await this.findPricingRow(modelId);
    const cfg = await this.getConfig();
    const min = Math.max(1, Number(cfg.minCreditsPerRequest ?? 1));
    if (!pricing) return min;
    const inTok = Number.isFinite(inputTokens) ? inputTokens : 0;
    const outTok = Number.isFinite(outputTokens) ? outputTokens : 0;
    let price: number;
    if (pricing.pricingMode === "per_token_million") {
      price = Math.ceil((inTok / 1_000_000) * pricing.pricePerInputToken + (outTok / 1_000_000) * pricing.pricePerOutputToken);
    } else if (pricing.pricingMode === "per_token") {
      price = Math.ceil((inTok / 1000) * pricing.pricePerInputToken + (outTok / 1000) * pricing.pricePerOutputToken);
    } else {
      price = pricing.pricePerRequest;
    }
    return Math.max(price, min);
  }

  /** 模型建议价：成本（元/百万 token）×（1+毛利）× 积分兑元比例 ⇒ 每百万 token 积分 */
  suggestModelPricing(row: any, cfg: any, measured?: { count: number; avgInputTokens: number; avgOutputTokens: number } | null) {
    const costIn = Number(row.upstreamCostInputPerMillionCny ?? 0);
    const costOut = Number(row.upstreamCostOutputPerMillionCny ?? 0);
    const margin = 1 + Number(cfg.targetMarginPercent ?? 0) / 100;
    const perYuan = Math.max(1, Number(cfg.creditsPerYuan ?? 100));
    const min = Math.max(1, Number(cfg.minCreditsPerRequest ?? 1));
    const sellInPerMillion = Math.ceil(costIn * margin * perYuan);
    const sellOutPerMillion = Math.ceil(costOut * margin * perYuan);
    const avgIn = measured?.avgInputTokens ?? 0;
    const avgOut = measured?.avgOutputTokens ?? 0;
    const costPerRequestCny = round4((avgIn / 1_000_000) * costIn + (avgOut / 1_000_000) * costOut);
    // 按「每百万 token 售价」套实测 token，得到这条建议在真实一次请求上会收多少积分（再兜底最低值）
    const sellFromTokens = Math.ceil((avgIn / 1_000_000) * sellInPerMillion + (avgOut / 1_000_000) * sellOutPerMillion);
    const suggestPerRequest = Math.max(min, sellFromTokens);
    const hasCost = costIn > 0 || costOut > 0;
    return {
      pricingMode: "per_token_million" as const,
      pricePerInputToken: sellInPerMillion,
      pricePerOutputToken: sellOutPerMillion,
      pricePerRequest: suggestPerRequest,
      costPerRequestCny,
      sellPerRequest: suggestPerRequest,
      marginPerRequest: costPerRequestCny > 0 ? round2((suggestPerRequest / perYuan) / costPerRequestCny) : null,
      note: hasCost ? "" : "上游成本未填写，建议价仅供参考，请先按账单填写成本",
    };
  }

  /** 媒体建议价：按币或按元的上游单位成本 ×（1+毛利）× 积分兑元比例 */
  suggestMediaPricing(row: any, cfg: any) {
    const margin = 1 + Number(cfg.targetMarginPercent ?? 0) / 100;
    const perYuan = Math.max(1, Number(cfg.creditsPerYuan ?? 100));
    const coinCny = Number(cfg.mediaCoinCny ?? 0);
    const coins = Number(row.upstreamCoinsPerUnit ?? 0);
    const unitCostCny = row.upstreamUnit === "coins" ? coins * coinCny : Number(row.upstreamUnitCostCny ?? 0);
    const sell = unitCostCny * margin * perYuan;
    const perSecond = row.pricingMode === "per_input_second";
    return {
      unitCostCny: round4(unitCostCny),
      coins,
      pricePerRequest: perSecond ? Number(row.pricePerRequest ?? 1) : Math.max(1, Math.ceil(sell)),
      pricePerInputSecond: perSecond ? Math.max(0.01, round2(sell)) : Number(row.pricePerInputSecond ?? 0),
      hasCost: unitCostCny > 0,
      note: unitCostCny > 0 ? "" : "上游单位成本未填写（币数或元），建议价仅供参考",
    };
  }

  /** 近 N 天按模型的实测用量均值 */
  async measuredByModel(days = 30) {
    const since = new Date(Date.now() - Math.max(1, days) * 24 * 3600 * 1000);
    const grouped = await this.prisma.aiUsageRecord.groupBy({
      by: ["modelId"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _avg: { inputTokens: true, outputTokens: true, creditsCharged: true },
      _sum: { inputTokens: true, outputTokens: true, creditsCharged: true },
    });
    const map = new Map<string, any>();
    for (const g of grouped as any[]) {
      map.set(g.modelId, {
        count: g._count?._all ?? 0,
        avgInputTokens: Math.round(g._avg?.inputTokens ?? 0),
        avgOutputTokens: Math.round(g._avg?.outputTokens ?? 0),
        avgCreditsCharged: round2(g._avg?.creditsCharged ?? 0),
        sumInputTokens: g._sum?.inputTokens ?? 0,
        sumOutputTokens: g._sum?.outputTokens ?? 0,
        sumCredits: g._sum?.creditsCharged ?? 0,
      });
    }
    return map;
  }

  /** 后台总览：全局参数 + 每个模型/媒体任务的成本、现价、建议价、实测用量 */
  async overview(days = 30) {
    const cfg = await this.getConfig(true);
    const [models, mediaPricings, measured] = await Promise.all([
      this.prisma.modelPricing.findMany({ orderBy: { modelId: "asc" } }),
      this.prisma.mediaPricing.findMany({ orderBy: { taskType: "asc" } }),
      this.measuredByModel(days),
    ]);
    const modelRows = models.map((m: any) => {
      const stats = measured.get(m.modelId) ?? null;
      return {
        ...m,
        cost: {
          inputPerMillionCny: Number(m.upstreamCostInputPerMillionCny ?? 0),
          outputPerMillionCny: Number(m.upstreamCostOutputPerMillionCny ?? 0),
        },
        measured: stats,
        suggestion: this.suggestModelPricing(m, cfg, stats),
      };
    });
    const mediaRows = mediaPricings.map((m: any) => ({
      ...m,
      suggestion: this.suggestMediaPricing(m, cfg),
    }));
    const notes: string[] = [];
    if (!modelRows.some((r: any) => r.cost.inputPerMillionCny > 0 || r.cost.outputPerMillionCny > 0)) {
      notes.push("还没有填写上游成本：请按火山方舟/上游账单填写 元/百万 token 后再点「按成本重算」。");
    }
    if (!mediaRows.some((r: any) => r.suggestion.hasCost)) {
      notes.push("媒体任务的上游成本（RunningHub 币数）还没填写：文生图约 157 币/次、图生视频约 150 币/次、对口型 3 秒约 69 币，可按实测填写。");
    }
    return { config: cfg, creditsPerYuan: cfg.creditsPerYuan, models: modelRows, media: mediaRows, notes, days };
  }

  /** 更新全局参数（带校验与留痕） */
  async updateConfig(patch: any, operator?: string) {
    const before = await this.getConfig(true);
    const data: any = { updatedBy: operator ?? null };
    const intFields = ["creditsPerYuan", "targetMarginPercent", "minCreditsPerRequest", "trialCredits"];
    for (const f of intFields) {
      if (patch?.[f] === undefined) continue;
      const v = Math.trunc(Number(patch[f]));
      if (!Number.isFinite(v)) throw new BadRequestException(f + " 必须是数字");
      data[f] = v;
    }
    if (patch?.mediaCoinCny !== undefined) {
      const v = Number(patch.mediaCoinCny);
      if (!Number.isFinite(v) || v < 0) throw new BadRequestException("RunningHub 币价必须是大于等于 0 的数字");
      data.mediaCoinCny = v;
    }
    if (data.creditsPerYuan !== undefined && data.creditsPerYuan <= 0) throw new BadRequestException("1 元兑换积分必须大于 0");
    if (data.minCreditsPerRequest !== undefined && data.minCreditsPerRequest < 1) throw new BadRequestException("单次最低积分至少 1");
    if (data.trialCredits !== undefined && data.trialCredits < 0) throw new BadRequestException("试用积分不能为负");
    if (data.targetMarginPercent !== undefined && data.targetMarginPercent < 0) throw new BadRequestException("目标毛利不能为负");
    const after = await this.prisma.pricingConfig.update({ where: { id: CONFIG_ID }, data });
    this.clearCache();
    await this.prisma.pricingChangeLog.create({
      data: { scope: "config", target: CONFIG_ID, before: JSON.stringify(before), after: JSON.stringify(after), operator: operator ?? null },
    });
    return after;
  }

  /** 按成本重算：preview 只返回差异，apply 写回并留痕 */
  async recalc(opts: { mode?: string; operator?: string; days?: number } = {}) {
    const mode = opts.mode === "apply" ? "apply" : "preview";
    const view = await this.overview(opts.days ?? 30);
    const changes: any[] = [];
    for (const row of view.models) {
      const s = row.suggestion;
      const changed =
        row.pricingMode !== s.pricingMode ||
        row.pricePerInputToken !== s.pricePerInputToken ||
        row.pricePerOutputToken !== s.pricePerOutputToken ||
        row.pricePerRequest !== s.pricePerRequest;
      if (!changed) continue;
      changes.push({
        scope: "model",
        target: row.modelId,
        before: { pricingMode: row.pricingMode, pricePerInputToken: row.pricePerInputToken, pricePerOutputToken: row.pricePerOutputToken, pricePerRequest: row.pricePerRequest },
        after: { pricingMode: s.pricingMode, pricePerInputToken: s.pricePerInputToken, pricePerOutputToken: s.pricePerOutputToken, pricePerRequest: s.pricePerRequest },
      });
    }
    for (const row of view.media) {
      const s = row.suggestion;
      const perSecond = row.pricingMode === "per_input_second";
      const changed = perSecond ? row.pricePerInputSecond !== s.pricePerInputSecond : row.pricePerRequest !== s.pricePerRequest;
      if (!changed) continue;
      changes.push({
        scope: "media",
        target: row.taskType,
        before: { pricePerRequest: row.pricePerRequest, pricePerInputSecond: row.pricePerInputSecond },
        after: perSecond ? { pricePerRequest: row.pricePerRequest, pricePerInputSecond: s.pricePerInputSecond } : { pricePerRequest: s.pricePerRequest, pricePerInputSecond: row.pricePerInputSecond },
      });
    }
    if (mode === "preview") return { mode, changes, config: view.config, notes: view.notes };
    for (const c of changes) {
      if (c.scope === "model") {
        await this.prisma.modelPricing.update({ where: { modelId: c.target }, data: c.after });
      } else {
        await this.prisma.mediaPricing.update({ where: { taskType: c.target }, data: c.after });
      }
      await this.prisma.pricingChangeLog.create({
        data: { scope: c.scope, target: c.target, before: JSON.stringify(c.before), after: JSON.stringify(c.after), operator: opts.operator ?? null },
      });
    }
    this.clearCache();
    return { mode, applied: changes.length, changes, notes: view.notes };
  }

  /** 定价变更历史 */
  listChangeLog(limit = 50) {
    return this.prisma.pricingChangeLog.findMany({ orderBy: { createdAt: "desc" }, take: Math.min(200, Math.max(1, limit)) });
  }
}