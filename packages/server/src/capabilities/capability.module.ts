import { Module } from "@nestjs/common";
import { ToolapiModule } from "../toolapi/toolapi.module";
import { CapabilityController } from "./capability.controller";
import { CapabilityService } from "./capability.service";
import { MemoryCleanupService } from "./memory-cleanup.service";

@Module({
  imports: [ToolapiModule],
  controllers: [CapabilityController],
  providers: [CapabilityService, MemoryCleanupService],
  exports: [CapabilityService, MemoryCleanupService],
})
export class CapabilityModule {}
