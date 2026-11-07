import { Module } from "@nestjs/common";
import { ComputeModule } from "../compute/compute.module";
import { ToolapiController } from "./toolapi.controller";
import { ToolapiService } from "./toolapi.service";

@Module({
  imports: [ComputeModule],
  controllers: [ToolapiController],
  providers: [ToolapiService],
  exports: [ToolapiService],
})
export class ToolapiModule {}
