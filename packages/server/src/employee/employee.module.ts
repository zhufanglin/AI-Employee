import { Module } from "@nestjs/common";
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

@Module({
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
  providers: [EmployeeService, EmployeeCronService, PackageService, EmployeeOrderService, EmployeeExecutionService],
  exports: [EmployeeService, PackageService, EmployeeOrderService],
})
export class EmployeeModule {}
