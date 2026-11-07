import { Injectable } from "@nestjs/common";
import { env, envInt } from "../common/env";

/**
 * 渠道配置（企微 / 公众号）
 *
 * 设计约束：所有字段都按需从 env 读取，缺失时只让对应功能降级，
 * 绝不在模块初始化阶段抛异常 —— 因此 ChannelsModule 在没有任何渠道凭证时也能正常启动。
 *
 * env 清单（均为可选）：
 * - WECOM_CORP_ID / WECOM_AGENT_ID / WECOM_SECRET / WECOM_TOKEN / WECOM_AES_KEY
 * - WECHAT_MP_APP_ID / WECHAT_MP_APP_SECRET / WECHAT_MP_TOKEN / WECHAT_MP_AES_KEY
 * - CHANNEL_EMPLOYEE_SLUG（默认 boss-lead-radar，显式置空表示不接员工）
 * - CHANNEL_OWNER_USER_ID（可选：渠道消息默认落到哪个平台账号；公众号还会按 wechatOpenId 反查）
 */

export interface WeComConfig {
  corpid: string;
  agentId: string;
  secret: string;
  token: string;
  aesKey: string;
}

export interface WeChatMpConfig {
  appId: string;
  appSecret: string;
  token: string;
  aesKey: string;
}

@Injectable()
export class ChannelsConfig {
  get wecom(): WeComConfig {
    return {
      corpid: env("WECOM_CORP_ID", "").trim(),
      agentId: env("WECOM_AGENT_ID", "").trim(),
      secret: env("WECOM_SECRET", "").trim(),
      token: env("WECOM_TOKEN", "").trim(),
      aesKey: env("WECOM_AES_KEY", "").trim(),
    };
  }

  get wechatMp(): WeChatMpConfig {
    return {
      appId: env("WECHAT_MP_APP_ID", "").trim(),
      appSecret: env("WECHAT_MP_APP_SECRET", "").trim(),
      token: env("WECHAT_MP_TOKEN", "").trim(),
      aesKey: env("WECHAT_MP_AES_KEY", "").trim(),
    };
  }

  /** 渠道消息路由到的 AI 员工 slug；显式置空视为「未配置员工」 */
  get employeeSlug(): string {
    return env("CHANNEL_EMPLOYEE_SLUG", "boss-lead-radar").trim();
  }

  /** 可选：渠道消息默认归属的平台用户 id（没有 openid 绑定时的兜底） */
  get ownerUserId(): string {
    return env("CHANNEL_OWNER_USER_ID", "").trim();
  }

  /**
   * 个人微信：要自动接管（读消息 → 建员工任务 → 回推结果）的会话列表。
   * 逗号分隔的微信昵称/备注名，例如：WECHAT_PERSONAL_CHATS=文件传输助手,客户A
   * 为空表示不做自动接管（只保留手动 send/messages 接口）。
   */
  get personalChats(): string[] {
    return env("WECHAT_PERSONAL_CHATS", "")
      .split(/[,，;；\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** 个人微信入站轮询间隔（默认 20 秒；网桥读会话会切窗口，不宜太密） */
  get personalPollMs(): number {
    return Math.max(5000, envInt("WECHAT_PERSONAL_POLL_MS", 20_000));
  }

  /**
   * 自测开关：允许处理「我」发出的消息（默认关闭）。
   *
   * 场景：只有一个微信号时（手机 + 桌面同账号），对方视角的消息在桌面端也是「我」，
   * 打开后可手动从手机发一条需求验证全链路。机器人自己发出的 ACK/结果会被
   * PersonalWeChatOwnTexts 登记并跳过，不会自问自答。生产接真实客户时保持关闭。
   */
  get personalAllowSelf(): boolean {
    return env("WECHAT_PERSONAL_ALLOW_SELF", "").trim() === "1";
  }

  /** 个人微信自动接管是否可用（网桥地址 + 至少一个会话） */
  isPersonalWeChatConfigured(): boolean {
    return Boolean(env("WECHAT_UIA_BASE_URL", "").trim() && this.personalChats.length);
  }

  /** 任务状态轮询间隔（第一版轮询方案，默认 5 秒） */
  get taskPollMs(): number {
    return Math.max(1000, envInt("CHANNEL_TASK_POLL_MS", 5000));
  }

  /** 任务轮询上限（默认 10 分钟） */
  get taskTimeoutMs(): number {
    return Math.max(10_000, envInt("CHANNEL_TASK_TIMEOUT_MS", 600_000));
  }

  /** 企微是否具备「主动发消息」能力 */
  isWeComConfigured(): boolean {
    const c = this.wecom;
    return Boolean(c.corpid && c.agentId && c.secret);
  }

  /** 企微是否具备「回调验签/解密」能力（URL 验证 + 收消息） */
  canHandleWeComCallback(): boolean {
    const c = this.wecom;
    return Boolean(c.corpid && c.token && c.aesKey);
  }

  /** 公众号是否具备「主动发客服消息」能力 */
  isWeChatMpConfigured(): boolean {
    const c = this.wechatMp;
    return Boolean(c.appId && c.appSecret);
  }

  /** 公众号是否具备「回调验签」能力（安全模式还需 aesKey + appId，见服务内判断） */
  canHandleWeChatMpCallback(): boolean {
    return Boolean(this.wechatMp.token);
  }

  /** 脱敏展示：只保留前 2 位与后 2 位 */
  mask(value: string): string | null {
    const raw = String(value ?? "");
    if (!raw) return null;
    if (raw.length <= 4) return "****";
    return raw.slice(0, 2) + "****" + raw.slice(-2);
  }
}
