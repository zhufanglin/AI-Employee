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
  // 非推理的小模型：记忆语义检索（扩展词 / 重排）用它，1–2s 内出结果
  "doubao-seed-2.0-mini": { provider: "ark", upstreamModel: "doubao-seed-2-0-mini-260428" },
  "glm-5.1": { provider: "ark", upstreamModel: "glm-4-5-air-20250728" },
  "deepseek-v3.2": { provider: "ark", upstreamModel: "doubao-seed-2-1-pro-260628" },
  "deepseek-v4-flash": { provider: "ark", upstreamModel: "doubao-seed-2-1-turbo-260628" },
  "deepseek-v4-pro": { provider: "ark", upstreamModel: "doubao-seed-2-1-pro-260628" },
  "minimax-latest": { provider: "ark", upstreamModel: "doubao-seed-2-1-pro-260628" },
  "kimi-k2.6": { provider: "ark", upstreamModel: "doubao-seed-2-1-pro-260628" },
};

/** 上游网关类 5xx：重试通常能过；4xx 是参数/额度问题，重试没意义。 */
const GATEWAY_STATUS = new Set([500, 502, 503, 504, 529]);

/**
 * Node fetch 的 TypeError('fetch failed') 本身没有信息量，真正原因在 e.cause（ECONNRESET / ETIMEDOUT / ENOTFOUND…）。
 * 日志和用户提示都带上 cause，下次上游抖动才能定位是 DNS、连接被重置还是超时。
 */
function describeFetchError(e: any): string {
  if (!e) return "unknown";
  const cause = e.cause;
  const code = cause?.code || cause?.errno || (typeof cause === "string" ? cause : "");
  const causeMsg = cause?.message && cause.message !== e.message ? ` ${cause.message}` : "";
  const base = `${e.message ?? String(e)}`;
  return code ? `${base}（${code}${causeMsg}）` : `${base}${causeMsg}`;
}

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

  // 网络层瞬时失败（DNS/连接重置/网关 5xx）在跨境出口很常见：
  // 之前只重试 1 次（合计约 1 秒窗口）不够——实测一次 1 秒级的抖动就能把整个员工任务打成 failed，
  // 用户看到的还是一条「Bad Gateway Exception」。现在网络错误重试 3 次（0.4s/1.2s/2.4s 退避），
  // 网关类 5xx 也重试，把这类抖动吃掉。
  private async fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
    let lastErr: any;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(url, init);
        if (GATEWAY_STATUS.has(res.status) && i < attempts - 1) {
          this.logger.warn(`upstream ${res.status} (attempt ${i + 1}/${attempts}), retrying`);
          await new Promise((r) => setTimeout(r, 400 * 3 ** i));
          continue;
        }
        return res;
      } catch (e: any) {
        lastErr = e;
        this.logger.warn(`upstream fetch failed (attempt ${i + 1}/${attempts}): ${describeFetchError(e)}`);
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * 3 ** i));
      }
    }
    throw new BadGatewayException({
      error: { message: `上游网络不可达，请稍后重试（${describeFetchError(lastErr)}）`, code: "UPSTREAM_UNREACHABLE" },
    });
  }

  /** 把上游的原始错误翻译成给用户看的中文（欠费 / 模型不存在 / 鉴权 / 限流），避免把小作文暴露到界面。 */
  private upstreamError(target: ResolvedUpstream, status: number, text: string): { message: string; code: string } {
    const raw = (text || "").slice(0, 200);
    if (/AccountOverdueError|overdue balance|arrear/i.test(text)) {
      return {
        message: `模型服务账户余额不足或已逾期（${target.provider}），请联系管理员充值后再试。原始信息：${raw}`,
        code: "UPSTREAM_ACCOUNT_OVERDUE",
      };
    }
    if (/InvalidEndpointOrModel|does not exist or you do not have access/i.test(text)) {
      return { message: `模型未开通或名称不存在（${target.provider} ${status}）：${raw}`, code: "UPSTREAM_MODEL_NOT_FOUND" };
    }
    if (status === 401 || /AuthenticationError|invalid api key/i.test(text)) {
      return { message: `模型服务鉴权失败（${target.provider}），请检查 API Key 配置。原始信息：${raw}`, code: "UPSTREAM_AUTH_FAILED" };
    }
    if (status === 429 || /RateLimit|quota exceeded/i.test(text)) {
      return { message: `模型服务调用频率或配额超限（${target.provider}），请稍后重试。原始信息：${raw}`, code: "UPSTREAM_RATE_LIMITED" };
    }
    return { message: `上游模型调用失败: ${status} ${raw}`, code: "UPSTREAM_ERROR" };
  }

  async chat(target: ResolvedUpstream, body: Record<string, any>): Promise<any> {
    const url = `${target.baseUrl}/chat/completions`;
    const res = await this.fetchWithRetry(url, { method: "POST", headers: this.headers(target), body: this.buildBody(target, body, false) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      this.logger.error(`upstream ${target.provider} ${res.status}: ${text.slice(0, 500)}`);
      throw new BadGatewayException({ error: this.upstreamError(target, res.status, text) });
    }
    return res.json();
  }

  async streamChat(target: ResolvedUpstream, body: Record<string, any>): Promise<Response> {
    const url = `${target.baseUrl}/chat/completions`;
    const res = await this.fetchWithRetry(url, { method: "POST", headers: this.headers(target), body: this.buildBody(target, body, true) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      this.logger.error(`upstream stream ${target.provider} ${res.status}: ${text.slice(0, 500)}`);
      throw new BadGatewayException({ error: this.upstreamError(target, res.status, text) });
    }
    return res as unknown as Response;
  }
}