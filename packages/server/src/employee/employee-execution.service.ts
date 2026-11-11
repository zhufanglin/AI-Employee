import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EmployeeService } from "./employee.service";
import { StrategyService, parseNeeds } from "../strategy/strategy.service";
import { readWorkspaceRules } from "./workspace-rules";
import { randomUUID } from "node:crypto";

@Injectable()
export class EmployeeExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly employees: EmployeeService,
    private readonly strategy: StrategyService,
  ) {}

  private timeoutMs() {
    const seconds = Number(process.env.EMPLOYEE_HEARTBEAT_TIMEOUT_SECONDS || 90);
    return Math.max(15, Number.isFinite(seconds) ? seconds : 90) * 1000;
  }

  async heartbeat(userId: string, body: any) {
    const deviceId = typeof body?.deviceId === "string" ? body.deviceId.trim() : "";
    if (!deviceId) throw new BadRequestException("deviceId 必填");
    const executor = body?.executor === "cloud" ? "cloud" : "desktop";
    return this.prisma.employeeExecutionNode.upsert({
      where: { userId_deviceId: { userId, deviceId } },
      create: { userId, deviceId, executor, status: "online", lastSeenAt: new Date(), metadata: body?.metadata ?? undefined },
      update: { executor, status: "online", lastSeenAt: new Date(), metadata: body?.metadata ?? undefined },
    });
  }

  async nodes(userId: string) {
    const rows = await this.prisma.employeeExecutionNode.findMany({ where: { userId }, orderBy: { lastSeenAt: "desc" } });
    const cutoff = Date.now() - this.timeoutMs();
    return rows.map((row) => ({ ...row, effectiveStatus: row.lastSeenAt.getTime() >= cutoff ? row.status : "offline" }));
  }

  async claimCloudTasks(userId: string, limitRaw?: string | number) {
    await this.employees.recoverStalledTasks(userId);
    const limit = Math.min(3, Math.max(1, Number(limitRaw) || 1));
    const now = new Date();
    const candidates = await this.prisma.employeeTask.findMany({ where: { userId, executor: "cloud", status: "queued", runAt: { lte: now } }, orderBy: { runAt: "asc" }, take: limit, select: { id: true, outputMeta: true } });
    const ids = candidates.map((row) => row.id);
    if (!ids.length) return { items: [], count: 0 };
    const claimed: string[] = [];
    for (const id of ids) {
      const raw = candidates.find(item => item.id === id)?.outputMeta;
      const meta = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      const result = await this.prisma.employeeTask.updateMany({ where: { id, userId, executor: "cloud", status: "queued" }, data: { status: "running", startedAt: now, outputMeta: { ...meta, claimToken: randomUUID() } } });
      if (result.count) claimed.push(id);
    }
    const rows = await this.prisma.employeeTask.findMany({ where: { id: { in: claimed }, userId }, orderBy: { runAt: "asc" } });
    const employeeIds = Array.from(new Set(rows.map(row => row.employeeId).filter(Boolean)));
    const skills = employeeIds.length ? await this.prisma.aiEmployee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, skillMd: true } }) : [];
    const byEmployee = new Map(skills.map(employee => [employee.id, employee.skillMd ?? null]));
    // P42：云端 claim 按 userId 拉取，这里补 User.phone 后再按员工 needs 注入战略/人设
    const owner = await (this.prisma as any).user.findUnique({ where: { id: userId }, select: { phone: true } });
    const phone = owner?.phone ? String(owner.phone) : "";
    const payloadByEmp = new Map<string, { employeeNeeds: string[]; strategyText: string; personaText: string; strategyVersion: string; strategyUpdatedAt: string | null }>();
    await Promise.all(
      Array.from(byEmployee.entries()).map(async ([employeeId, skillMd]) => {
        const employeeNeeds = parseNeeds(skillMd);
        const resolved = phone
          ? await this.strategy.resolveForEmployee(userId, phone, employeeNeeds)
          : { strategyText: "", personaText: "", strategyVersion: "", strategyUpdatedAt: null };
        payloadByEmp.set(employeeId, { employeeNeeds, ...resolved });
      }),
    );
    const workspaceRules = readWorkspaceRules(userId);
    const items = rows.map(row => {
      const payload = payloadByEmp.get(row.employeeId);
      return {
        ...row,
        employeeSkillMd: byEmployee.get(row.employeeId) ?? null,
        employeeNeeds: payload?.employeeNeeds ?? [],
        strategyText: payload?.strategyText ?? "",
        personaText: payload?.personaText ?? "",
        strategyVersion: payload?.strategyVersion ?? "",
        strategyUpdatedAt: payload?.strategyUpdatedAt ?? null,
        workspaceRules,
      };
    });
    return { items, count: items.length };
  }

  async recover(userId: string) {
    return this.employees.recoverStalledTasks(userId);
  }

  async taskHeartbeat(userId: string, taskId: string, claimToken: unknown) {
    if (typeof claimToken !== 'string' || !claimToken) throw new BadRequestException('缺少任务领取凭据');
    const changed = await this.prisma.employeeTask.updateMany({ where: { id: taskId, userId, status: 'running', outputMeta: { path: '$.claimToken', equals: claimToken } }, data: { updatedAt: new Date() } });
    if (!changed.count) throw new BadRequestException('任务领取已失效');
    return { success: true };
  }

  async nodeHeartbeat(userId: string, deviceId: string) {
    if (!deviceId) throw new BadRequestException("deviceId 必填");
    const node = await this.prisma.employeeExecutionNode.findFirst({ where: { userId, deviceId } });
    if (!node) throw new NotFoundException("执行节点不存在");
    return this.prisma.employeeExecutionNode.update({ where: { id: node.id }, data: { status: "online", lastSeenAt: new Date() } });
  }
}
