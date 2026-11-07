import { BadRequestException } from "@nestjs/common";
import { CronTime } from "cron";
import type { CapabilityContext, CapabilityDescriptor, CapabilityHandler } from "../capability.types";

/**
 * 员工派活 + 定时任务能力（P17）。
 *
 * 与 employee.service.ts / employee-cron.service.ts 的关系：
 * - 本文件不改也不调用那两个 Service，而是按同样的口径用 prisma 复刻校验，
 *   因为能力层只拿到 prisma，拿不到 Nest 容器里的 EmployeeService / PackageService。
 * - 复刻是有意的：employee.service.run 还包含 PackageService.assertAccess（团队套餐授权），
 *   能力层没有 PackageService；这里保留了「安装有效 + 付费员工购买记录有效」两条核心口径，
 *   套餐授权仍需走原有 /employee 接口（见 docs/handoff/P17-employee-tools.md）。
 * - nextDate 与 employee-cron.service.ts 中的同名私有函数逐字一致；原函数未导出，
 *   在不修改该文件的前提下只能内部复刻同一实现（CronTime + 非法值兜底）。
 */

export const descriptors: CapabilityDescriptor[] = [
  {
    name: "employee_dispatch",
    title: "给其他 AI 员工派活",
    category: "employee",
    description: "把一条需求派给另一个已安装的 AI 员工，创建一条排队任务",
    params: {
      employeeSlug: "必填，目标员工 slug",
      input: "必填，交给该员工的需求",
      title: "可选，任务标题，默认「员工名 · 派活」",
      parentEmployeeSlug: "可选，当前员工 slug；与目标 slug 相同会被拒绝",
    },
  },
  {
    name: "employee_task_status",
    title: "查询 AI 员工任务进度",
    category: "employee",
    description: "查询当前用户某条员工任务的状态、输出与产物",
    params: { taskId: "必填，任务 id" },
  },
  {
    name: "cron_create",
    title: "给员工创建定时任务",
    category: "employee",
    description: "为当前用户已安装的 AI 员工创建定时任务",
    params: {
      employeeSlug: "必填，员工 slug",
      cronExpr: "必填，5 段标准 cron（分 时 日 月 周）",
      timezone: "可选，默认 Asia/Shanghai",
      workflowKey: "可选，默认 default",
      title: "可选",
    },
  },
  {
    name: "cron_list",
    title: "查看我的定时任务",
    category: "employee",
    description: "列出当前用户全部员工定时任务，按下次执行时间升序",
    params: {},
  },
  {
    name: "cron_delete",
    title: "删除定时任务",
    category: "employee",
    description: "删除当前用户自己的一条员工定时任务",
    params: { cronId: "必填，定时任务 id" },
  },
];

const TASK_CONCURRENCY_LIMIT = 5;

interface EmployeeRow {
  id: string;
  slug: string;
  name: string;
  price: number | null;
  isBundled: boolean;
  cliRequirement: string | null;
  isActive: boolean;
}

interface InstallRow {
  enabled: boolean;
  expiresAt: Date | null;
}

interface PurchaseRow {
  status: string;
  expiresAt: Date | null;
}

interface TaskRow {
  id: string;
  userId: string;
  employeeId: string;
  title: string;
  status: string;
  outputText: string | null;
  error: string | null;
  createdAt: Date | string;
  finishedAt: Date | string | null;
}

interface ArtifactRow {
  kind: string;
  url: string | null;
  text: string | null;
}

interface CronRow {
  id: string;
  userId: string;
  employeeId: string;
  cronExpr: string;
  timezone: string;
  workflowKey: string;
  enabled: boolean;
  nextRunAt: Date | string | null;
  lastRunAt: Date | string | null;
}

/** 与 employee-cron.service.ts 的 nextDate 完全一致（该函数未导出，只能复刻） */
function nextDate(expr: string, zone: string, from: Date): Date {
  try {
    const next = new CronTime(expr, zone).getNextDateFrom(from, zone).toJSDate();
    if (!Number.isFinite(next.getTime())) throw new Error("invalid date");
    return next;
  } catch {
    throw new BadRequestException("cronExpr 或 timezone 不合法");
  }
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function truncateText(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequestException(message);
  return value.trim();
}

async function requireEmployee(prisma: any, slug: string): Promise<EmployeeRow> {
  const emp = (await prisma.aiEmployee.findUnique({ where: { slug } })) as EmployeeRow | null;
  if (!emp || !emp.isActive) throw new BadRequestException("员工不存在或已下架");
  return emp;
}

function isInstallExpired(install: InstallRow | null, nowMs: number): boolean {
  return !install || !install.enabled || !!(install.expiresAt && install.expiresAt.getTime() <= nowMs);
}

/** 与 employee-cron.service.ts create 一致：只看安装记录是否启用/未过期 */
async function requireInstalled(prisma: any, userId: string, emp: EmployeeRow): Promise<void> {
  const install = (await prisma.aiEmployeeInstall.findUnique({
    where: { userId_employeeId: { userId, employeeId: emp.id } },
  })) as InstallRow | null;
  if (isInstallExpired(install, Date.now())) throw new BadRequestException("员工未安装或授权已过期");
}

/** 与 employee.service.ts run 一致：安装有效 + 付费员工以购买记录为准 */
async function requireRunnable(prisma: any, userId: string, emp: EmployeeRow): Promise<void> {
  const install = (await prisma.aiEmployeeInstall.findUnique({
    where: { userId_employeeId: { userId, employeeId: emp.id } },
  })) as InstallRow | null;
  const nowMs = Date.now();
  let expired = isInstallExpired(install, nowMs);
  if (!expired && !emp.isBundled && (emp.price ?? 0) > 0) {
    const purchase = (await prisma.aiEmployeePurchase.findUnique({
      where: { userId_employeeId: { userId, employeeId: emp.id } },
    })) as PurchaseRow | null;
    const purchaseActive =
      !!purchase &&
      purchase.status === "active" &&
      (!purchase.expiresAt || purchase.expiresAt.getTime() > nowMs);
    expired = !purchaseActive;
  }
  if (expired) throw new BadRequestException("员工未安装或授权已过期");
}

function publicEmployee(emp: EmployeeRow | null | undefined): { slug: string; name: string } {
  return { slug: emp?.slug ?? "", name: emp?.name ?? "" };
}

export function buildEmployeeHandlers(prisma: any): Record<string, CapabilityHandler> {
  return {
    employee_dispatch: async (ctx: CapabilityContext) => {
      const { userId, params } = ctx;
      const employeeSlug = requireString(params.employeeSlug, "employeeSlug 必填");
      const input = requireString(params.input, "input 必填");
      const emp = await requireEmployee(prisma, employeeSlug);
      if (params.parentEmployeeSlug !== undefined && params.parentEmployeeSlug !== null) {
        const parentSlug = requireString(params.parentEmployeeSlug, "parentEmployeeSlug 不合法");
        if (parentSlug === emp.slug) throw new BadRequestException("不能给自己派活");
      }
      await requireRunnable(prisma, userId, emp);
      const active = await prisma.employeeTask.count({
        where: { userId, status: { in: ["queued", "running"] } },
      });
      if (active >= TASK_CONCURRENCY_LIMIT) {
        throw new BadRequestException("派活过于频繁，请等当前任务完成");
      }
      const executor = emp.cliRequirement === "required" ? "desktop" : "cloud";
      const title =
        typeof params.title === "string" && params.title.trim()
          ? params.title.trim()
          : emp.name + " · 派活";
      const task = await prisma.employeeTask.create({
        data: {
          userId,
          employeeId: emp.id,
          title,
          input,
          status: "queued",
          executor,
        },
      });
      return {
        taskId: task.id,
        employee: publicEmployee(emp),
        status: task.status,
        executor,
      };
    },

    employee_task_status: async (ctx: CapabilityContext) => {
      const { userId, params } = ctx;
      const taskId = requireString(params.taskId, "taskId 必填");
      const task = (await prisma.employeeTask.findUnique({ where: { id: taskId } })) as TaskRow | null;
      if (!task || task.userId !== userId) throw new BadRequestException("任务不存在");
      const emp = (await prisma.aiEmployee.findUnique({ where: { id: task.employeeId } })) as EmployeeRow | null;
      const artifacts = (await prisma.employeeTaskArtifact.findMany({
        where: { taskId: task.id },
        orderBy: { createdAt: "asc" },
      })) as ArtifactRow[];
      return {
        taskId: task.id,
        status: task.status,
        title: task.title,
        employee: publicEmployee(emp),
        outputText: truncateText(task.outputText, 4000),
        artifacts: artifacts.map((a) => ({
          kind: a.kind,
          url: a.url ?? null,
          text: truncateText(a.text, 300),
        })),
        error: task.error ?? null,
        createdAt: toIso(task.createdAt),
        finishedAt: toIso(task.finishedAt),
      };
    },

    cron_create: async (ctx: CapabilityContext) => {
      const { userId, params } = ctx;
      const employeeSlug = requireString(params.employeeSlug, "employeeSlug 必填");
      const cronExpr = requireString(params.cronExpr, "cronExpr 必填");
      const emp = await requireEmployee(prisma, employeeSlug);
      await requireInstalled(prisma, userId, emp);
      const timezone =
        params.timezone === undefined || params.timezone === null
          ? "Asia/Shanghai"
          : requireString(params.timezone, "timezone 不合法");
      const workflowKey =
        typeof params.workflowKey === "string" && params.workflowKey.trim()
          ? params.workflowKey.trim()
          : "default";
      const nextRunAt = nextDate(cronExpr, timezone, new Date());
      const cron = (await prisma.employeeCron.create({
        data: {
          userId,
          employeeId: emp.id,
          cronExpr,
          timezone,
          workflowKey,
          enabled: true,
          nextRunAt,
        },
      })) as CronRow;
      return {
        cronId: cron.id,
        nextRunAt: toIso(cron.nextRunAt ?? nextRunAt),
        cronExpr,
        timezone,
        employee: publicEmployee(emp),
      };
    },

    cron_list: async (ctx: CapabilityContext) => {
      const { userId } = ctx;
      const rows = (await prisma.employeeCron.findMany({
        where: { userId },
        orderBy: { nextRunAt: "asc" },
      })) as CronRow[];
      const employeeIds = Array.from(new Set(rows.map((r) => r.employeeId)));
      const employees = employeeIds.length
        ? ((await prisma.aiEmployee.findMany({ where: { id: { in: employeeIds } } })) as EmployeeRow[])
        : [];
      const byId = new Map(employees.map((e) => [e.id, e]));
      const items = rows.map((r) => ({
        cronId: r.id,
        employee: publicEmployee(byId.get(r.employeeId)),
        cronExpr: r.cronExpr,
        timezone: r.timezone,
        enabled: r.enabled,
        nextRunAt: toIso(r.nextRunAt),
        lastRunAt: toIso(r.lastRunAt),
      }));
      return { items, total: items.length };
    },

    cron_delete: async (ctx: CapabilityContext) => {
      const { userId, params } = ctx;
      const cronId = requireString(params.cronId, "cronId 必填");
      const cron = (await prisma.employeeCron.findFirst({
        where: { id: cronId, userId },
      })) as CronRow | null;
      if (!cron) throw new BadRequestException("定时器不存在");
      await prisma.employeeCron.deleteMany({ where: { id: cronId, userId } });
      return { cronId, deleted: true };
    },
  };
}
