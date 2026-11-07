import { Controller, Get, Query, Req } from "@nestjs/common";
import { CreditsService } from "../billing/credits.service";

@Controller("credits")
export class CreditsController {
  constructor(private credits: CreditsService) {}

  @Get("balance")
  async balance(@Req() req: any) {
    return this.credits.getBalance(req.user.id);
  }

  @Get("transactions")
  async transactions(@Req() req: any, @Query() query: any) {
    return this.credits.getTransactions(req.user.id, query);
  }

  @Get("ai-usage-records")
  async usageRecords(@Req() req: any, @Query() query: any) {
    return this.credits.getAiUsageRecords(req.user.id, query);
  }

  @Get("ai-usage-stats")
  async usageStats(@Req() req: any, @Query() query: any) {
    return this.credits.getUserAiUsageStats(req.user.id, query);
  }
}
