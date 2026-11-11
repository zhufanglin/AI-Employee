import { Module } from "@nestjs/common";
import { EmployeeModule } from "../employee/employee.module";
import { OrdersModule } from "../orders/orders.module";
import { EmployeeOrderPayController, PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { WechatPayService } from "./wechat-pay.service";

@Module({
  // 员工订单支付/回调开通需要 EmployeeOrderService；EmployeeModule 不反向依赖 payments，避免循环
  imports: [OrdersModule, EmployeeModule],
  controllers: [PaymentsController, EmployeeOrderPayController],
  providers: [PaymentsService, WechatPayService],
  exports: [PaymentsService, WechatPayService],
})
export class PaymentsModule {}
