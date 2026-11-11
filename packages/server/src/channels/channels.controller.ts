import { Body, Controller, Get, HttpCode, Logger, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { Public } from "../common/decorators";
import { ChannelsConfig } from "./channels.config";
import { ACK_TEXT, ChannelDispatcherService, NOT_CONFIGURED_TEXT } from "./dispatcher.service";
import { WeComService } from "./wecom/wecom.service";
import { buildPassiveReplyXml } from "./wecom/xml";
import { WeChatMpService } from "./wechat-mp/wechat-mp.service";
import { PersonalWeChatService } from "./personal-wechat.service";

@Controller("channels/personal-wechat")
export class ChannelsController {
  constructor(private readonly wechat: PersonalWeChatService) {}
  @Get("status") status() { return this.wechat.status(); }
  @Get("contacts") contacts() { return this.wechat.contacts(); }
  @Get("messages") messages(@Query("chat_name") chatName: string, @Query("wx_id") wxId?: string) { return this.wechat.messages(chatName, wxId); }
  @Post("send") send(@Body() body: any) { return this.wechat.send(body?.name, body?.msg, body?.humanize === true); }
  @Post("send-file") sendFile(@Body() body: any) { return this.wechat.sendFile(body?.name, body?.file_path, body?.file_url, body?.humanize === true); }
  @Post("listen") listen(@Body() body: any) { return this.wechat.listen(body?.wxid, body?.nickname); }
}
/**
 * 回调报文是 text/xml，而 main.ts 只注册了 json/urlencoded 解析器，
 * 所以这里手动读原始流（不依赖 body 中间件，也不会改动 main.ts）。
 */
function readRawBody(req: Request): Promise<string> {
  const anyReq = req as any;
  if (typeof anyReq.body === "string") return Promise.resolve(anyReq.body);
  if (anyReq.readableEnded) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    let data = "";
    anyReq.setEncoding("utf8");
    anyReq.on("data", (chunk: string) => { data += chunk; });
    anyReq.on("end", () => resolve(data));
    anyReq.on("error", (error: Error) => reject(error));
  });
}

function pickQuery(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? "");
  return value === undefined || value === null ? "" : String(value);
}

/**
 * 企业微信自建应用回调（T-11）
 * URL：/api/channels/wecom/callback
 * 协议：https://developer.work.weixin.qq.com/document/path/90930
 */
@Controller("channels/wecom")
export class WeComChannelsController {
  private readonly logger = new Logger("WeComCallback");

  constructor(
    private readonly config: ChannelsConfig,
    private readonly wecom: WeComService,
    private readonly dispatcher: ChannelDispatcherService,
  ) {}

  /** 回调 URL 验证：echostr 是密文，验签 + 解密后返回明文 echostr */
  @Public()
  @Get("callback")
  verifyUrl(@Query() query: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    res.type("text/plain; charset=utf-8");
    if (!this.config.canHandleWeComCallback()) {
      this.logger.warn("企微回调 URL 验证失败：WECOM_CORP_ID/WECOM_TOKEN/WECOM_AES_KEY 未配置");
      return NOT_CONFIGURED_TEXT;
    }
    return this.wecom.verifyUrl(query);
  }

  /** 接收消息：验签 + AES 解密 + 5 秒内被动回复加密 XML */
  @Public()
  @Post("callback")
  @HttpCode(200)
  async receive(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.type("text/xml; charset=utf-8");
    if (!this.config.canHandleWeComCallback()) {
      this.logger.warn("企微消息回调失败：WECOM_CORP_ID/WECOM_TOKEN/WECOM_AES_KEY 未配置");
      res.type("text/plain; charset=utf-8");
      return NOT_CONFIGURED_TEXT;
    }
    const rawBody = await readRawBody(req);
    const message = this.wecom.decryptInbound(query, rawBody);
    this.wecom.touchCallback();

    const toUser = pickQuery(message.FromUserName);
    const fromUser = pickQuery(message.ToUserName);
    const payload = {
      channel: "wecom" as const,
      fromUser: toUser,
      toUser: fromUser,
      msgType: pickQuery(message.MsgType),
      content: pickQuery(message.Content),
      event: pickQuery(message.Event),
      msgId: pickQuery(message.MsgId),
      agentId: pickQuery(message.AgentID),
    };
    // 企微要求 5 秒内回包，超时会重发同一条消息。
    // 文本消息 + 已配置员工时先回 ACK，建单/回推放后台；幂等由 dispatcher 的 (channel,msgId) 唯一键保证。
    let reply: string;
    if (payload.msgType === "text" && this.config.employeeSlug) {
      void this.dispatcher.handleInbound(payload).catch((error: any) => {
        this.logger.error("处理企微消息失败：" + (error?.message ?? error));
      });
      reply = ACK_TEXT;
    } else {
      reply = await this.dispatcher.handleInbound(payload);
    }
    if (!reply) return "";

    const plainXml = buildPassiveReplyXml(toUser, fromUser, reply);
    return this.wecom.encryptReply(plainXml);
  }

  /** 配置状态（默认受全局 JWT 守卫保护，仅内部/后台可见） */
  @Get("status")
  status() {
    return this.wecom.status();
  }

  /** 内部调用：发送文本应用消息 */
  @Post("send")
  send(@Body() body: any) {
    return this.wecom.send(body);
  }
}

/**
 * 微信公众号（服务号）回调（T-11）
 * URL：/api/channels/wechat-mp/callback
 * 协议：https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Message_encryption_and_decryption_instructions.html
 */
@Controller("channels/wechat-mp")
export class WeChatMpChannelsController {
  private readonly logger = new Logger("WeChatMpCallback");

  constructor(
    private readonly config: ChannelsConfig,
    private readonly wechatMp: WeChatMpService,
    private readonly dispatcher: ChannelDispatcherService,
  ) {}

  /** 服务器地址验证：明文模式原样返回 echostr；安全模式验签后解密再返回 */
  @Public()
  @Get("callback")
  verifyUrl(@Query() query: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    res.type("text/plain; charset=utf-8");
    if (!this.config.canHandleWeChatMpCallback()) {
      this.logger.warn("公众号回调 URL 验证失败：WECHAT_MP_TOKEN 未配置");
      return NOT_CONFIGURED_TEXT;
    }
    return this.wechatMp.verifyUrl(query);
  }

  /** 接收消息：安全模式验签解密；兼容模式下直接走明文签名 */
  @Public()
  @Post("callback")
  @HttpCode(200)
  async receive(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.type("text/xml; charset=utf-8");
    if (!this.config.canHandleWeChatMpCallback()) {
      this.logger.warn("公众号消息回调失败：WECHAT_MP_TOKEN 未配置");
      res.type("text/plain; charset=utf-8");
      return NOT_CONFIGURED_TEXT;
    }
    const rawBody = await readRawBody(req);
    const { msg, secure } = this.wechatMp.decryptInbound(query, rawBody);
    this.wechatMp.touchCallback();

    const toUser = pickQuery(msg.FromUserName);
    const fromUser = pickQuery(msg.ToUserName);
    const payload = {
      channel: "wechat-mp" as const,
      fromUser: toUser,
      toUser: fromUser,
      msgType: pickQuery(msg.MsgType),
      content: pickQuery(msg.Content),
      event: pickQuery(msg.Event),
      msgId: pickQuery(msg.MsgId),
    };
    // 公众号同样有 5 秒被动回复窗口，处理方式与企微一致。
    let reply: string;
    if (payload.msgType === "text" && this.config.employeeSlug) {
      void this.dispatcher.handleInbound(payload).catch((error: any) => {
        this.logger.error("处理公众号消息失败：" + (error?.message ?? error));
      });
      reply = ACK_TEXT;
    } else {
      reply = await this.dispatcher.handleInbound(payload);
    }
    if (!reply) return "";

    const plainXml = buildPassiveReplyXml(toUser, fromUser, reply);
    return secure ? this.wechatMp.encryptReply(plainXml) : plainXml;
  }

  /** 配置状态（默认受全局 JWT 守卫保护） */
  @Get("status")
  status() {
    return this.wechatMp.status();
  }

  /** 内部调用：发送客服文本消息 */
  @Post("send")
  send(@Body() body: any) {
    return this.wechatMp.send(body);
  }
}
