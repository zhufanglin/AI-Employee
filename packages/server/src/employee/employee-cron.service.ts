import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { CronTime } from "cron";
import { PrismaService } from "../prisma/prisma.service";

function nextDate(expr: string, zone: string, from: Date): Date {
  try {
    const next = new CronTime(expr, zone).getNextDateFrom(from, zone).toJSDate();
    if (!Number.isFinite(next.getTime())) throw new Error("invalid date");
    return next;
  } catch { throw new BadRequestException("cronExpr 或 timezone 不合法"); }
}

@Injectable()
export class EmployeeCronService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private readonly logger = new Logger(EmployeeCronService.name);
  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.tick().catch(e => this.logger.error("员工定时调度失败", e));
    this.timer = setInterval(() => this.tick().catch(e => this.logger.error("员工定时调度失败", e)), 15000);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async list(userId: string) {
    const items = await this.prisma.employeeCron.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
    return { items, total: items.length };
  }
  async create(userId: string, body: any = {}) {
    if (typeof body.employeeId !== "string" || !body.employeeId || typeof body.cronExpr !== "string" || !body.cronExpr.trim()) throw new BadRequestException("employeeId 和 cronExpr 必填");
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new BadRequestException("enabled 不合法");
    const employee = await this.prisma.aiEmployee.findFirst({ where: { id: body.employeeId, isActive: true } });
    if (!employee) throw new NotFoundException("员工不存在或已下架");
    const install = await this.prisma.aiEmployeeInstall.findUnique({ where: { userId_employeeId: { userId, employeeId: employee.id } } });
    if (!install || !install.enabled || (install.expiresAt && install.expiresAt <= new Date())) throw new BadRequestException("员工未安装或已过期");
    const timezone = body.timezone ?? "Asia/Shanghai";
    if (typeof timezone !== "string") throw new BadRequestException("timezone 不合法");
    const nextRunAt = nextDate(body.cronExpr, timezone, new Date());
    return this.prisma.employeeCron.create({ data: { userId, employeeId: employee.id, cronExpr: body.cronExpr, timezone, workflowKey: typeof body.workflowKey === "string" && body.workflowKey.trim() ? body.workflowKey.trim() : "default", enabled: body.enabled ?? true, nextRunAt } });
  }
  private async own(userId: string, id: string) {
    const cron = await this.prisma.employeeCron.findFirst({ where: { id, userId } });
    if (!cron) throw new NotFoundException("定时器不存在");
    return cron;
  }
  async update(userId: string, id: string, body: any = {}) {
    const cron = await this.own(userId, id);
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new BadRequestException("enabled 不合法");
    const expr = body.cronExpr ?? cron.cronExpr;
    const zone = body.timezone ?? cron.timezone;
    if (typeof expr !== "string" || typeof zone !== "string") throw new BadRequestException("cronExpr 或 timezone 不合法");
    if (body.workflowKey !== undefined && (typeof body.workflowKey !== "string" || !body.workflowKey.trim())) throw new BadRequestException("workflowKey 不合法");
    const calculated = nextDate(expr, zone, new Date());
    const reset = expr !== cron.cronExpr || zone !== cron.timezone || (body.enabled === true && !cron.enabled);
    return this.prisma.employeeCron.update({ where: { id }, data: { cronExpr: expr, timezone: zone, ...(body.workflowKey !== undefined ? { workflowKey: body.workflowKey.trim() } : {}), ...(body.enabled !== undefined ? { enabled: body.enabled } : {}), ...(reset ? { nextRunAt: calculated } : {}) } });
  }
  async remove(userId: string, id: string) {
    await this.own(userId, id);
    await this.prisma.employeeCron.deleteMany({ where: { id, userId } });
    return { success: true };
  }

  async tick(now = new Date()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = await this.prisma.employeeCron.findMany({ where: { enabled: true, nextRunAt: { lte: now } }, orderBy: { nextRunAt: "asc" }, take: 100 });
      for (const cron of due) {
        try {
          for (let count = 0; count < 3; count++) {
            const result = await this.prisma.$transaction(async tx => {
              const current = await tx.employeeCron.findUnique({ where: { id: cron.id } });
              if (!current?.enabled || !current.nextRunAt || current.nextRunAt > now) return false;
              const runAt = current.nextRunAt;
              const following = nextDate(current.cronExpr, current.timezone, runAt);
              const missed = now.getTime() - runAt.getTime() >= 60000;
              const claimed = await tx.employeeCron.updateMany({ where: { id: current.id, enabled: true, nextRunAt: runAt }, data: { nextRunAt: following, lastRunAt: runAt, ...(missed ? { missedCount: { increment: 1 } } : {}) } });
              if (!claimed.count) return false;
              const emp = await tx.aiEmployee.findUnique({ where: { id: current.employeeId } });
              const install = await tx.aiEmployeeInstall.findUnique({ where: { userId_employeeId: { userId: current.userId, employeeId: current.employeeId } } });
              if (!emp || !emp.isActive || !install?.enabled || (install.expiresAt && install.expiresAt <= runAt)) return true;
              const data = { userId: current.userId, employeeId: current.employeeId, cronId: current.id, title: emp.name + " · " + current.workflowKey, input: { workflowKey: current.workflowKey }, executor: emp.cliRequirement === "required" ? "desktop" : "cloud", runAt };
              if (missed) {
                const original = await tx.employeeTask.create({ data: { ...data, status: "failed", error: "missed_schedule", finishedAt: now } });
                await tx.employeeTask.create({ data: { ...data, status: "queued", missedOf: original.id } });
              } else await tx.employeeTask.create({ data: { ...data, status: "queued" } });
              return true;
            });
            if (!result) break;
          }
        } catch (e) { this.logger.error(`定时器 ${cron.id} 调度失败`, e); }
      }
    } finally { this.busy = false; }
  }

  async summary(userId: string) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const [todayTasks, groups, employees] = await Promise.all([
      this.prisma.employeeTask.count({ where: { userId, runAt: { gte: today, lt: tomorrow } } }),
      this.prisma.employeeTask.groupBy({ by: ["employeeId", "status"], where: { userId }, _count: { _all: true } }),
      this.prisma.aiEmployee.findMany({ select: { id: true, slug: true, name: true, avatarEmoji: true } }),
    ]);
    const byId = new Map(employees.map(e => [e.id, e]));
    const totals: Record<string, number> = {};
    const byEmployee = new Map<string, any>();
    for (const group of groups) {
      const n = group._count._all; totals[group.status] = (totals[group.status] || 0) + n;
      const row = byEmployee.get(group.employeeId) || { employeeId: group.employeeId, employee: byId.get(group.employeeId) || null, total: 0, statuses: {} };
      row.total += n; row.statuses[group.status] = n; byEmployee.set(group.employeeId, row);
    }
    const ranking = Array.from(byEmployee.values()).sort((a, b) => b.total - a.total || a.employeeId.localeCompare(b.employeeId));
    return { todayTasks, awaitingApproval: totals.awaiting_approval || 0, failed: totals.failed || 0, statuses: totals, employees: ranking };
  }
}
