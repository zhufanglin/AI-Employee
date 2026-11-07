import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { CloneRecordsService } from "./clone-records.service";

@Controller("clone-records")
export class CloneRecordsController {
  constructor(private readonly service: CloneRecordsService) {}

  @Post()
  create(@Req() req: any, @Body() body: any) {
    return this.service.create(req.user, body);
  }

  @Get()
  list(@Req() req: any, @Query() query: any) {
    return this.service.list(req.user, query);
  }

  @Patch(":id")
  update(@Req() req: any, @Param("id") id: string, @Body() body: any) {
    return this.service.update(req.user, id, body);
  }

  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.service.remove(req.user, id);
  }
}
