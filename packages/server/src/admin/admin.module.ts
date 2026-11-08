import { Module } from "@nestjs/common";
import { CapabilityModule } from "../capabilities/capability.module";
import { EmployeeModule } from "../employee/employee.module";
import { OrdersModule } from "../orders/orders.module";
import { AdminExtraController } from "./admin-extra.controller";
import { AdminExtraService } from "./admin-extra.service";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";

@Module({
  imports: [OrdersModule, EmployeeModule, CapabilityModule],
  controllers: [AdminController, AdminExtraController],
  providers: [AdminService, AdminExtraService],
})
export class AdminModule {}
