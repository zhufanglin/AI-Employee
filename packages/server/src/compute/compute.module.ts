import { Module } from "@nestjs/common";
import { ComputeController } from "./compute.controller";
import { ComputeService } from "./compute.service";
import { ComputeAuthGuard } from "./compute-auth.guard";
import { ProxyTokenService } from "./proxy-token.service";
import { ProxyTokenController } from "./proxy-token.controller";
import { VolcengineProxyController } from "./volcengine-proxy.controller";

@Module({
  controllers: [ComputeController, ProxyTokenController, VolcengineProxyController],
  providers: [ComputeService, ComputeAuthGuard, ProxyTokenService],
  exports: [ProxyTokenService, ComputeService],
})
export class ComputeModule {}
