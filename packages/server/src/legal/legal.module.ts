import { Module } from "@nestjs/common";
import { LegalController } from "./legal.controller";
import { ReportAdminController } from "./report-admin.controller";
import { ReportService } from "./report.service";

// PrismaModule 是 @Global，无需 import。
@Module({
  controllers: [LegalController, ReportAdminController],
  providers: [ReportService],
  exports: [ReportService],
})
export class LegalModule {}
