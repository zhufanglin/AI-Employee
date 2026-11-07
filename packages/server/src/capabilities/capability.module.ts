import { Module } from "@nestjs/common";
import { ToolapiModule } from "../toolapi/toolapi.module";
import { CapabilityController } from "./capability.controller";
import { CapabilityService } from "./capability.service";

@Module({
  imports: [ToolapiModule],
  controllers: [CapabilityController],
  providers: [CapabilityService],
  exports: [CapabilityService],
})
export class CapabilityModule {}
