import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ChannelsConfig } from "./channels.config";
import { ChannelDispatcherService } from "./dispatcher.service";
import { PersonalWeChatService } from "./personal-wechat.service";
import { PersonalWeChatOwnTexts } from "./personal-wechat.own-texts";

/**
 * 个人微信入站轮询（T-11 方案 C：家里/办公室常开 Windows + SSH 反向隧道）
 *
 * 链路：微信客户端 → 本机网桥(/api/v1/chat/messages) → 本服务 → ChannelDispatcher
 *       → 员工云端任务 → 结果回推(/api/v1/chat/send) → 微信
 *
 * 为什么是轮询：网桥是「读当前聊天窗口」的 GUI 自动化，没有推送通道；
 * 主动 listen 也需要读窗口，成本相同，所以直接按 WECHAT_PERSONAL_POLL_MS 拉增量。
 *
 * 约束/降级：
 * - WECHAT_UIA_BASE_URL 或 WECHAT_PERSONAL_CHATS 为空 → 完全不启动，不影响 api 启动；
 * - 网桥不可达 / 微信未登录 → 记一条 warn 后继续轮询，不抛异常；
 * - 每条会话记录游标（最后处理的消息 ts + id 集合），只处理游标之后的新消息，
 *   避免重启后把历史消息当成新需求（重启期间的消息会漏，属于接受的取舍）。
 */
@Injectable()
export class PersonalWeChatPoller implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("PersonalWeChatPoller");
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** chat → 已处理到的秒级时间戳 */
  private readonly cursors = new Map<string, number>();
  /** chat → 已处理的消息 id（防同一秒内多条消息漏处理/重复处理） */
  private readonly seen = new Map<string, Set<string>>();
  /** chat → 正在处理（串行化，避免同一会话并发触发多个任务） */
  private readonly busy = new Set<string>();

  constructor(
    private readonly config: ChannelsConfig,
    private readonly bridge: PersonalWeChatService,
    private readonly dispatcher: ChannelDispatcherService,
    private readonly ownTexts?: PersonalWeChatOwnTexts,
  ) {}

  onModuleInit(): void {
    if (!this.config.isPersonalWeChatConfigured()) {
      this.logger.log("个人微信自动接管未启用（缺少 WECHAT_UIA_BASE_URL 或 WECHAT_PERSONAL_CHATS）");
      return;
    }
    const chats = this.config.personalChats;
    const now = Math.floor(Date.now() / 1000);
    for (const chat of chats) {
      this.cursors.set(chat, now);
      this.seen.set(chat, new Set<string>());
    }
    this.logger.log(
      "个人微信自动接管已启用：chats=" + chats.join(",") + " pollMs=" + this.config.personalPollMs +
        (this.config.personalAllowSelf ? " allowSelf=true（自测模式：会处理「我」发的消息）" : ""),
    );
    void this.registerListen(chats);
    this.timer = setInterval(() => void this.tick(), this.config.personalPollMs);
    if (typeof (this.timer as any).unref === "function") (this.timer as any).unref();
    // 首轮稍等，避免和服务启动抢资源
    setTimeout(() => void this.tick(), 5000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 让网桥对这些会话注册监听（不注册也能读，但注册后网桥侧会缓存新消息） */
  private async registerListen(chats: string[]) {
    for (const chat of chats) {
      try {
        await this.bridge.listen(undefined, chat);
        this.logger.log("网桥监听已注册：" + chat);
      } catch (error: any) {
        this.logger.warn("网桥监听注册失败 " + chat + "：" + (error?.message ?? error));
      }
    }
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const chat of this.config.personalChats) {
        if (this.busy.has(chat)) continue;
        this.busy.add(chat);
        try {
          await this.pollChat(chat);
        } finally {
          this.busy.delete(chat);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async pollChat(chat: string) {
    let items: any[] = [];
    try {
      const body: any = await this.bridge.messages(chat);
      items = Array.isArray(body?.items) ? body.items : [];
    } catch (error: any) {
      // 网桥不可达 / 微信未登录：静默降级，只记 warn（别每分钟刷 error）
      this.logger.warn("读取会话失败 " + chat + "：" + (error?.message ?? error));
      return;
    }

    const cursor = this.cursors.get(chat) ?? 0;
    const seen = this.seen.get(chat) ?? new Set<string>();
    this.seen.set(chat, seen);

    const fresh = items
      .filter((item) => {
        const ts = Number(item?.ts ?? 0);
        const id = String(item?.id ?? "");
        if (!id) return false;
        if (ts < cursor) return false;
        if (ts === cursor && seen.has(id)) return false;
        if (seen.has(id)) return false;
        // 自己发出去的不算需求（含 just-sent 的回推），系统提示也不算
        const from = String(item?.from ?? "");
        if (from === "系统") return false;
        if (from === "我") {
          // 默认严格忽略；只有自测模式（WECHAT_PERSONAL_ALLOW_SELF=1）才处理，
          // 且必须排除机器人自己发出的 ACK/结果，否则会自问自答
          if (!this.config.personalAllowSelf) return false;
          const text = String(item?.text ?? "").trim();
          if (this.ownTexts?.has(chat, text)) return false;
        }
        return true;
      })
      .sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));

    for (const item of fresh) {
      const ts = Number(item.ts ?? 0);
      const id = String(item.id);
      seen.add(id);
      this.cursors.set(chat, Math.max(cursor, ts));
      const text = String(item.text ?? "").trim();
      const msgType = String(item.type ?? "text");
      if (!text) continue;
      if (msgType !== "text") {
        // 图片/文件等：只回一句提示，不建任务（第一版不支持多模态渠道）
        const hint = "目前只支持文字需求，图片/文件请描述一下内容。";
        try {
          await this.bridge.send(chat, hint);
          this.ownTexts?.record(chat, hint);
        } catch (error: any) {
          this.logger.warn("非文本提示回推失败 " + chat + "：" + (error?.message ?? error));
        }
        continue;
      }
      try {
        const reply = await this.dispatcher.handleInbound({
          channel: "personal-wechat",
          fromUser: chat,
          msgType: "text",
          content: text,
          msgId: id,
        });
        if (reply) {
          await this.bridge.send(chat, reply);
          this.ownTexts?.record(chat, reply);
        }
        this.logger.log("个人微信入站已处理 chat=" + chat + " msgId=" + id + " chars=" + text.length);
      } catch (error: any) {
        this.logger.warn("处理入站消息失败 " + chat + " msgId=" + id + "：" + (error?.message ?? error));
      }
    }
    // 游标只增不减；内存里保留最近 500 个 id
    if (seen.size > 500) {
      const keep = Array.from(seen).slice(-500);
      this.seen.set(chat, new Set(keep));
    }
  }
}
