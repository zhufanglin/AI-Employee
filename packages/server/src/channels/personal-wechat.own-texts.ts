import { Injectable } from "@nestjs/common";

/**
 * 个人微信：记录「我们自己发出去的文本」。
 *
 * 为什么需要：默认只处理对方发来的消息（from !== 我）。但自测时常常只有同一个微信号
 * （手机 + 桌面同时登录同一账号，消息在桌面端显示为「我」），这时把
 * WECHAT_PERSONAL_ALLOW_SELF=1 打开，轮询器也会处理「我」发的消息 —— 于是必须能区分
 * 「人手动从手机发的需求」和「机器人自己刚回的 ACK/结果」，否则会无限自问自答。
 *
 * 做法：所有出站路径（轮询器 ACK、调度器结果推送）在发送成功后登记文本，
 * 轮询器看到「我」发的消息若命中登记表就跳过。只保留每个会话最近 MAX 条。
 */
@Injectable()
export class PersonalWeChatOwnTexts {
  private readonly map = new Map<string, string[]>();
  private static readonly MAX = 50;

  record(chat: string, text: string): void {
    const key = String(chat ?? "");
    const value = String(text ?? "");
    if (!key || !value) return;
    const list = this.map.get(key) ?? [];
    list.push(value);
    while (list.length > PersonalWeChatOwnTexts.MAX) list.shift();
    this.map.set(key, list);
  }

  has(chat: string, text: string): boolean {
    const list = this.map.get(String(chat ?? ""));
    if (!list || !list.length) return false;
    return list.includes(String(text ?? ""));
  }

  reset(chat?: string): void {
    if (chat === undefined) this.map.clear();
    else this.map.delete(String(chat));
  }
}
