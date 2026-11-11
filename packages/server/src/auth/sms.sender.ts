import { Injectable, Logger } from "@nestjs/common";
import { createHmac, randomUUID } from "node:crypto";
import { env, envBool, envInt } from "../common/env";
// 注意：这里不能用 `import type`——emitDecoratorMetadata 需要运行时的类引用，
// 否则 Nest 解析到的是 Function，启动即报 UnknownDependenciesException（P43 P1 回归踩过）。
import { PrismaService } from "../prisma/prisma.service";

/**
 * 短信发送器
 *
 * 配置优先级（P43 P1-1）：
 *   1) 数据库 SmsConfig（仅 isActive=true 视为「已启用」）
 *   2) 环境变量（ALIYUN_SMS_ACCESS_KEY_ID / _SECRET / _SIGN_NAME / _TEMPLATE_CODE / _REGION / _TIMEOUT_MS）
 *   3) 都没有 -> devMode（只打日志，不真实下发）
 * DB 中缺失（空串 / null）的字段逐项回落到 env 同名配置；DB 读取异常只告警，不影响发短信。
 * 解析结果做 60 秒内存缓存，管理端保存配置后调用 invalidateSmsConfigCache() 立即失效。
 *
 * 发送方式：
 *  - 配置齐全且 provider=aliyun：阿里云 Dysmsapi SendSms（RPC 签名 HMAC-SHA1 + POST 表单）
 *  - 其他 provider：抛中文错误「暂不支持的短信服务商：xxx」
 *  - DEV_SMS_ALLOWLIST：逗号分隔的手机号，命中时直接返回 devCode（内测用，不真实发送）
 *
 * 安全约束（P43-A P0）：验证码绝不能默认回传给调用方，否则任意手机号都能接管已有账号。
 * 只有同时满足「非生产环境」+「DEV_RETURN_SMS_CODE=true」才回传；
 * DEV_SMS_ALLOWLIST 是显式的逐手机号内测名单（名单里必须是测试号，不能放真实客户号）。
 */

/** 解析后的短信配置（DB > env > 无） */
export interface SmsResolvedConfig {
  provider: string;
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;
  templateCode: string;
  region: string;
  timeoutMs: number;
  /** 配置来源：db（启用中） / env / none（devMode） */
  source: "db" | "env" | "none";
}

export interface SmsSendResult {
  sent: boolean;
  devCode?: string;
  provider?: string;
  /** 可直接展示给用户的原因（发送失败 / 未真实下发时给出） */
  message?: string;
}

interface SmsConfigRow {
  provider: string;
  secretId: string;
  secretKey: string;
  signName: string;
  templateCode: string;
  sdkAppId?: string | null;
  region: string;
  isActive: boolean;
}

/** 解析结果缓存 60 秒；管理端保存配置后调用 invalidateSmsConfigCache() 主动失效 */
const CONFIG_CACHE_TTL_MS = 60 * 1000;
let configCache: { value: SmsResolvedConfig; expiresAt: number } | null = null;

/** 供管理端在保存短信配置后调用：下一次发送立即重新读取数据库。 */
export function invalidateSmsConfigCache(): void {
  configCache = null;
}

@Injectable()
export class SmsSender {
  private readonly logger = new Logger(SmsSender.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 是否允许把验证码回传给调用方：显式开关 + 非生产环境，缺一不可。 */
  get returnCodeAllowed(): boolean {
    if (env("NODE_ENV", "development") === "production") return false;
    return envBool("DEV_RETURN_SMS_CODE", false);
  }

  async send(phone: string, code: string, purpose: string): Promise<SmsSendResult> {
    const allow = env("DEV_SMS_ALLOWLIST", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    // "*" 表示本地/CI 全放开（只应出现在开发与测试环境）
    if (allow.includes(phone) || allow.includes("*")) {
      this.logger.warn("[DEV-SMS allowlist] phone=" + phone + " purpose=" + purpose + " code=" + code +
        "（该号码可免验证码登录，仅允许测试号，用完请从 DEV_SMS_ALLOWLIST 移除）");
      return { sent: true, devCode: code, provider: "allowlist", message: "命中 DEV_SMS_ALLOWLIST，未真实下发" };
    }

    const cfg = await this.resolveConfig();
    if (!cfg.accessKeyId || !cfg.accessKeySecret) {
      // devMode：DB 与 env 都没有可用的 AK，只打日志
      this.logger.warn("[DEV-SMS] phone=" + phone + " purpose=" + purpose + " code=" + code +
        "（数据库与环境变量均未配置短信服务，未真实下发）");
      return {
        sent: true,
        devCode: this.returnCodeAllowed ? code : undefined,
        provider: cfg.provider,
        message: "短信服务未配置（开发模式），验证码仅打印到服务端日志",
      };
    }

    try {
      await this.aliyunSend(phone, code, cfg);
      return { sent: true, provider: cfg.provider };
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error("短信发送失败: " + message);
      return { sent: false, provider: cfg.provider, message };
    }
  }

  /** 读取并合并配置：DB（isActive=true）优先，缺失字段逐项回落 env；结果缓存 60 秒。 */
  private async resolveConfig(): Promise<SmsResolvedConfig> {
    const now = Date.now();
    if (configCache && configCache.expiresAt > now) return configCache.value;

    let db: SmsConfigRow | null = null;
    try {
      db = (await this.prisma.smsConfig.findFirst({ orderBy: { createdAt: "asc" } })) as SmsConfigRow | null;
    } catch (error) {
      // 读库失败不能影响发短信：告警后完全按 env 处理
      this.logger.warn("读取短信配置失败，回落到环境变量: " + (error as Error).message);
      db = null;
    }
    const dbEnabled = Boolean(db && db.isActive);

    const pick = (dbVal: string | null | undefined, envKey: string, fallback = ""): string => {
      if (dbEnabled) {
        const v = typeof dbVal === "string" ? dbVal.trim() : "";
        if (v) return v;
      }
      const ev = env(envKey, "").trim();
      return ev || fallback;
    };

    const provider = dbEnabled && db?.provider?.trim() ? db.provider.trim() : "aliyun";
    const accessKeyId = pick(db?.secretId, "ALIYUN_SMS_ACCESS_KEY_ID");
    const accessKeySecret = pick(db?.secretKey, "ALIYUN_SMS_ACCESS_KEY_SECRET");
    const cfg: SmsResolvedConfig = {
      provider,
      accessKeyId,
      accessKeySecret,
      signName: pick(db?.signName, "ALIYUN_SMS_SIGN_NAME"),
      templateCode: pick(db?.templateCode, "ALIYUN_SMS_TEMPLATE_CODE"),
      region: pick(db?.region, "ALIYUN_SMS_REGION", "cn-hangzhou"),
      timeoutMs: envInt("ALIYUN_SMS_TIMEOUT_MS", 10000),
      source: dbEnabled ? "db" : accessKeyId ? "env" : "none",
    };
    configCache = { value: cfg, expiresAt: now + CONFIG_CACHE_TTL_MS };
    return cfg;
  }

  private async aliyunSend(phone: string, code: string, cfg: SmsResolvedConfig): Promise<void> {
    if (cfg.provider !== "aliyun") {
      throw new Error("暂不支持的短信服务商：" + cfg.provider);
    }
    const params: Record<string, string> = {
      AccessKeyId: cfg.accessKeyId,
      Action: "SendSms",
      Format: "JSON",
      PhoneNumbers: phone,
      RegionId: cfg.region,
      SignName: cfg.signName,
      SignatureMethod: "HMAC-SHA1",
      SignatureNonce: randomUUID(),
      SignatureVersion: "1.0",
      TemplateCode: cfg.templateCode,
      TemplateParam: JSON.stringify({ code }),
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      Version: "2017-05-25",
    };
    const signature = signRpc(params, cfg.accessKeySecret);
    const body = Object.entries({ ...params, Signature: signature })
      .map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value))
      .join("&");
    const response = await fetch("https://dysmsapi.aliyuncs.com/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (payload.Code !== "OK") {
      throw new Error(String(payload.Message ?? payload.Code ?? ("HTTP " + response.status)));
    }
  }
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/\!/g, "%21").replace(/\*/g, "%2A").replace(/'/g, "%27").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function signRpc(params: Record<string, string>, secret: string): string {
  const canonical = Object.keys(params)
    .sort()
    .map((key) => percentEncode(key) + "=" + percentEncode(params[key]))
    .join("&");
  const stringToSign = "POST&" + percentEncode("/") + "&" + percentEncode(canonical);
  return createHmac("sha1", secret + "&").update(stringToSign).digest("base64");
}
