import { Module } from "@nestjs/common";
import { OrdersModule } from "../orders/orders.module";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { WechatPayService } from "./wechat-pay.service";

@Module({
  imports: [OrdersModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, WechatPayService],
  exports: [PaymentsService, WechatPayService],
})
export class PaymentsModule {}
