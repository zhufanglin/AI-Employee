import { Module } from "@nestjs/common";
import { StrategyController } from "./strategy.controller";
import { PersonaController } from "./persona.controller";
import { StrategyService } from "./strategy.service";

/** PrismaService 是全局 provider，这里只声明自身 controller/service。 */
@Module({
  controllers: [StrategyController, PersonaController],
  providers: [StrategyService],
  exports: [StrategyService],
})
export class StrategyModule {}
