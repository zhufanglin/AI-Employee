import { BadGatewayException, BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { env } from "../common/env";

@Injectable()
export class PersonalWeChatService {
  private async call(path: string, init: RequestInit = {}) {
    const base = env("WECHAT_UIA_BASE_URL", "").replace(/\/$/, "");
    if (!base) throw new ServiceUnavailableException({ code: "WECHAT_UIA_NOT_CONFIGURED", message: "个人微信 UIAutomation 未配置" });
    const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as any) };
    const token = env("WECHAT_UIA_TOKEN", "");
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${base}${path}`, { ...init, headers });
    const text = await response.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) throw new BadGatewayException({ code: "WECHAT_UIA_UPSTREAM_ERROR", status: response.status, detail: body });
    return body;
  }

  status() { return this.call("/api/v1/bot/status", { method: "GET" }); }
  contacts() { return this.call("/api/v1/memory/list", { method: "GET" }); }
  messages(chatName: string, wxId?: string) {
    if (!chatName) throw new BadRequestException({ code: "WECHAT_UIA_CHAT_NAME_REQUIRED", message: "chat_name 不能为空" });
    const query = new URLSearchParams({ chat_name: chatName });
    if (wxId) query.set("wx_id", wxId);
    return this.call(`/api/v1/chat/messages?${query.toString()}`, { method: "GET" });
  }
  send(name: string, msg: string, humanize = false) {
    if (!name) throw new BadRequestException({ code: "WECHAT_UIA_NAME_REQUIRED", message: "name 不能为空" });
    if (!msg) throw new BadRequestException({ code: "WECHAT_UIA_MESSAGE_REQUIRED", message: "msg 不能为空" });
    return this.call("/api/v1/chat/send", { method: "POST", body: JSON.stringify({ name, msg, humanize }) });
  }
  sendFile(name: string, filePath?: string, fileUrl?: string, humanize = false) {
    if (!name) throw new BadRequestException({ code: "WECHAT_UIA_NAME_REQUIRED", message: "name 不能为空" });
    if (!filePath && !fileUrl) throw new BadRequestException({ code: "WECHAT_UIA_FILE_REQUIRED", message: "缺少 file_path 或 file_url" });
    return this.call("/api/v1/chat/send-file", { method: "POST", body: JSON.stringify({ name, file_path: filePath, file_url: fileUrl, humanize }) });
  }
  listen(wxId?: string, nickname?: string) {
    if (!wxId && !nickname) throw new BadRequestException({ code: "WECHAT_UIA_TARGET_REQUIRED", message: "wxid 或 nickname 至少填写一项" });
    return this.call("/api/v1/chat/listen-list", { method: "POST", body: JSON.stringify({ wxid: wxId, nickname }) });
  }
}
