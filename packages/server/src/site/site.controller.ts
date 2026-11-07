import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Public } from "../common/decorators";
import { SiteService } from "./site.service";

@ApiTags("site")
@Controller("site")
export class SiteController {
  constructor(private readonly site: SiteService) {}

  @Public()
  @Get("config")
  config() {
    return this.site.publicConfig();
  }
}
