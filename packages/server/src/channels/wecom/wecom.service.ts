import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ChannelsConfig } from "../channels.config";
import { decrypt, encrypt, signature } from "../crypto/wecom-crypto";
import { parseFlatXml } from "./xml";

/**
 * 企业微信自建应用渠道服务
 *
 * 协议来源（官方文档）：
 * - 接收消息 / 回调配置：https://developer.work.weixin.qq.com/document/path/90930
 * - 加解密方案：https://developer.work.weixin.qq.com/document/path/90968
 * - 获取 access_token：https://developer.work.weixin.qq.com/document/path/91039
 * - 发送应用消息：https://developer.work.weixin.qq.com/document/path/90236
 *
 * 本服务只负责「协议层」：验签、解密、加密回复、access_token 缓存、发消息。
 * 业务路由（消息 → 员工任务）在 dispatcher.service.ts，避免与本服务形成循环依赖。
 */

const WECOM_API_BASE = "https://qyapi.weixin.qq.com";
/** access_token 提前 300 秒刷新（官方有效期 7200 秒） */
const TOKEN_EARLY_REFRESH_SECONDS = 300;
/** 无效 token 错误码：40014 = 不合法的 access_token，42001 = access_token 已过期 */
const TOKEN_INVALID_CODES = [40014, 42001];

function pick(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? "");
  return value === undefined || value === null ? "" : String(value);
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text, httpStatus: response.status };
  }
}

@Injectable()
export class WeComService {
  private readonly logger = new Logger("WeComChannel");
  private tokenCache: { value: string; expiresAt: number } | null = null;
  private tokenPromise: Promise<string> | null = null;
  private lastCallback: Date | null = null;

  constructor(private readonly config: ChannelsConfig) {}

  /** 配置状态（密钥只返回布尔值，agentId 脱敏） */
  status() {
    const c = this.config.wecom;
    return {
      configured: this.config.isWeComConfigured(),
      corpid: c.corpid || null,
      agentId: this.config.mask(c.agentId),
      hasToken: Boolean(c.token),
      hasAesKey: Boolean(c.aesKey),
      hasSecret: Boolean(c.secret),
      lastCallbackAt: this.lastCallback ? this.lastCallback.toISOString() : null,
    };
  }

  getLastCallbackAt(): string | null {
    return this.lastCallback ? this.lastCallback.toISOString() : null;
  }

  touchCallback() {
    this.lastCallback = new Date();
  }

  /** 回调 URL 验证：GM 传的 echostr 是密文，验签后解密并返回明文 */
  verifyUrl(query: Record<string, unknown>): string {
    const c = this.config.wecom;
    if (!this.config.canHandleWeComCallback()) {
      throw new ServiceUnavailableException({ code: "WECOM_NOT_CONFIGURED", message: "企业微信渠道未配置" });
    }
    const msgSignature = pick(query.msg_signature);
    const timestamp = pick(query.timestamp);
    const nonce = pick(query.nonce);
    const echostr = pick(query.echostr);
    if (!msgSignature || !timestamp || !nonce || !echostr) {
      throw new BadRequestException({ code: "WECOM_VERIFY_PARAM_MISSING", message: "缺少 msg_signature/timestamp/nonce/echostr" });
    }
    const expected = signature(c.token, timestamp, nonce, echostr);
    if (expected !== msgSignature) {
      throw new ForbiddenException({ code: "WECOM_SIGNATURE_INVALID", message: "企业微信回调签名校验失败" });
    }
    return decrypt(echostr, c.corpid, c.aesKey);
  }

  /**
   * 接收消息：解析 <Encrypt> → 验签 → AES 解密 → 校验 receiveid(corpid) → 返回明文 XML 解析结果
   */
  decryptInbound(query: Record<string, unknown>, rawBody: string): Record<string, string> {
    const c = this.config.wecom;
    if (!this.config.canHandleWeComCallback()) {
      throw new ServiceUnavailableException({ code: "WECOM_NOT_CONFIGURED", message: "企业微信渠道未配置" });
    }
    const msgSignature = pick(query.msg_signature);
    const timestamp = pick(query.timestamp);
    const nonce = pick(query.nonce);
    if (!msgSignature || !timestamp || !nonce) {
      throw new BadRequestException({ code: "WECOM_MESSAGE_PARAM_MISSING", message: "缺少 msg_signature/timestamp/nonce" });
    }
    const envelope = parseFlatXml(rawBody);
    const encrypted = envelope.Encrypt;
    if (!encrypted) {
      throw new BadRequestException({ code: "WECOM_ENCRYPT_MISSING", message: "回调报文缺少 <Encrypt> 节点" });
    }
    const expected = signature(c.token, timestamp, nonce, encrypted);
    if (expected !== msgSignature) {
      throw new ForbiddenException({ code: "WECOM_SIGNATURE_INVALID", message: "企业微信消息签名校验失败" });
    }
    const plainXml = decrypt(encrypted, c.corpid, c.aesKey);
    return parseFlatXml(plainXml);
  }

  /** 把明文回复 XML 加密成企微要求的被动回复报文 */
  encryptReply(plainXml: string): string {
    const c = this.config.wecom;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = String(Math.floor(Math.random() * 1_000_000_000));
    const encrypted = encrypt(plainXml, c.corpid, c.aesKey);
    const msgSignature = signature(c.token, timestamp, nonce, encrypted);
    return (
      "<xml>" +
      "<Encrypt>" + "<![CDATA[" + encrypted + "]]>" + "</Encrypt>" +
      "<MsgSignature>" + "<![CDATA[" + msgSignature + "]]>" + "</MsgSignature>" +
      "<TimeStamp>" + timestamp + "</TimeStamp>" +
      "<Nonce>" + "<![CDATA[" + nonce + "]]>" + "</Nonce>" +
      "</xml>"
    );
  }

  /** 内部 /send 接口：给指定成员发文本应用消息 */
  async send(body: any) {
    const touser = typeof body?.touser === "string" ? body.touser.trim() : "";
    if (!touser) throw new BadRequestException({ code: "WECOM_TOUSER_REQUIRED", message: "touser 不能为空" });
    const msgtype = typeof body?.msgtype === "string" ? body.msgtype : "text";
    if (msgtype !== "text") throw new BadRequestException({ code: "WECOM_MSGTYPE_UNSUPPORTED", message: "首版只支持 text 消息" });
    const content = typeof body?.text?.content === "string" ? body.text.content : "";
    return this.sendText(touser, content);
  }

  /** 发送文本应用消息（内部调用 + dispatcher 任务完成后主动推送） */
  async sendText(touser: string, content: string) {
    if (!this.config.isWeComConfigured()) {
      throw new ServiceUnavailableException({ code: "WECOM_NOT_CONFIGURED", message: "企业微信渠道未配置" });
    }
    const c = this.config.wecom;
    const payload = {
      touser,
      msgtype: "text",
      agentid: Number(c.agentId) || c.agentId,
      text: { content },
    };
    const result = await this.requestWithToken("/cgi-bin/message/send", payload);
    if (result && result.errcode && result.errcode !== 0) {
      throw new BadGatewayException({ code: "WECOM_SEND_FAILED", errcode: result.errcode, errmsg: result.errmsg });
    }
    return { ok: true, errcode: result?.errcode ?? 0, errmsg: result?.errmsg ?? "ok", msgid: result?.msgid ?? null, invaliduser: result?.invaliduser ?? null };
  }

  /**
   * 带了 access_token 的请求；遇到 40014/42001 清缓存重试一次
   */
  private async requestWithToken(path: string, payload: any): Promise<any> {
    let token = await this.getAccessToken();
    let result = await fetchJson(WECOM_API_BASE + path + "?access_token=" + encodeURIComponent(token), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (result && TOKEN_INVALID_CODES.includes(Number(result.errcode))) {
      this.logger.warn("企微 access_token 失效(" + result.errcode + ")，清缓存后重试一次");
      this.tokenCache = null;
      token = await this.getAccessToken(true);
      result = await fetchJson(WECOM_API_BASE + path + "?access_token=" + encodeURIComponent(token), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    return result;
  }

  /**
   * access_token 缓存：expires_in 7200 秒，提前 300 秒刷新；
   * 并发去重（同一个 Promise），避免同时请求 gettoken 触发频率限制。
   */
  async getAccessToken(force = false): Promise<string> {
    if (!force && this.tokenCache && Date.now() < this.tokenCache.expiresAt) return this.tokenCache.value;
    if (this.tokenPromise) return this.tokenPromise;
    const c = this.config.wecom;
    if (!c.corpid || !c.secret) {
      throw new ServiceUnavailableException({ code: "WECOM_NOT_CONFIGURED", message: "企业微信 corpid/secret 未配置" });
    }
    this.tokenPromise = (async () => {
      const url =
        WECOM_API_BASE +
        "/cgi-bin/gettoken?corpid=" + encodeURIComponent(c.corpid) +
        "&corpsecret=" + encodeURIComponent(c.secret);
      const result = await fetchJson(url, { method: "GET" });
      if (!result || result.errcode) {
        throw new BadGatewayException({ code: "WECOM_TOKEN_FAILED", errcode: result?.errcode ?? -1, errmsg: result?.errmsg ?? "获取 access_token 失败" });
      }
      const expiresIn = Number(result.expires_in) || 7200;
      const ttlSeconds = Math.max(60, expiresIn - TOKEN_EARLY_REFRESH_SECONDS);
      this.tokenCache = { value: String(result.access_token), expiresAt: Date.now() + ttlSeconds * 1000 };
      this.logger.log("企微 access_token 已刷新，剩余 " + ttlSeconds + " 秒缓存");
      return this.tokenCache.value;
    })().finally(() => {
      this.tokenPromise = null;
    });
    return this.tokenPromise;
  }
}
