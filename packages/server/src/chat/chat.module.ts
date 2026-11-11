import { Module } from "@nestjs/common";
import { ChatController } from "./chat.controller";
import { ChatService } from "./chat.service";

/** PrismaService 是全局 provider，这里不需要 imports */
@Module({
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
