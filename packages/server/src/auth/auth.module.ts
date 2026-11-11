import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AdminLoginAliasController, AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { SmsSender } from "./sms.sender";
import { JWT_SECRET } from "../common/env";

@Module({
  imports: [
    JwtModule.register({
      secret: JWT_SECRET(),
      signOptions: { expiresIn: "7d" },
    }),
  ],
  controllers: [AuthController, AdminLoginAliasController],
  providers: [AuthService, SmsSender],
  exports: [AuthService, SmsSender],
})
export class AuthModule {}
