import { BadGatewayException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { env } from "../common/env";

export interface ResolvedUpstream {
  /** 数据库里的展示别名（计费口径） */
  alias: string;
  provider: "ark" | "deepseek" | "moonshot" | "siliconflow";
  baseUrl: string;
  apiKey: string;
  /** 真正发给上游的模型 id */
  upstreamModel: string;
}

/**
 * 原版 DB 里的 modelId 是展示别名（doubao-seed-2.0-pro / ark-code-latest …），
 * 真正调用上游需要带日期后缀的 model id。映射优先级：
 * 1. ModelPricing.provider + ModelPricing.upstreamModelId（后台可改）
 * 2. 代码内置 ALIAS_MAP
 * 3. 站点默认模型（DEFAULT_UPSTREAM_MODEL）
 */
const ALIAS_MAP: Record<string, { provider: ResolvedUpstream["provider"]; upstreamModel: string }> = {
  "ark-code-latest": { provider: "ark", upstreamModel: "doubao-seed-2-0-code-preview-260215" },
  "doubao-seed-code": { provider: "ark", upstreamModel: "doubao-seed-2-0-code-preview-260215" },
  "doubao-seed-2.0-code": { provider: "ark", upstreamModel: "doubao-seed-2-0-code-preview-260215" },
  "doubao-seed-2.0-pro": { provider: "ark", upstreamModel: "doubao-seed-2-1-pro-260628" },
  "doubao-seed-2.0-lite": { provider: "ark", upstreamModel: "doubao-seed-2-0-lite-260428" },
  "glm-5.1": { provider: "ark", upstreamModel: "glm-4-5-air-20250728" },
  "deepseek-v3.2": { provider: "ark", upstreamModel: "doubao-seed-2-1-pro-260628" },
  "deepseek-v4-flash": { provider: "ark", upstreamModel: "doubao-seed-2-1-turbo-260628" },
  "deepseek-v4-pro": { provider: "ark", upstreamModel: "doubao-seed-2-1-pro-260628" },
  "minimax-latest": { provider: "ark", upstreamModel: "doubao-seed-2-1-pro-260628" },
  "kimi-k2.6": { provider: "ark", upstreamModel: "doubao-seed-2-1-pro-260628" },
};

const PROVIDER_DEFAULTS: Record<ResolvedUpstream["provider"], { baseUrlEnv: string; baseUrl: string; keyEnv: string }> = {
  ark: { baseUrlEnv: "ARK_BASE_URL", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", keyEnv: "ARK_API_KEY" },
  deepseek: { baseUrlEnv: "DEEPSEEK_BASE_URL", baseUrl: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY" },
  moonshot: { baseUrlEnv: "MOONSHOT_BASE_URL", baseUrl: "https://api.moonshot.cn/v1", keyEnv: "MOONSHOT_API_KEY" },
  siliconflow: { baseUrlEnv: "SILICONFLOW_BASE_URL", baseUrl: "https://api.siliconflow.cn/v1", keyEnv: "SILICONFLOW_API_KEY" },
};

@Injectable()
export class ProvidersService {
  private readonly logger = new Logger(ProvidersService.name);

  constructor(private prisma: PrismaService) {}

  async resolve(alias: string): Promise<ResolvedUpstream> {
    const pricing = await this.prisma.modelPricing.findUnique({ where: { modelId: alias } });
    const mapped = ALIAS_MAP[alias];
    const providerName = ((pricing as any)?.provider || mapped?.provider || "ark") as ResolvedUpstream["provider"];
    const def = PROVIDER_DEFAULTS[providerName] || PROVIDER_DEFAULTS.ark;
    const upstreamModel =
      (pricing as any)?.upstreamModelId ||
      mapped?.upstreamModel ||
      env("DEFAULT_UPSTREAM_MODEL", "doubao-seed-2-1-pro-260628");
    const apiKey = env(def.keyEnv, "");
    if (!apiKey) {
      throw new BadGatewayException({ error: { message: `未配置 ${def.keyEnv}，无法调用模型`, code: "PROVIDER_NOT_CONFIGURED" } });
    }
    return {
      alias,
      provider: providerName,
      baseUrl: env(def.baseUrlEnv, def.baseUrl).replace(/\/$/, ""),
      apiKey,
      upstreamModel,
    };
  }

  /** 列出所有可用上游模型（运维用） */
  async listUpstreamModels(): Promise<{ alias: string; provider: string; upstreamModel: string }[]> {
    const pricings = await this.prisma.modelPricing.findMany({ where: { isActive: true } });
    const out: { alias: string; provider: string; upstreamModel: string }[] = [];
    for (const p of pricings) {
      const mapped = ALIAS_MAP[p.modelId];
      out.push({
        alias: p.modelId,
        provider: (p as any).provider || mapped?.provider || "ark",
        upstreamModel: (p as any).upstreamModelId || mapped?.upstreamModel || env("DEFAULT_UPSTREAM_MODEL", "doubao-seed-2-1-pro-260628"),
      });
    }
    return out;
  }

  private buildBody(target: ResolvedUpstream, body: Record<string, any>, stream: boolean) {
    const { model: _ignored, ...rest } = body;
    return JSON.stringify({ ...rest, model: target.upstreamModel, stream });
  }

  private headers(target: ResolvedUpstream): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${target.apiKey}`,
    };
  }

  // 网络层瞬时失败（DNS/连接重置）在跨境出口很常见：非流式请求重试一次，避免把 500 直接甩给用户
  private async fetchWithRetry(url: string, init: RequestInit, attempts = 2): Promise<Response> {
    let lastErr: any;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fetch(url, init);
      } catch (e: any) {
        lastErr = e;
        this.logger.warn(`upstream fetch failed (attempt ${i + 1}/${attempts}): ${e?.message ?? e}`);
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
    throw new BadGatewayException({
      error: { message: `上游网络不可达，请稍后重试（${lastErr?.message ?? lastErr}）`, code: "UPSTREAM_UNREACHABLE" },
    });
  }

  async chat(target: ResolvedUpstream, body: Record<string, any>): Promise<any> {
    const url = `${target.baseUrl}/chat/completions`;
    const res = await this.fetchWithRetry(url, { method: "POST", headers: this.headers(target), body: this.buildBody(target, body, false) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      this.logger.error(`upstream ${target.provider} ${res.status}: ${text.slice(0, 500)}`);
      throw new BadGatewayException({ error: { message: `上游模型调用失败: ${res.status} ${text.slice(0, 200)}`, code: "UPSTREAM_ERROR" } });
    }
    return res.json();
  }

  async streamChat(target: ResolvedUpstream, body: Record<string, any>): Promise<Response> {
    const url = `${target.baseUrl}/chat/completions`;
    const res = await this.fetchWithRetry(url, { method: "POST", headers: this.headers(target), body: this.buildBody(target, body, true) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      this.logger.error(`upstream stream ${target.provider} ${res.status}: ${text.slice(0, 500)}`);
      throw new BadGatewayException({ error: { message: `上游模型调用失败: ${res.status} ${text.slice(0, 200)}`, code: "UPSTREAM_ERROR" } });
    }
    return res as unknown as Response;
  }
}