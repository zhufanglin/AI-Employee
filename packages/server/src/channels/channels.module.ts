import { Module } from "@nestjs/common";
import { EmployeeModule } from "../employee/employee.module";
import { ChannelsConfig } from "./channels.config";
import { ChannelsController, WeChatMpChannelsController, WeComChannelsController } from "./channels.controller";
import { ChannelDispatcherService } from "./dispatcher.service";
import { PersonalWeChatPoller } from "./personal-wechat.poller";
import { PersonalWeChatOwnTexts } from "./personal-wechat.own-texts";
import { PersonalWeChatService } from "./personal-wechat.service";
import { WeChatMpService } from "./wechat-mp/wechat-mp.service";
import { WeComService } from "./wecom/wecom.service";

/**
 * 渠道模块（T-11）
 * - ChannelDispatcherService 需要 EmployeeService 创建云端任务，因此 import EmployeeModule（它 export 了 EmployeeService）
 * - PrismaModule 是 @Global，PrismaService 无需在此 import
 * - 所有渠道凭证都是懒读取：缺配置时仅 status 显示未配置、回调返回「渠道未配置」，不影响启动
 */
@Module({
  imports: [EmployeeModule],
  controllers: [ChannelsController, WeComChannelsController, WeChatMpChannelsController],
  providers: [
    PersonalWeChatService,
    ChannelsConfig,
    WeComService,
    WeChatMpService,
    ChannelDispatcherService,
    PersonalWeChatOwnTexts,
    PersonalWeChatPoller,
  ],
})
export class ChannelsModule {}
