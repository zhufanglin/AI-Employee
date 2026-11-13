import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./auth/auth.module";
import { HealthController } from "./health/health.controller";
import { SiteModule } from "./site/site.module";
import { JwtAuthGuard } from "./common/jwt-auth.guard";
import { RolesGuard } from "./common/roles.guard";
import { JwtModule } from "@nestjs/jwt";
import { JWT_SECRET } from "./common/env";
import { BillingModule } from "./billing/billing.module";
import { ProvidersModule } from "./providers/providers.module";
import { ComputeModule } from "./compute/compute.module";
import { CreditsModule } from "./credits/credits.module";
import { EmployeeModule } from "./employee/employee.module";
import { ToolapiModule } from "./toolapi/toolapi.module";
import { MediaModule } from "./media/media.module";
import { ChannelsModule } from "./channels/channels.module";
import { ComposeVideosModule } from "./compose-videos/compose-videos.module";
import { CloneRecordsModule } from "./clone-records/clone-records.module";
import { AudioMaterialsModule } from "./audio-materials/audio-materials.module";
import { TimelineModule } from "./timeline/timeline.module";
import { PaymentsModule } from "./payments/payments.module";
import { AdminModule } from "./admin/admin.module";
import { CapabilityModule } from "./capabilities/capability.module";
import { WorkspaceModule } from "./workspace/workspace.module";
import { MemoryModule } from "./memory/memory.module";
import { StrategyModule } from "./strategy/strategy.module";
import { ChatModule } from "./chat/chat.module";
import { LegalModule } from "./legal/legal.module";

@Module({
  imports: [
    JwtModule.register({ global: true, secret: JWT_SECRET() }),
    PrismaModule,
    BillingModule,
    ProvidersModule,
    AuthModule,
    SiteModule,
    ComputeModule,
    CreditsModule,
    EmployeeModule,
    ToolapiModule,
    MediaModule,
    ChannelsModule,
    ComposeVideosModule, CloneRecordsModule, AudioMaterialsModule, TimelineModule,
    PaymentsModule,
    AdminModule,
    CapabilityModule,
    WorkspaceModule,
    MemoryModule,
    StrategyModule,
    ChatModule,
    LegalModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
