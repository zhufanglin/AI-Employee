import { Module } from "@nestjs/common";
import { ComposeVideosController } from "./compose-videos.controller";
import { ComposeVideosService } from "./compose-videos.service";
import { MediaModule } from "../media/media.module";

@Module({ imports: [MediaModule], controllers: [ComposeVideosController], providers: [ComposeVideosService] })
export class ComposeVideosModule {}
