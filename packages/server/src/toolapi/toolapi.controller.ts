import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from "@nestjs/common";
import { ToolapiService } from "./toolapi.service";

@Controller("toolapi")
export class ToolapiController {
  constructor(private readonly service: ToolapiService) {}
  private phone(req: any, body?: any, query?: any) { const phone = req.user?.phone; if (!phone) throw new BadRequestException("当前账户没有绑定手机号"); if (body?.phone && body.phone !== phone) throw new BadRequestException("只能操作当前账户的数据"); if (query?.phone && query.phone !== phone) throw new BadRequestException("只能操作当前账户的数据"); return phone; }
  @Post("content") createContent(@Req() r: any, @Body() b: any) { return this.service.createContent({ ...b, phone: this.phone(r, b) }).then(data => ({ success: true, data })); }
  @Get("content") queryContent(@Req() r: any, @Query() q: any) { return this.service.queryContent({ ...q, phone: this.phone(r, undefined, q) }).then(data => ({ success: true, data })); }
  @Put("content/:id") updateContent(@Req() r: any, @Param("id") id: string, @Body() b: any) { const phone = this.phone(r, b); return this.service.updateContent(id, phone, b).then(data => ({ success: true, data })); }
  @Delete("content/:id") deleteContent(@Req() r: any, @Param("id") id: string, @Query("phone") p?: string) { const phone = this.phone(r, undefined, p ? { phone: p } : undefined); return this.service.deleteContent(id, phone); }
  @Post("morning-report") morning(@Req() r: any) { return this.service.generateMorningReport(this.phone(r)).then(content => ({ success: true, data: { content } })); }
  @Post("poster") poster() { return this.service.generatePoster("", ""); }
  @Post("daily-distribution") distribution(@Req() r: any) { return this.service.generateDailyDistribution(this.phone(r)).then(data => ({ success: true, data })); }
  @Get("daily-distribution") distributions(@Req() r: any) { return this.service.queryDailyDistribution(this.phone(r)).then(data => ({ success: true, data })); }
  @Post("ai/chat") aiChat(@Req() r: any, @Body() b: any) { return this.service.aiText(this.phone(r, b), b.content, b.model).then(content => ({ success: true, data: { content } })); }
  @Post("potential-customers") createPotential(@Req() r: any, @Body() b: any) { return this.service.createPotentialCustomer({ ...b, phone: this.phone(r, b) }).then(data => ({ success: true, data })); }
  @Get("potential-customers") queryPotential(@Req() r: any, @Query() q: any) { return this.service.queryPotentialCustomers({ ...q, phone: this.phone(r, undefined, q) }).then(data => ({ success: true, data })); }
  @Put("potential-customers/:id") updatePotential(@Req() r: any, @Param("id") id: string, @Body() b: any) { return this.service.updatePotentialCustomer(id, this.phone(r, b), b).then(data => ({ success: true, data })); }
  @Post("today-communications") createComm(@Req() r: any, @Body() b: any) { return this.service.createTodayCommunication({ ...b, phone: this.phone(r, b) }).then(data => ({ success: true, data })); }
  @Post("today-communications/generate") generateComm(@Req() r: any, @Body() b: any) { return this.service.generateTodayCommunications(this.phone(r), { limit: b?.limit }).then(data => ({ success: true, data })); }
  @Get("today-communications") queryComm(@Req() r: any, @Query() q: any) { return this.service.queryTodayCommunications({ ...q, phone: this.phone(r, undefined, q) }).then(data => ({ success: true, data })); }
  @Put("today-communications/:id") updateComm(@Req() r: any, @Param("id") id: string, @Body() b: any) { return this.service.updateTodayCommunication(id, this.phone(r, b), b).then(data => ({ success: true, data })); }
  @Post("customer-profiles") createProfile(@Req() r: any, @Body() b: any) { return this.service.createCustomerProfile({ ...b, phone: this.phone(r, b) }).then(data => ({ success: true, data })); }
  @Get("customer-profiles") queryProfile(@Req() r: any, @Query() q: any) { return this.service.queryCustomerProfiles({ ...q, phone: this.phone(r, undefined, q) }).then(data => ({ success: true, data })); }
  @Put("customer-profiles/:id") updateProfile(@Req() r: any, @Param("id") id: string, @Body() b: any) { return this.service.updateCustomerProfile(id, this.phone(r, b), b).then(data => ({ success: true, data })); }
  @Post("strategy-summaries") createStrategy(@Req() r: any, @Body() b: any) { return this.service.createStrategySummary({ ...b, phone: this.phone(r, b) }).then(data => ({ success: true, data })); }
  @Get("strategy-summaries") queryStrategy(@Req() r: any) { return this.service.queryStrategySummaries(this.phone(r)).then(data => ({ success: true, data })); }
  @Put("strategy-summaries/:id") updateStrategy(@Req() r: any, @Param("id") id: string, @Body() b: any) { return this.service.updateStrategySummary(id, this.phone(r, b), b).then(data => ({ success: true, data })); }
  @Post("customer-collections") createCollection(@Req() r: any, @Body() b: any) { return this.service.createCustomerCollection({ ...b, phone: this.phone(r, b) }).then(data => ({ success: true, data })); }
  @Get("customer-collections") queryCollection(@Req() r: any, @Query() q: any) { return this.service.queryCustomerCollections({ ...q, phone: this.phone(r, undefined, q) }).then(data => ({ success: true, data })); }
  @Put("customer-collections/:id/mark-added") markAdded(@Req() r: any, @Param("id") id: string) { return this.service.markWechatAdded(id, this.phone(r)).then(data => ({ success: true, data })); }
  @Post("user-chat-prompts") createPrompt(@Req() r: any, @Body() b: any) { return this.service.createUserChatPrompt({ ...b, phone: this.phone(r, b) }).then(data => ({ success: true, data })); }
  @Get("user-chat-prompts") queryPrompt(@Req() r: any, @Query() q: any) { return this.service.queryUserChatPrompts({ ...q, phone: this.phone(r, undefined, q) }).then(data => ({ success: true, data })); }
  @Put("user-chat-prompts/:id") updatePrompt(@Req() r: any, @Param("id") id: string, @Body() b: any) { return this.service.updateUserChatPrompt(id, this.phone(r, b), b).then(data => ({ success: true, data })); }
  @Delete("user-chat-prompts/:id") deletePrompt(@Req() r: any, @Param("id") id: string, @Query("phone") p?: string) { const phone = this.phone(r, undefined, p ? { phone: p } : undefined); return this.service.deleteUserChatPrompt(id, phone); }
  @Get("wxauto/status") wxStatus() { throw new BadRequestException("个人微信接口由 T-11 自研 UIAutomation 提供"); }
  @Post("wxauto/listen") wxListen() { throw new BadRequestException("个人微信接口由 T-11 自研 UIAutomation 提供"); }
  @Post("wxauto/add-friend") wxFriend() { throw new BadRequestException("个人微信接口由 T-11 自研 UIAutomation 提供"); }
}
