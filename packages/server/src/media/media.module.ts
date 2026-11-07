import { Module } from "@nestjs/common";
import { AdminMediaUsageController, MediaController } from "./media.controller";
import { MediaService } from "./media.service";

@Module({ controllers: [MediaController, AdminMediaUsageController], providers: [MediaService], exports: [MediaService] })
export class MediaModule {}
