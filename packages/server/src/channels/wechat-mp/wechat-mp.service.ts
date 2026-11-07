import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ChannelsConfig } from "../channels.config";
import { decrypt, encrypt, signature } from "../crypto/wechat-mp-crypto";
import { parseFlatXml } from "./xml";

/**
 * 微信公众号（服务号）渠道服务
 *
 * 协议来源（官方文档）：
 * - 接入指南 / 服务器配置：https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/Access_Overview.html
 * - 消息加解密说明：https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Message_encryption_and_decryption_instructions.html
 * - 获取 access_token：https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/Get_access_token.html
 * - 客服消息：https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Service_Center_messages.html
 *
 * 本服务只负责协议层（验签/解密/加密回复/access_token/发消息），
 * 业务路由在 dispatcher.service.ts。
 */

const MP_API_BASE = "https://api.weixin.qq.com";
/** access_token 提前 300 秒刷新（官方有效期 7200 秒） */
const TOKEN_EARLY_REFRESH_SECONDS = 300;
/** 无效 token 错误码：40001 = 凭证无效，42001 = access_token 超时 */
const TOKEN_INVALID_CODES = [40001, 42001];

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
export class WeChatMpService {
  private readonly logger = new Logger("WeChatMpChannel");
  private tokenCache: { value: string; expiresAt: number } | null = null;
  private tokenPromise: Promise<string> | null = null;
  private lastCallback: Date | null = null;

  constructor(private readonly config: ChannelsConfig) {}

  /** 配置状态（密钥只返回布尔值；AppID 是公开标识，直接返回） */
  status() {
    const c = this.config.wechatMp;
    return {
      configured: this.config.isWeChatMpConfigured(),
      appId: c.appId || null,
      hasToken: Boolean(c.token),
      hasAesKey: Boolean(c.aesKey),
      hasAppSecret: Boolean(c.appSecret),
      lastCallbackAt: this.lastCallback ? this.lastCallback.toISOString() : null,
    };
  }

  getLastCallbackAt(): string | null {
    return this.lastCallback ? this.lastCallback.toISOString() : null;
  }

  touchCallback() {
    this.lastCallback = new Date();
  }

  /**
   * 服务器地址验证（GET）
   * - 明文模式：sha1(sort([token, timestamp, nonce]).join("")) 与 signature 比对，通过后原样返回 echostr
   * - 安全模式：若带 msg_signature 且配置了 EncodingAESKey，则按签名(含 echostr 密文)校验并解密
   */
  verifyUrl(query: Record<string, unknown>): string {
    const c = this.config.wechatMp;
    if (!this.config.canHandleWeChatMpCallback()) {
      throw new ServiceUnavailableException({ code: "WECHAT_MP_NOT_CONFIGURED", message: "公众号渠道未配置" });
    }
    const plainSignature = pick(query.signature);
    const msgSignature = pick(query.msg_signature);
    const timestamp = pick(query.timestamp);
    const nonce = pick(query.nonce);
    const echostr = pick(query.echostr);
    if (!timestamp || !nonce || !echostr) {
      throw new BadRequestException({ code: "WECHAT_MP_VERIFY_PARAM_MISSING", message: "缺少 timestamp/nonce/echostr" });
    }
    if (msgSignature && c.aesKey && c.appId) {
      const expected = signature(c.token, timestamp, nonce, echostr);
      if (expected !== msgSignature) {
        throw new ForbiddenException({ code: "WECHAT_MP_SIGNATURE_INVALID", message: "公众号安全模式签名校验失败" });
      }
      return decrypt(echostr, c.appId, c.aesKey);
    }
    if (!plainSignature) {
      throw new BadRequestException({ code: "WECHAT_MP_SIGNATURE_REQUIRED", message: "缺少 signature" });
    }
    const expected = signature(c.token, timestamp, nonce);
    if (expected !== plainSignature) {
      throw new ForbiddenException({ code: "WECHAT_MP_SIGNATURE_INVALID", message: "公众号签名校验失败" });
    }
    return echostr;
  }

  /**
   * 接收消息
   * - 安全模式（带 msg_signature）：验签后 AES 解密（receiveid = AppID）
   * - 明文/兼容模式（无 msg_signature）：校验 signature 后直接解析明文 XML
   * 返回 { msg, secure, timestamp, nonce }，由控制器决定怎么回包。
   */
  decryptInbound(query: Record<string, unknown>, rawBody: string): {
    msg: Record<string, string>;
    secure: boolean;
    timestamp: string;
    nonce: string;
  } {
    const c = this.config.wechatMp;
    if (!this.config.canHandleWeChatMpCallback()) {
      throw new ServiceUnavailableException({ code: "WECHAT_MP_NOT_CONFIGURED", message: "公众号渠道未配置" });
    }
    const plainSignature = pick(query.signature);
    const msgSignature = pick(query.msg_signature);
    const timestamp = pick(query.timestamp);
    const nonce = pick(query.nonce);
    if (!timestamp || !nonce) {
      throw new BadRequestException({ code: "WECHAT_MP_MESSAGE_PARAM_MISSING", message: "缺少 timestamp/nonce" });
    }
    if (msgSignature) {
      if (!c.aesKey || !c.appId) {
        throw new ServiceUnavailableException({ code: "WECHAT_MP_AES_NOT_CONFIGURED", message: "安全模式需要 WECHAT_MP_AES_KEY 与 WECHAT_MP_APP_ID" });
      }
      const envelope = parseFlatXml(rawBody);
      const encrypted = envelope.Encrypt;
      if (!encrypted) {
        throw new BadRequestException({ code: "WECHAT_MP_ENCRYPT_MISSING", message: "安全模式回调报文缺少 <Encrypt> 节点" });
      }
      const expected = signature(c.token, timestamp, nonce, encrypted);
      if (expected !== msgSignature) {
        throw new ForbiddenException({ code: "WECHAT_MP_SIGNATURE_INVALID", message: "公众号消息签名校验失败" });
      }
      const plainXml = decrypt(encrypted, c.appId, c.aesKey);
      return { msg: parseFlatXml(plainXml), secure: true, timestamp, nonce };
    }
    if (!plainSignature) {
      throw new BadRequestException({ code: "WECHAT_MP_SIGNATURE_REQUIRED", message: "缺少 signature" });
    }
    const expected = signature(c.token, timestamp, nonce);
    if (expected !== plainSignature) {
      throw new ForbiddenException({ code: "WECHAT_MP_SIGNATURE_INVALID", message: "公众号签名校验失败" });
    }
    return { msg: parseFlatXml(rawBody), secure: false, timestamp, nonce };
  }

  /** 安全模式：把明文回复 XML 加密成公众号要求的被动回复报文 */
  encryptReply(plainXml: string): string {
    const c = this.config.wechatMp;
    if (!c.aesKey || !c.appId) {
      throw new ServiceUnavailableException({ code: "WECHAT_MP_AES_NOT_CONFIGURED", message: "安全模式需要 WECHAT_MP_AES_KEY 与 WECHAT_MP_APP_ID" });
    }
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = String(Math.floor(Math.random() * 1_000_000_000));
    const encrypted = encrypt(plainXml, c.appId, c.aesKey);
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

  /** 内部 /send 接口：客服消息 */
  async send(body: any) {
    const touser = typeof body?.touser === "string" ? body.touser.trim() : "";
    if (!touser) throw new BadRequestException({ code: "WECHAT_MP_TOUSER_REQUIRED", message: "touser（openid）不能为空" });
    const msgtype = typeof body?.msgtype === "string" ? body.msgtype : "text";
    if (msgtype !== "text") throw new BadRequestException({ code: "WECHAT_MP_MSGTYPE_UNSUPPORTED", message: "首版只支持 text 消息" });
    const content = typeof body?.text?.content === "string" ? body.text.content : "";
    return this.sendText(touser, content);
  }

  /** 发送客服文本消息（内部调用 + dispatcher 任务完成后主动推送） */
  async sendText(touser: string, content: string) {
    if (!this.config.isWeChatMpConfigured()) {
      throw new ServiceUnavailableException({ code: "WECHAT_MP_NOT_CONFIGURED", message: "公众号渠道未配置" });
    }
    const result = await this.requestWithToken("/cgi-bin/message/custom/send", {
      touser,
      msgtype: "text",
      text: { content },
    });
    if (result && result.errcode && result.errcode !== 0) {
      throw new BadGatewayException({ code: "WECHAT_MP_SEND_FAILED", errcode: result.errcode, errmsg: result.errmsg });
    }
    return { ok: true, errcode: result?.errcode ?? 0, errmsg: result?.errmsg ?? "ok" };
  }

  /** 带 access_token 的请求；40001/42001 时清缓存重试一次 */
  private async requestWithToken(path: string, payload: any): Promise<any> {
    let token = await this.getAccessToken();
    let result = await fetchJson(MP_API_BASE + path + "?access_token=" + encodeURIComponent(token), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (result && TOKEN_INVALID_CODES.includes(Number(result.errcode))) {
      this.logger.warn("公众号 access_token 失效(" + result.errcode + ")，清缓存后重试一次");
      this.tokenCache = null;
      token = await this.getAccessToken(true);
      result = await fetchJson(MP_API_BASE + path + "?access_token=" + encodeURIComponent(token), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    return result;
  }

  /**
   * access_token 缓存：expires_in 7200 秒，提前 300 秒刷新；
   * 并发去重（同一个 Promise）。
   */
  async getAccessToken(force = false): Promise<string> {
    if (!force && this.tokenCache && Date.now() < this.tokenCache.expiresAt) return this.tokenCache.value;
    if (this.tokenPromise) return this.tokenPromise;
    const c = this.config.wechatMp;
    if (!c.appId || !c.appSecret) {
      throw new ServiceUnavailableException({ code: "WECHAT_MP_NOT_CONFIGURED", message: "公众号 appId/appSecret 未配置" });
    }
    this.tokenPromise = (async () => {
      const url =
        MP_API_BASE +
        "/cgi-bin/token?grant_type=client_credential" +
        "&appid=" + encodeURIComponent(c.appId) +
        "&secret=" + encodeURIComponent(c.appSecret);
      const result = await fetchJson(url, { method: "GET" });
      if (!result || result.errcode) {
        throw new BadGatewayException({ code: "WECHAT_MP_TOKEN_FAILED", errcode: result?.errcode ?? -1, errmsg: result?.errmsg ?? "获取 access_token 失败" });
      }
      const expiresIn = Number(result.expires_in) || 7200;
      const ttlSeconds = Math.max(60, expiresIn - TOKEN_EARLY_REFRESH_SECONDS);
      this.tokenCache = { value: String(result.access_token), expiresAt: Date.now() + ttlSeconds * 1000 };
      this.logger.log("公众号 access_token 已刷新，剩余 " + ttlSeconds + " 秒缓存");
      return this.tokenCache.value;
    })().finally(() => {
      this.tokenPromise = null;
    });
    return this.tokenPromise;
  }
}
