import { Injectable, Logger } from "@nestjs/common";
import { createHmac, randomUUID } from "node:crypto";
import { env, envBool, envInt } from "../common/env";

/**
 * 短信发送器
 *  - 未配置 ALIYUN_SMS_ACCESS_KEY_ID 时用开发模式（只打日志、返回 devCode）
 *  - 配置后走阿里云 Dysmsapi SendSms（RPC 签名 HMAC-SHA1 + POST 表单）
 *  - DEV_SMS_ALLOWLIST：逗号分隔的手机号，命中时直接返回 devCode（内测用，不真实发送）
 */
@Injectable()
export class SmsSender {
  private readonly logger = new Logger(SmsSender.name);

  get devMode(): boolean {
    return !env("ALIYUN_SMS_ACCESS_KEY_ID");
  }

  async send(phone: string, code: string, purpose: string): Promise<{ sent: boolean; devCode?: string }> {
    const allow = env("DEV_SMS_ALLOWLIST", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    // "*" 表示本地/CI 全放开（只应出现在开发与测试环境）
    if (allow.includes(phone) || allow.includes("*")) {
      this.logger.warn("[DEV-SMS allowlist] phone=" + phone + " purpose=" + purpose + " code=" + code);
      return { sent: true, devCode: code };
    }
    if (this.devMode) {
      this.logger.warn("[DEV-SMS] phone=" + phone + " purpose=" + purpose + " code=" + code);
      return { sent: true, devCode: envBool("DEV_RETURN_SMS_CODE", true) ? code : undefined };
    }
    try {
      await this.aliyunSend(phone, code);
      return { sent: true };
    } catch (error) {
      this.logger.error("阿里云短信发送失败: " + (error as Error).message);
      return { sent: false };
    }
  }

  private async aliyunSend(phone: string, code: string): Promise<void> {
    const params: Record<string, string> = {
      AccessKeyId: env("ALIYUN_SMS_ACCESS_KEY_ID"),
      Action: "SendSms",
      Format: "JSON",
      PhoneNumbers: phone,
      RegionId: env("ALIYUN_SMS_REGION", "cn-hangzhou"),
      SignName: env("ALIYUN_SMS_SIGN_NAME"),
      SignatureMethod: "HMAC-SHA1",
      SignatureNonce: randomUUID(),
      SignatureVersion: "1.0",
      TemplateCode: env("ALIYUN_SMS_TEMPLATE_CODE"),
      TemplateParam: JSON.stringify({ code }),
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      Version: "2017-05-25",
    };
    const signature = signRpc(params, env("ALIYUN_SMS_ACCESS_KEY_SECRET"));
    const body = Object.entries({ ...params, Signature: signature })
      .map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value))
      .join("&");
    const response = await fetch("https://dysmsapi.aliyuncs.com/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(envInt("ALIYUN_SMS_TIMEOUT_MS", 10000)),
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
