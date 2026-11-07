import { Global, Module } from "@nestjs/common";
import { ProvidersService } from "./providers.service";

@Global()
@Module({
  providers: [ProvidersService],
  exports: [ProvidersService],
})
export class ProvidersModule {}
