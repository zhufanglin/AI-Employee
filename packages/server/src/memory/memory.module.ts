import { Module } from "@nestjs/common";
import { CapabilityModule } from "../capabilities/capability.module";
import { MemoryController } from "./memory.controller";
import { MemoryService } from "./memory.service";

/** PrismaService / ProvidersService 是全局 provider，这里只需拿 CapabilityService */
@Module({
  imports: [CapabilityModule],
  controllers: [MemoryController],
  providers: [MemoryService],
})
export class MemoryModule {}
