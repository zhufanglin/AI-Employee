import { Module } from "@nestjs/common";
import { StrategyModule } from "../strategy/strategy.module";
import { EmployeeController, EmployeeTaskController, EmployeeCronController, WorkbenchController } from "./employee.controller";
import { EmployeeExecutionController } from "./employee-execution.controller";
import {
  AdminEmployeeOrderController,
  AdminPackagesController,
  AdminRedemptionController,
  EmployeeOrderController,
  PackagesController,
  RedemptionController,
} from "./package.controller";
import { EmployeeOrderService } from "./employee-order.service";
import { PackageService } from "./package.service";
import { EmployeeCronService } from "./employee-cron.service";
import { EmployeeService } from "./employee.service";
import { EmployeeExecutionService } from "./employee-execution.service";
import { EmployeeExpiryService } from "./employee-expiry.service";

@Module({
  imports: [StrategyModule],
  controllers: [
    EmployeeController,
    EmployeeTaskController,
    EmployeeCronController,
    WorkbenchController,
    PackagesController,
    RedemptionController,
    EmployeeOrderController,
    AdminRedemptionController,
    AdminPackagesController,
    AdminEmployeeOrderController,
    EmployeeExecutionController,
  ],
  providers: [
    EmployeeService,
    EmployeeCronService,
    PackageService,
    EmployeeOrderService,
    EmployeeExecutionService,
    EmployeeExpiryService,
  ],
  exports: [EmployeeService, PackageService, EmployeeOrderService, EmployeeExpiryService],
})
export class EmployeeModule {}
