import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EmployeeService } from "../employee/employee.service";
import { ChannelsConfig } from "./channels.config";
import { PersonalWeChatService } from "./personal-wechat.service";
import { PersonalWeChatOwnTexts } from "./personal-wechat.own-texts";
import { WeComService } from "./wecom/wecom.service";
import { WeChatMpService } from "./wechat-mp/wechat-mp.service";

export type ChannelKind = "wecom" | "wechat-mp" | "personal-wechat";

export interface InboundMessage {
  channel: ChannelKind;
  /** 企微：成员 UserID；公众号：用户 OpenID；个人微信：会话（昵称/备注名） */
  fromUser: string;
  /** 企微应用 AgentID（可选，仅日志用） */
  agentId?: string;
  toUser?: string;
  msgType?: string;
  content?: string;
  event?: string;
  msgId?: string;
}

/** 5 秒内先回这句话，结果异步推送（需求 T-11） */
export const ACK_TEXT = "已收到，正在处理，稍后把结果发给你";
/** 凭证/员工未配置时的统一回复 */
export const NOT_CONFIGURED_TEXT = "渠道未配置";
/** 无法绑定平台账号时的降级回复 */
export const DEGRADED_ACK_TEXT = "已收到";

/** 企微文本消息 content 上限 2048 字节，中文按 3 字节算，保守截到 600 字 */
const WECOM_PUSH_MAX_CHARS = 600;
/** 公众号客服文本消息上限 2048 字 */
const WECHAT_MP_PUSH_MAX_CHARS = 1800;
/** 个人微信（桌面客户端）单条文本保守上限 */
const PERSONAL_PUSH_MAX_CHARS = 1500;

function truncate(text: string, maxChars: number): string {
  const raw = String(text ?? "");
  if (raw.length <= maxChars) return raw;
  return raw.slice(0, maxChars) + "\n……（内容过长已截断，完整结果请在平台后台查看）";
}

/**
 * 渠道消息调度器：渠道回调 → 员工云端任务 → 任务结果主动推送。
 *
 * 第一版轮询，后续换事件：
 * 现有执行链路（EmployeeService / EmployeeExecutionService）没有「任务完成事件」，
 * 所以这里用 setInterval 轮询 employeeTask 状态（默认 5 秒、最多 10 分钟）；
 * 以后接入事件总线 / Redis 队列后，把 watchTask() 换成事件订阅即可，接口保持不变。
 */
@Injectable()
export class ChannelDispatcherService {
  private readonly logger = new Logger("ChannelDispatcher");
  /** taskId → 轮询定时器，避免同一任务重复轮询 / 进程退出时残留 */
  private readonly watchers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly config: ChannelsConfig,
    private readonly prisma: PrismaService,
    private readonly employees: EmployeeService,
    private readonly wecom: WeComService,
    private readonly wechatMp: WeChatMpService,
    private readonly personal: PersonalWeChatService,
    private readonly personalOwnTexts?: PersonalWeChatOwnTexts,
  ) {}

  /**
   * 处理一条入站消息，返回「5 秒内被动回复」的文本；没有回复内容时返回空串。
   */
  async handleInbound(msg: InboundMessage): Promise<string> {
    const slug = this.config.employeeSlug;
    if (!slug) {
      this.logger.warn("CHANNEL_EMPLOYEE_SLUG 为空，渠道未接入任何 AI 员工：" + msg.channel + " from=" + msg.fromUser);
      return NOT_CONFIGURED_TEXT;
    }
    if (!msg.fromUser) return "";

    if (msg.msgType !== "text") {
      if (msg.msgType === "event") return this.handleEvent(msg);
      return "目前只支持文本消息，请直接用文字描述你的需求。";
    }

    const content = String(msg.content ?? "").trim();
    if (!content) return "请发送具体需求，例如：帮我看下今天 AI 行业有什么新政策。";

    const userId = await this.resolveUserId(msg);
    if (!userId) {
      // 需求 T-11 第 5 条：接口需要 userId 绑定时不硬改员工链路，降级为只回「已收到」+ 留 TODO
      this.logger.warn(
        "[TODO] 渠道用户尚未绑定平台账号，已降级为仅回复「已收到」。channel=" + msg.channel +
        " from=" + msg.fromUser +
        "；补 CHANNEL_OWNER_USER_ID 或建立渠道用户映射后即可创建云端任务。",
      );
      return DEGRADED_ACK_TEXT;
    }

    try {
      const task: any = await this.employees.run(userId, slug, {
        executor: "cloud",
        title: "[" + msg.channel + "] " + content.slice(0, 40),
        input: {
          channel: msg.channel,
          from: msg.fromUser,
          content,
          msgId: msg.msgId ?? null,
          agentId: msg.agentId ?? null,
        },
      });
      this.logger.log("渠道任务已创建 task=" + task.id + " channel=" + msg.channel + " from=" + msg.fromUser + " employee=" + slug);
      this.watchTask(task.id, msg);
      return ACK_TEXT;
    } catch (error: any) {
      // 员工未安装 / 未购买 / 账号异常等：同样降级，但不能把 500 抛回微信（会被反复重试）
      this.logger.warn(
        "创建员工任务失败，降级为仅回复「已收到」：channel=" + msg.channel +
        " from=" + msg.fromUser + " reason=" + (error?.message ?? error),
      );
      return DEGRADED_ACK_TEXT;
    }
  }

  private handleEvent(msg: InboundMessage): string {
    const event = String(msg.event ?? "").toLowerCase();
    if (event === "subscribe") return "欢迎使用 AI 员工，直接发送你的需求即可。";
    if (event === "unsubscribe") return "";
    if (event === "enter_agent") return "AI 员工已就绪，直接发送你的需求即可。";
    return "";
  }

  /**
   * 渠道用户 → 平台 userId
   * 1. 显式配置 CHANNEL_OWNER_USER_ID 时直接用它（便于灰度 / 测试）；
   * 2. 公众号可按 wechatOpenId 反查已绑定的平台用户（User.wechatOpenId 是现有字段，不改库）；
   * 3. 企微没有 wecom userid 字段，未配置时返回 null → 走降级。
   */
  private async resolveUserId(msg: InboundMessage): Promise<string | null> {
    const owner = this.config.ownerUserId;
    if (owner) return owner;
    if (msg.channel === "wechat-mp" && msg.fromUser) {
      const user = await this.prisma.user.findUnique({ where: { wechatOpenId: msg.fromUser }, select: { id: true } });
      if (user?.id) return user.id;
    }
    return null;
  }

  /** 第一版轮询，后续换事件 */
  private watchTask(taskId: string, msg: InboundMessage) {
    if (this.watchers.has(taskId)) return;
    const deadline = Date.now() + this.config.taskTimeoutMs;
    const timer = setInterval(() => {
      void this.pollTask(taskId, msg, deadline).catch((error: any) => {
        this.logger.error("轮询渠道任务失败 task=" + taskId + "：" + (error?.message ?? error));
      });
    }, this.config.taskPollMs);
    // 不要让后台轮询阻止进程退出（进程常驻时行为不变）
    if (typeof (timer as any).unref === "function") (timer as any).unref();
    this.watchers.set(taskId, timer);
  }

  private stopWatch(taskId: string) {
    const timer = this.watchers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.watchers.delete(taskId);
    }
  }

  private async pollTask(taskId: string, msg: InboundMessage, deadline: number) {
    if (Date.now() > deadline) {
      this.stopWatch(taskId);
      const minutes = Math.round(this.config.taskTimeoutMs / 60_000);
      await this.push(msg, "任务处理超时（超过 " + minutes + " 分钟），请稍后在平台后台查看结果。");
      return;
    }
    const task: any = await this.prisma.employeeTask.findUnique({ where: { id: taskId } });
    if (!task) {
      this.stopWatch(taskId);
      return;
    }
    if (task.status === "succeeded") {
      this.stopWatch(taskId);
      const text = await this.readTaskText(taskId, task);
      await this.push(msg, text ? "任务已完成：\n" + text : "任务已完成，但没有产出文本结果。");
      return;
    }
    if (task.status === "failed") {
      this.stopWatch(taskId);
      const reason = typeof task.error === "string" && task.error.trim() ? task.error.trim() : "未知原因";
      await this.push(msg, "任务处理失败：" + reason);
      return;
    }
    if (task.status === "needs_input" || task.status === "awaiting_approval") {
      // 需要人工介入的任务不再继续轮询，避免占着定时器；
      // 但云执行器的产出停在 outputText 里，渠道用户拿不到后台，所以先把已产出的文本推过去。
      this.stopWatch(taskId);
      const text = await this.readTaskText(taskId, task);
      if (!text) {
        await this.push(msg, "任务需要你补充信息或在后台确认，请登录平台后台处理。");
        return;
      }
      const suffix =
        task.status === "needs_input"
          ? "\n（还需要你补充信息才能继续，直接回复补充内容即可）"
          : "\n（以上为初稿，确认归档请登录平台后台）";
      await this.push(msg, text + suffix);
    }
  }

  /** 读任务产出文本：先取 outputText，空则取第一个 artifact 的文本 */
  private async readTaskText(taskId: string, task: any): Promise<string> {
    const direct = typeof task?.outputText === "string" ? task.outputText.trim() : "";
    if (direct) return direct;
    const artifact = await this.prisma.employeeTaskArtifact.findFirst({
      where: { taskId },
      orderBy: { createdAt: "asc" },
    });
    return typeof artifact?.text === "string" ? artifact.text.trim() : "";
  }

  /** 任务结果主动推送（企微应用消息 / 公众号客服消息） */
  private async push(msg: InboundMessage, content: string) {
    const maxChars =
      msg.channel === "wecom"
        ? WECOM_PUSH_MAX_CHARS
        : msg.channel === "personal-wechat"
          ? PERSONAL_PUSH_MAX_CHARS
          : WECHAT_MP_PUSH_MAX_CHARS;
    const text = truncate(content, maxChars);
    try {
      if (msg.channel === "wecom") await this.wecom.sendText(msg.fromUser, text);
      else if (msg.channel === "personal-wechat") {
        await this.personal.send(msg.fromUser, text);
        // 登记「我们自己发的」，供 WECHAT_PERSONAL_ALLOW_SELF 自测模式排除自问自答
        this.personalOwnTexts?.record(msg.fromUser, text);
      }
      else await this.wechatMp.sendText(msg.fromUser, text);
      this.logger.log("渠道结果已推送 channel=" + msg.channel + " to=" + msg.fromUser);
    } catch (error: any) {
      this.logger.error("渠道结果推送失败 channel=" + msg.channel + " to=" + msg.fromUser + "：" + (error?.message ?? error));
    }
  }
}
