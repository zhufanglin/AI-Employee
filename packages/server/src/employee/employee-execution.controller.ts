import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { EmployeeExecutionService } from "./employee-execution.service";

@Controller("employee-execution")
export class EmployeeExecutionController {
  constructor(private readonly execution: EmployeeExecutionService) {}
  @Post("heartbeat") heartbeat(@Req() req: any, @Body() body: any) { return this.execution.heartbeat(req.user.id, body); }
  @Post("nodes/:deviceId/heartbeat") nodeHeartbeat(@Req() req: any, @Param("deviceId") deviceId: string) { return this.execution.nodeHeartbeat(req.user.id, deviceId); }
  @Get("nodes") nodes(@Req() req: any) { return this.execution.nodes(req.user.id); }
  @Post("pull") pull(@Req() req: any, @Query("limit") limit?: string) { return this.execution.claimCloudTasks(req.user.id, limit); }
  /** 执行节点失联兜底：把长时间 running 未回写的任务重新排队（前两次）或判失败（第三次） */
  @Post("recover") recover(@Req() req: any) { return this.execution.recover(req.user.id); }
  @Post("tasks/:taskId/heartbeat") taskHeartbeat(@Req() req: any, @Param("taskId") taskId: string, @Body() body: any) { return this.execution.taskHeartbeat(req.user.id, taskId, body?.claimToken); }
}
