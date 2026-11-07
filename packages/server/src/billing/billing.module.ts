import { Global, Module } from "@nestjs/common";
import { PricingService } from "./pricing.service";
import { QuotaService } from "./quota.service";
import { CreditsService } from "./credits.service";

@Global()
@Module({
  providers: [PricingService, QuotaService, CreditsService],
  exports: [PricingService, QuotaService, CreditsService],
})
export class BillingModule {}
