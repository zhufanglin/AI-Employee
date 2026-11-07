import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { createDecipheriv, createSign, createVerify, randomBytes, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { env } from "../common/env";

export interface WechatPayCredentials {
  appId: string;
  mchId: string;
  serialNo: string;
  privateKey: string;
  apiV3Key: string;
  notifyUrl: string;
  baseUrl: string;
  platformPublicKey?: string;
  mock: boolean;
}

export interface NotifyResult {
  orderNo: string;
  transactionId: string;
  tradeState: string;
  amountTotal: number;
  successTime?: string;
  eventType: string;
}

/**
 * 微信支付 APIv3 客户端（Native 扫码支付）。
 * 仅在配置齐全时对外可用；WECHAT_PAY_MOCK=1 时走本地模拟，用于开发与冒烟。
 */
@Injectable()
export class WechatPayService {
  private readonly logger = new Logger("WechatPay");

  credentials(): WechatPayCredentials {
    const mock = env("WECHAT_PAY_MOCK", "0") === "1";
    const privateKey = this.readPrivateKey();
    return {
      appId: env("WECHAT_PAY_APP_ID", ""),
      mchId: env("WECHAT_PAY_MCH_ID", ""),
      serialNo: env("WECHAT_PAY_SERIAL_NO", ""),
      privateKey,
      apiV3Key: env("WECHAT_PAY_API_V3_KEY", ""),
      notifyUrl: env("WECHAT_PAY_NOTIFY_URL", ""),
      baseUrl: env("WECHAT_PAY_BASE_URL", "https://api.mch.weixin.qq.com"),
      platformPublicKey: this.readPlatformKey(),
      mock,
    };
  }

  isConfigured(): boolean {
    const c = this.credentials();
    if (c.mock) return Boolean(c.appId && c.mchId);
    return Boolean(c.appId && c.mchId && c.serialNo && c.privateKey && c.apiV3Key && c.notifyUrl);
  }

  status() {
    const c = this.credentials();
    return { configured: this.isConfigured(), mock: c.mock, appId: c.appId, mchId: c.mchId };
  }

  private readPrivateKey(): string {
    const inline = env("WECHAT_PAY_PRIVATE_KEY", "");
    if (inline) return inline.replace(/\\n/g, "\n");
    const path = env("WECHAT_PAY_PRIVATE_KEY_PATH", "");
    if (!path) return "";
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  }

  private readPlatformKey(): string | undefined {
    const inline = env("WECHAT_PAY_PLATFORM_PUBLIC_KEY", "");
    if (inline) return inline.replace(/\\n/g, "\n");
    const certPath = env("WECHAT_PAY_PLATFORM_CERT_PATH", "");
    if (!certPath) return undefined;
    try {
      return new X509Certificate(readFileSync(certPath, "utf8")).publicKey.export({ type: "spki", format: "pem" }).toString();
    } catch {
      return undefined;
    }
  }

  /** 构造 WECHATPAY2-SHA256-RSA2048 授权头 */
  authorization(method: string, urlPath: string, body: string, creds = this.credentials()): string {
    if (!creds.privateKey) {
      throw new ServiceUnavailableException({
        error: { message: "微信支付未配置商户私钥（WECHAT_PAY_PRIVATE_KEY_PATH），请先配置", code: "WECHAT_PAY_NOT_CONFIGURED" },
      });
    }
    const nonce = randomBytes(16).toString("hex");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const message = [method.toUpperCase(), urlPath, timestamp, nonce, body].join("\n") + "\n";
    const signature = createSign("RSA-SHA256").update(message).sign(creds.privateKey, "base64");
    return (
      'WECHATPAY2-SHA256-RSA2048 ' +
      'mchid="' + creds.mchId + '",' +
      'nonce_str="' + nonce + '",' +
      'timestamp="' + timestamp + '",' +
      'serial_no="' + creds.serialNo + '",' +
      'signature="' + signature + '"'
    );
  }

  /** 校验回调签名（使用微信支付平台公钥/证书） */
  verifyNotifySignature(headers: Record<string, any>, rawBody: string, creds = this.credentials()): boolean {
    if (creds.mock) return true;
    const timestamp = String(headers["wechatpay-timestamp"] ?? "");
    const nonce = String(headers["wechatpay-nonce"] ?? "");
    const signature = String(headers["wechatpay-signature"] ?? "");
    if (!timestamp || !nonce || !signature) return false;
    if (!creds.platformPublicKey) {
      this.logger.error("缺少微信支付平台公钥/证书，无法验签（WECHAT_PAY_PLATFORM_PUBLIC_KEY / WECHAT_PAY_PLATFORM_CERT_PATH）");
      return false;
    }
    // 拒绝 5 分钟以外的回调，防重放
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
    const message = timestamp + "\n" + nonce + "\n" + rawBody + "\n";
    try {
      return createVerify("RSA-SHA256").update(message).verify(creds.platformPublicKey, signature, "base64");
    } catch {
      return false;
    }
  }

  /** AES-256-GCM 解密回调 resource */
  decryptResource(resource: { ciphertext: string; nonce: string; associated_data?: string }, creds = this.credentials()): any {
    if (!creds.apiV3Key) {
      throw new ServiceUnavailableException({
        error: { message: "微信支付未配置 APIv3 密钥（WECHAT_PAY_API_V3_KEY）", code: "WECHAT_PAY_NOT_CONFIGURED" },
      });
    }
    const data = Buffer.from(resource.ciphertext, "base64");
    const authTag = data.subarray(data.length - 16);
    const ciphertext = data.subarray(0, data.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(creds.apiV3Key, "utf8"), Buffer.from(resource.nonce, "utf8"));
    decipher.setAuthTag(authTag);
    if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data, "utf8"));
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return JSON.parse(plain);
  }

  /** 解析支付结果回调：验签 → 解密 → 归一化 */
  async parseNotify(headers: Record<string, any>, rawBody: string): Promise<NotifyResult> {
    const creds = this.credentials();
    if (!this.verifyNotifySignature(headers, rawBody, creds)) {
      throw new BadGatewayException({ error: { message: "微信支付回调验签失败", code: "INVALID_NOTIFY_SIGNATURE" } });
    }
    const payload = JSON.parse(rawBody);
    if (creds.mock) {
      // 本地模拟：明文报文，跳过解密（仅 WECHAT_PAY_MOCK=1）
      return {
        eventType: "MOCK",
        orderNo: payload.out_trade_no,
        transactionId: payload.transaction_id ?? "mock_" + Date.now(),
        tradeState: payload.trade_state ?? "SUCCESS",
        amountTotal: payload.amount_total,
      };
    }
    const resource = this.decryptResource(payload.resource, creds);
    return {
      eventType: payload.event_type,
      orderNo: resource.out_trade_no,
      transactionId: resource.transaction_id,
      tradeState: resource.trade_state,
      amountTotal: resource.amount?.total ?? 0,
      successTime: resource.success_time,
    };
  }

  private async request(method: string, urlPath: string, body?: unknown, creds = this.credentials()): Promise<any> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const url = creds.baseUrl.replace(/\/$/, "") + urlPath;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.authorization(method, urlPath, raw, creds),
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "fcmediaagent-replica/0.1",
      },
      body: method === "GET" ? undefined : raw,
    });
    const text = await res.text();
    if (!res.ok) {
      let detail: any = text;
      try {
        detail = JSON.parse(text);
      } catch {
        /* keep text */
      }
      this.logger.error("wechat " + method + " " + urlPath + " -> " + res.status + " " + text.slice(0, 300));
      throw new BadGatewayException({
        error: {
          message: "微信支付接口调用失败: " + (detail?.message ?? res.status),
          code: detail?.code ?? "WECHAT_PAY_ERROR",
        },
      });
    }
    return text ? JSON.parse(text) : {};
  }

  /** Native 下单，返回 code_url（前端生成二维码） */
  async createNativeOrder(input: {
    orderNo: string;
    description: string;
    amount: number;
    attach?: string;
    timeExpire?: Date;
  }): Promise<{ codeUrl: string; mock: boolean }> {
    const creds = this.credentials();
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException({
        error: { message: "微信支付尚未配置完成（APP_ID/MCH_ID/SERIAL_NO/私钥/APIv3 密钥），请联系管理员", code: "WECHAT_PAY_NOT_CONFIGURED" },
      });
    }
    if (creds.mock) {
      return { codeUrl: "weixin://wxpay/bizpayurl?pr=MOCK" + encodeURIComponent(input.orderNo), mock: true };
    }
    const body = {
      appid: creds.appId,
      mchid: creds.mchId,
      description: input.description.slice(0, 120),
      out_trade_no: input.orderNo,
      ...(input.timeExpire ? { time_expire: input.timeExpire.toISOString().replace(/\.\d{3}Z$/, "+08:00") } : {}),
      notify_url: creds.notifyUrl,
      ...(input.attach ? { attach: input.attach } : {}),
      amount: { total: input.amount, currency: "CNY" },
    };
    const data = await this.request("POST", "/v3/pay/transactions/native", body, creds);
    return { codeUrl: data.code_url as string, mock: false };
  }

  async queryOrder(orderNo: string): Promise<{ tradeState: string; transactionId?: string; amountTotal?: number; successTime?: string }> {
    const creds = this.credentials();
    const data = await this.request(
      "GET",
      "/v3/pay/transactions/out-trade-no/" + encodeURIComponent(orderNo) + "?mchid=" + encodeURIComponent(creds.mchId),
      undefined,
      creds,
    );
    return {
      tradeState: data.trade_state,
      transactionId: data.transaction_id,
      amountTotal: data.amount?.total,
      successTime: data.success_time,
    };
  }

  async closeOrder(orderNo: string): Promise<void> {
    const creds = this.credentials();
    await this.request("POST", "/v3/pay/transactions/out-trade-no/" + encodeURIComponent(orderNo) + "/close", { mchid: creds.mchId }, creds);
  }
}
