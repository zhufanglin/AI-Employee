import { Module } from "@nestjs/common";
import { AudioMaterialsController } from "./audio-materials.controller";
import { AudioMaterialsService } from "./audio-materials.service";
import { MediaModule } from "../media/media.module";

@Module({ imports: [MediaModule], controllers: [AudioMaterialsController], providers: [AudioMaterialsService] })
export class AudioMaterialsModule {}
