import { BadRequestException } from "@nestjs/common";
import { CronTime } from "cron";
import type { CapabilityContext, CapabilityDescriptor, CapabilityHandler } from "../capability.types";
import type { ToolapiService } from "../../toolapi/toolapi.service";

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
      wait: "可选，是否等任务到终态，默认 false",
      maxWaitSeconds: "可选，wait=true 时最长等待秒数，默认 0（按 60 秒处理），上限 300",
    },
  },
  {
    name: "team_run",
    title: "团队协作编排",
    category: "employee",
    description: "一次把 1-5 条需求派给多个已安装的 AI 员工，等它们全部到终态（或超时）后，可汇总成一段中文结论",
    params: {
      jobs: "必填，任务数组，1-5 条；每条形如 { employeeSlug: string, input: string, title?: string }",
      maxWaitSeconds: "可选，最长等待秒数，默认 180，上限 300",
      aggregate: "可选，是否由模型汇总成中文结论，默认 true",
      parentEmployeeSlug: "可选，当前员工 slug；与任一目标 slug 相同会被拒绝",
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
    name: "cron_update",
    title: "修改/启停定时任务",
    category: "employee",
    description: "修改自己的一条员工定时任务的 cron 表达式、时区，或启用/停用（对应原版 cron:update / cron:toggle）",
    params: {
      cronId: "必填，定时任务 id",
      enabled: "可选，true 启用 / false 停用",
      cronExpr: "可选，新的 5 段 cron",
      timezone: "可选，新的时区",
      workflowKey: "可选，新的 workflowKey",
    },
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
const TEAM_RUN_MAX_JOBS = 5;
const TEAM_RUN_POLL_MS = 3000;
const TEAM_SUMMARY_WAIT_DEFAULT = 180;
const DISPATCH_WAIT_FALLBACK = 60;
const WAIT_MAX_SECONDS = 300;
const DISPATCH_OUTPUT_LIMIT = 1200;
const TEAM_OUTPUT_LIMIT = 800;
/** 终态：等待人工确认也算干完了，继续等也不会再变 */
const TERMINAL_TASK_STATUS = new Set(["awaiting_approval", "succeeded", "failed"]);

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

/** 秒数入参统一校验：缺省取 fallback，非法拒绝，超过上限按上限截断 */
function requireSeconds(value: unknown, name: string, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) throw new BadRequestException(name + " 不合法");
  return Math.min(max, seconds);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function isTerminal(status: unknown): boolean {
  return typeof status === "string" && TERMINAL_TASK_STATUS.has(status);
}

function taskOutput(value: unknown, max: number): string {
  return String(value ?? "").slice(0, max);
}

function mechanicalSummary(items: Array<{ employeeSlug: string; status: string; outputText: string }>): string {
  const succeeded = items.filter((item) => item.status === "succeeded").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const pending = items.length - succeeded - failed;
  const head =
    "【团队协作汇总】本批共 " + items.length + " 个任务：成功 " + succeeded + " 个、失败 " + failed + " 个、未完成 " + pending + " 个。";
  const body = items
    .map((item, index) => {
      const text = item.outputText.trim() ? item.outputText.trim() : "（暂无产出）";
      return index + 1 + ". " + item.employeeSlug + "（" + item.status + "）：" + text;
    })
    .join("\n");
  return head + "\n" + body;
}

/**
 * 用现有文本生成路径把多员工产出汇总成 300-600 字结论。
 * 模型不可用（未绑手机号、未配置模型、上游失败）时退回机械拼接，不能让整个 team_run 失败。
 */
async function summarizeTeamRun(
  toolapi: ToolapiService | undefined,
  phone: string | null,
  items: Array<{ employeeSlug: string; status: string; outputText: string }>,
): Promise<string> {
  const hasOutput = items.some((item) => item.outputText.trim());
  if (!hasOutput) return mechanicalSummary(items);
  try {
    if (!toolapi || !phone) throw new Error("缺少模型调用条件");
    const blocks = items
      .map((item, index) =>
        [
          index + 1 + ". 员工：" + item.employeeSlug,
          "状态：" + item.status,
          "产出：" + (item.outputText.trim() || "（暂无产出）"),
        ].join("\n"),
      )
      .join("\n\n");
    const prompt =
      "你是团队协作的汇总助手。下面是多位 AI 员工执行同一批任务的结果。请用 300-600 字中文写一段结论：" +
      "先给整体结论，再分别说明每位员工的关键产出，最后给出可执行的下一步建议。" +
      "只依据下面出现的内容，不要编造未出现的事实。\n\n" +
      blocks;
    const text = await toolapi.aiText(phone, prompt);
    if (typeof text === "string" && text.trim()) return text.trim();
  } catch {
    // 模型失败不打断团队编排，下面退回机械拼接
  }
  return mechanicalSummary(items);
}

/** 轮询单条任务直到终态或超时，返回最后一次读到的任务行 */
async function waitForOneTask(prisma: any, task: TaskRow, maxWaitSeconds: number) {
  const startedAt = Date.now();
  const deadline = startedAt + maxWaitSeconds * 1000;
  let current = task;
  while (!isTerminal(current.status) && Date.now() < deadline) {
    await sleep(Math.min(TEAM_RUN_POLL_MS, deadline - Date.now()));
    const fresh = (await prisma.employeeTask.findUnique({ where: { id: current.id } })) as TaskRow | null;
    if (fresh) current = fresh;
  }
  return { task: current, timedOut: !isTerminal(current.status), elapsedMs: Date.now() - startedAt };
}

/** 批量轮询：所有任务到终态或总超时，返回 taskId → 最新任务行 */
async function waitForTasks(prisma: any, taskIds: string[], maxWaitSeconds: number) {
  const startedAt = Date.now();
  const deadline = startedAt + maxWaitSeconds * 1000;
  const byId = new Map<string, TaskRow>();
  const load = async () => {
    const rows = (await prisma.employeeTask.findMany({ where: { id: { in: taskIds } } })) as TaskRow[];
    for (const row of rows) byId.set(row.id, row);
  };
  await load();
  const allDone = () => taskIds.every((id) => isTerminal(byId.get(id)?.status));
  while (!allDone() && Date.now() < deadline) {
    await sleep(Math.min(TEAM_RUN_POLL_MS, deadline - Date.now()));
    await load();
  }
  return { byId, timedOut: !allDone(), elapsedMs: Date.now() - startedAt };
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

export function buildEmployeeHandlers(prisma: any, toolapi?: ToolapiService): Record<string, CapabilityHandler> {
  return {
    employee_dispatch: async (ctx: CapabilityContext) => {
      const { userId, params } = ctx;
      const employeeSlug = requireString(params.employeeSlug, "employeeSlug 必填");
      const input = requireString(params.input, "input 必填");
      if (params.wait !== undefined && typeof params.wait !== "boolean") {
        throw new BadRequestException("wait 不合法");
      }
      const wait = params.wait === true;
      const maxWaitSeconds = requireSeconds(params.maxWaitSeconds, "maxWaitSeconds", 0, WAIT_MAX_SECONDS);
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
      const task = (await prisma.employeeTask.create({
        data: {
          userId,
          employeeId: emp.id,
          title,
          input,
          status: "queued",
          executor,
        },
      })) as TaskRow;
      const base = {
        taskId: task.id,
        employee: publicEmployee(emp),
        status: task.status,
        executor,
      };
      if (!wait) return base;
      // wait=true 但没给秒数时按 60 秒处理，避免默认值 0 变成「立刻超时」的无效等待
      const waited = await waitForOneTask(prisma, task, maxWaitSeconds > 0 ? maxWaitSeconds : DISPATCH_WAIT_FALLBACK);
      return {
        ...base,
        status: waited.task.status,
        outputText: taskOutput(waited.task.outputText, DISPATCH_OUTPUT_LIMIT),
        error: waited.task.error ?? null,
        timedOut: waited.timedOut,
        elapsedMs: waited.elapsedMs,
      };
    },

    // 团队编排：一次校验并创建多条派活任务，等齐后可选模型汇总；单条失败只影响校验阶段，
    // 一旦任务创建成功就尽量返回全部结果（超时也返回已有产出，不让整个能力打挂）。
    team_run: async (ctx: CapabilityContext) => {
      const { userId, phone, params } = ctx;
      const rawJobs = params.jobs;
      if (!Array.isArray(rawJobs) || rawJobs.length < 1 || rawJobs.length > TEAM_RUN_MAX_JOBS) {
        throw new BadRequestException("jobs 必填，需提供 1-5 条任务");
      }
      if (params.aggregate !== undefined && typeof params.aggregate !== "boolean") {
        throw new BadRequestException("aggregate 不合法");
      }
      const aggregate = params.aggregate !== false;
      const maxWaitSeconds = requireSeconds(
        params.maxWaitSeconds,
        "maxWaitSeconds",
        TEAM_SUMMARY_WAIT_DEFAULT,
        WAIT_MAX_SECONDS,
      );
      let parentSlug: string | null = null;
      if (params.parentEmployeeSlug !== undefined && params.parentEmployeeSlug !== null) {
        parentSlug = requireString(params.parentEmployeeSlug, "parentEmployeeSlug 不合法");
      }

      // 先逐条校验，任何一条不合法都不创建任务，避免半批派活留下脏数据
      const prepared: Array<{ emp: EmployeeRow; input: string; title: string; executor: string }> = [];
      for (let index = 0; index < rawJobs.length; index += 1) {
        const job = rawJobs[index];
        if (!job || typeof job !== "object" || Array.isArray(job)) {
          throw new BadRequestException("第 " + (index + 1) + " 条任务格式不合法");
        }
        const employeeSlug = requireString(job.employeeSlug, "第 " + (index + 1) + " 条任务 employeeSlug 必填");
        const input = requireString(job.input, "第 " + (index + 1) + " 条任务 input 必填");
        const emp = await requireEmployee(prisma, employeeSlug);
        if (parentSlug !== null && parentSlug === emp.slug) {
          throw new BadRequestException("不能给自己派活");
        }
        await requireRunnable(prisma, userId, emp);
        const title =
          typeof job.title === "string" && job.title.trim()
            ? job.title.trim()
            : emp.name + " · 团队协作";
        prepared.push({
          emp,
          input,
          title,
          executor: emp.cliRequirement === "required" ? "desktop" : "cloud",
        });
      }

      // 配额按本批总量检查：已有排队/执行中的任务 + 本批条数不能超过上限
      const active = await prisma.employeeTask.count({
        where: { userId, status: { in: ["queued", "running"] } },
      });
      if (active + prepared.length > TASK_CONCURRENCY_LIMIT) {
        throw new BadRequestException("派活过于频繁，请等当前任务完成");
      }

      const created: Array<{ taskId: string; employeeSlug: string; title: string }> = [];
      for (const item of prepared) {
        const task = (await prisma.employeeTask.create({
          data: {
            userId,
            employeeId: item.emp.id,
            title: item.title,
            input: item.input,
            status: "queued",
            executor: item.executor,
          },
        })) as TaskRow;
        created.push({ taskId: task.id, employeeSlug: item.emp.slug, title: item.title });
      }

      const waited = await waitForTasks(
        prisma,
        created.map((item) => item.taskId),
        maxWaitSeconds,
      );
      const results = created.map((item) => {
        const row = waited.byId.get(item.taskId);
        return {
          employeeSlug: item.employeeSlug,
          taskId: item.taskId,
          status: row?.status ?? "queued",
          outputText: taskOutput(row?.outputText, TEAM_OUTPUT_LIMIT),
        };
      });
      const done = results.filter((item) => isTerminal(item.status)).length;
      const data: Record<string, unknown> = {
        ok: true,
        created: created.length,
        done,
        timedOut: waited.timedOut,
        elapsedMs: waited.elapsedMs,
        results,
      };
      if (aggregate) {
        data.summary = await summarizeTeamRun(toolapi, phone, results);
      }
      return data;
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

    // 对应原版 IPC cron:update / cron:toggle：客户端定时任务页的「启用/停用」与「改时间」都走这里。
    // 逻辑与 employee-cron.service.ts 的 update() 保持同口径：只有表达式/时区真的变了、或从停用到启用，
    // 才把 nextRunAt 重算，避免用户只是改个 workflowKey 就把下次执行时间推乱。
    cron_update: async (ctx: CapabilityContext) => {
      const { userId, params } = ctx;
      const cronId = requireString(params.cronId, "cronId 必填");
      if (params.enabled !== undefined && typeof params.enabled !== "boolean") {
        throw new BadRequestException("enabled 不合法");
      }
      const cron = (await prisma.employeeCron.findFirst({
        where: { id: cronId, userId },
      })) as CronRow | null;
      if (!cron) throw new BadRequestException("定时器不存在");
      const cronExpr =
        params.cronExpr === undefined || params.cronExpr === null
          ? cron.cronExpr
          : requireString(params.cronExpr, "cronExpr 不合法");
      const timezone =
        params.timezone === undefined || params.timezone === null
          ? cron.timezone
          : requireString(params.timezone, "timezone 不合法");
      let workflowKey = cron.workflowKey;
      if (params.workflowKey !== undefined) {
        workflowKey = requireString(params.workflowKey, "workflowKey 不合法");
      }
      const enabled = typeof params.enabled === "boolean" ? params.enabled : cron.enabled;
      const changed = cronExpr !== cron.cronExpr || timezone !== cron.timezone || (enabled && !cron.enabled);
      const nextRunAt = changed ? nextDate(cronExpr, timezone, new Date()) : cron.nextRunAt ?? nextDate(cronExpr, timezone, new Date());
      const updated = (await prisma.employeeCron.update({
        where: { id: cron.id },
        data: { cronExpr, timezone, workflowKey, enabled, ...(changed ? { nextRunAt } : {}) },
      })) as CronRow;
      return {
        cronId: updated.id,
        enabled: updated.enabled,
        cronExpr: updated.cronExpr,
        timezone: updated.timezone,
        nextRunAt: toIso(updated.nextRunAt),
      };
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
