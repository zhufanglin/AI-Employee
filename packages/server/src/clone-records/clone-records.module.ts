import { Module } from "@nestjs/common";
import { CloneRecordsController } from "./clone-records.controller";
import { CloneRecordsService } from "./clone-records.service";
import { MediaModule } from "../media/media.module";

@Module({ imports: [MediaModule], controllers: [CloneRecordsController], providers: [CloneRecordsService] })
export class CloneRecordsModule {}
