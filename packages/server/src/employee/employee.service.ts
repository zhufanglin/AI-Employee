import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PackageService } from "./package.service";
import { randomUUID } from "node:crypto";

/** 任务状态机：queued -> running -> succeeded/failed/needs_input/awaiting_approval */
export const TASK_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "needs_input",
  "awaiting_approval",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const TERMINAL: TaskStatus[] = ["succeeded", "failed"];

export interface CatalogQuery {
  category?: string;
  tier?: string;
  q?: string;
}

export interface TaskQuery {
  status?: string;
  employeeId?: string;
  page?: string | number;
  limit?: string | number;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value as T;
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

@Injectable()
export class EmployeeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly packages: PackageService,
  ) {}

  // ---------- 目录 ----------
  private serializeEmployee(row: any) {
    // skillMd 体积大（数 KB/条），只在 detail() 与任务拉取时返回，列表接口一律剔除
    const { skillMd: _skillMd, ...rest } = row || {};
    return {
      ...rest,
      tags: parseJson(row.tags, []),
      capabilities: parseJson(row.capabilities, []),
      kpi: parseJson(row.kpi, []),
      tools: parseJson(row.tools, []),
      skillSlugs: parseJson(row.skillSlugs, []),
      cronPresets: parseJson(row.cronPresets, []),
    };
  }

  async catalog(query: CatalogQuery) {
    const where: any = { isActive: true };
    if (query.category) where.category = query.category;
    if (query.tier) where.tier = query.tier;
    if (query.q) {
      where.OR = [
        { name: { contains: query.q } },
        { title: { contains: query.q } },
        { description: { contains: query.q } },
        { slug: { contains: query.q } },
      ];
    }
    const rows = await this.prisma.aiEmployee.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    const items = rows.map((r) => this.serializeEmployee(r));
    const categories = Array.from(new Set(items.map((r) => r.category).filter(Boolean)));
    return { items, total: items.length, categories };
  }

  private async requireEmployee(slug: string) {
    const emp = await this.prisma.aiEmployee.findUnique({ where: { slug } });
    if (!emp || !emp.isActive) throw new NotFoundException("员工不存在或已下架");
    return emp;
  }

  // ---------- 安装 / 卸载 / 我的 ----------
  async install(userId: string, slug: string, body: any = {}) {
    const emp = await this.requireEmployee(slug);
    await this.packages.assertAccess(userId, (emp as any).requiredPackage);
    const now = new Date();
    // 到期时间由服务端唯一决定：客户端传 days / expiresAt 一律忽略（防止自行延长授权）
    const purchase = await this.prisma.aiEmployeePurchase.findUnique({
      where: { userId_employeeId: { userId, employeeId: emp.id } },
    });
    const purchaseActive =
      !!purchase &&
      purchase.status === "active" &&
      (!purchase.expiresAt || purchase.expiresAt.getTime() > now.getTime());
    let expiresAt: Date | null = null;
    if (emp.isBundled || emp.price <= 0) {
      expiresAt = null; // 预装/免费员工永久有效
    } else if (purchaseActive) {
      expiresAt = purchase!.expiresAt ?? null;
    } else {
      throw new ForbiddenException("员工未购买或已到期，请先下单购买");
    }
    const workspacePath =
      typeof body.workspacePath === "string" && body.workspacePath.length > 0 ? body.workspacePath : null;

    const install = await this.prisma.aiEmployeeInstall.upsert({
      where: { userId_employeeId: { userId, employeeId: emp.id } },
      update: {
        version: emp.skillVersion,
        enabled: true,
        expiresAt,
        ...(workspacePath ? { workspacePath } : {}),
      },
      create: {
        userId,
        employeeId: emp.id,
        version: emp.skillVersion,
        enabled: true,
        expiresAt,
        workspacePath,
      },
    });
    return { install, employee: this.serializeEmployee(emp) };
  }

  async uninstall(userId: string, slug: string) {
    const emp = await this.requireEmployee(slug);
    const res = await this.prisma.aiEmployeeInstall.deleteMany({ where: { userId, employeeId: emp.id } });
    return { success: true, removed: res.count > 0 };
  }

  async mine(userId: string) {
    const installs = await this.prisma.aiEmployeeInstall.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
    });
    const ids = installs.map((i) => i.employeeId);
    const employees = await this.prisma.aiEmployee.findMany({ where: { id: { in: ids } } });
    const byId = new Map(employees.map((e) => [e.id, e]));
    const now = Date.now();
    const items = installs
      .filter((i) => byId.has(i.employeeId))
      .map((i) => {
        const emp = byId.get(i.employeeId)!;
        const expired = !!i.expiresAt && i.expiresAt.getTime() <= now;
        return {
          ...this.serializeEmployee(emp),
          install: { ...i, expired, effectiveEnabled: i.enabled && !expired },
        };
      });
    return {
      items,
      total: items.length,
      installedCount: items.filter((i) => i.install.effectiveEnabled).length,
    };
  }

  async detail(slug: string) {
    const emp = await this.requireEmployee(slug);
    return { ...this.serializeEmployee(emp), skillMd: (emp as any).skillMd ?? null };
  }

  async getTask(userId: string, id: string) {
    const task = await this.findOwnTask(userId, id);
    const [withArtifacts] = await this.attachArtifacts([task]);
    return withArtifacts;
  }

  // ---------- 任务 ----------
  private async attachArtifacts(tasks: any[]) {
    if (tasks.length === 0) return tasks;
    const artifacts = await this.prisma.employeeTaskArtifact.findMany({
      where: { taskId: { in: tasks.map((t) => t.id) } },
      orderBy: { createdAt: "asc" },
    });
    const byTask = new Map<string, any[]>();
    for (const a of artifacts) {
      const list = byTask.get(a.taskId) || [];
      list.push(a);
      byTask.set(a.taskId, list);
    }
    return tasks.map((t) => ({ ...t, artifacts: byTask.get(t.id) || [] }));
  }

  async run(userId: string, slug: string, body: any = {}) {
    const emp = await this.requireEmployee(slug);
    await this.packages.assertAccess(userId, (emp as any).requiredPackage);
    const install = await this.prisma.aiEmployeeInstall.findUnique({
      where: { userId_employeeId: { userId, employeeId: emp.id } },
    });
    const nowMs = Date.now();
    let expired = !install || !install.enabled || !!(install.expiresAt && install.expiresAt.getTime() <= nowMs);
    if (!expired && !emp.isBundled && emp.price > 0) {
      // 付费员工以购买记录为准（管理员/回调可能缩短或延长授权），不信任安装时的快照
      const purchase = await this.prisma.aiEmployeePurchase.findUnique({
        where: { userId_employeeId: { userId, employeeId: emp.id } },
      });
      const purchaseActive =
        !!purchase &&
        purchase.status === "active" &&
        (!purchase.expiresAt || purchase.expiresAt.getTime() > nowMs);
      expired = !purchaseActive;
    }
    if (expired) throw new ForbiddenException("员工未安装或授权已过期");
    const executor =
      body.executor === "cloud" || body.executor === "desktop"
        ? body.executor
        : emp.cliRequirement === "required"
          ? "desktop"
          : "cloud";
    const runAt = body.runAt ? new Date(body.runAt) : new Date();
    if (Number.isNaN(runAt.getTime())) throw new BadRequestException("runAt 不是合法日期");
    const task = await this.prisma.employeeTask.create({
      data: {
        userId,
        employeeId: emp.id,
        title:
          typeof body.title === "string" && body.title.trim()
            ? body.title.trim()
            : emp.name + " · 一次性任务",
        input: body.input ?? null,
        status: "queued",
        executor,
        runAt,
      },
    });
    return { ...task, artifacts: [] };
  }

  async listTasks(userId: string, query: TaskQuery) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const where: any = { userId };
    if (query.status) {
      if (!TASK_STATUSES.includes(query.status as TaskStatus)) {
        throw new BadRequestException("status 不合法");
      }
      where.status = query.status;
    }
    if (query.employeeId) where.employeeId = query.employeeId;
    const [rows, total] = await Promise.all([
      this.prisma.employeeTask.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.employeeTask.count({ where }),
    ]);
    return {
      items: await this.attachArtifacts(rows),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  private stallMs() {
    const minutes = Number(process.env.EMPLOYEE_TASK_STALL_MINUTES || 10);
    return Math.max(1, Number.isFinite(minutes) ? minutes : 10) * 60_000;
  }

  /**
   * 执行节点失联兜底：running 超过阈值未回写的任务，前两次重新排队，第三次判失败。
   * 由 pull 入口与 /employee-execution/recover 调用（无独立调度器，避免多实例重复跑）。
   */
  async recoverStalledTasks(userId?: string) {
    const where: any = { status: "running", updatedAt: { lt: new Date(Date.now() - this.stallMs()) } };
    if (userId) where.userId = userId;
    const rows = await this.prisma.employeeTask.findMany({ where, take: 50 });
    let requeued = 0;
    let failed = 0;
    for (const row of rows) {
      const meta = parseJson<Record<string, any>>(row.outputMeta, {}) || {};
      const attempts = Number(meta.requeued) || 0;
      if (attempts < 2) {
        const changed = await this.prisma.employeeTask.updateMany({
          where: { id: row.id, status: "running", updatedAt: row.updatedAt },
          data: {
            status: "queued",
            startedAt: null,
            error: "执行节点超时未回写，已重新排队",
            outputMeta: { ...meta, requeued: attempts + 1, requeuedAt: new Date().toISOString() },
          },
        });
        requeued += changed.count;
      } else {
        const changed = await this.prisma.employeeTask.updateMany({
          where: { id: row.id, status: "running", updatedAt: row.updatedAt },
          data: { status: "failed", finishedAt: new Date(), error: "执行节点多次超时未回写，任务失败" },
        });
        failed += changed.count;
      }
    }
    return { scanned: rows.length, requeued, failed };
  }

  /** 桌面端长轮询拉取：只取端上执行、已到点的 queued 任务，并原子置为 running */
  async pullTasks(userId: string, limitRaw?: string | number) {
    await this.recoverStalledTasks(userId);
    const limit = Math.min(3, Math.max(1, Number(limitRaw) || 1));
    const now = new Date();
    const candidates = await this.prisma.employeeTask.findMany({
      where: { userId, executor: "desktop", status: "queued", runAt: { lte: now } },
      orderBy: { runAt: "asc" },
      take: limit,
      select: { id: true, outputMeta: true },
    });
    const ids = candidates.map((c) => c.id);
    if (ids.length === 0) return { items: [], count: 0 };
    const claimed: string[] = [];
    for (const id of ids) {
      const current = candidates.find(item => item.id === id);
      const meta = parseJson<Record<string, any>>(current?.outputMeta, {}) || {};
      const result = await this.prisma.employeeTask.updateMany({ where: { id, userId, executor: "desktop", status: "queued" }, data: { status: "running", startedAt: now, outputMeta: { ...meta, claimToken: randomUUID() } } });
      if (result.count) claimed.push(id);
    }
    const rows = await this.prisma.employeeTask.findMany({
      where: { id: { in: claimed } },
      orderBy: { runAt: "asc" },
    });
    // 执行器需要技能原文：随任务一起下发 employeeSkillMd（每任务所属员工各一份）
    const employeeIds = Array.from(new Set(rows.map((r: any) => r.employeeId).filter(Boolean)));
    const skills = employeeIds.length
      ? await this.prisma.aiEmployee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, skillMd: true } })
      : [];
    const skillByEmp = new Map(skills.map((s) => [s.id, s.skillMd ?? null]));
    const items = (await this.attachArtifacts(rows)).map((task: any) => ({
      ...task,
      employeeSkillMd: skillByEmp.get(task.employeeId) ?? null,
    }));
    return { items, count: items.length };
  }

  private async findOwnTask(userId: string, id: string) {
    const task = await this.prisma.employeeTask.findUnique({ where: { id } });
    if (!task) throw new NotFoundException("任务不存在");
    if (task.userId !== userId) throw new ForbiddenException("无权操作该任务");
    return task;
  }

  async updateTask(userId: string, id: string, body: any = {}) {
    const task = await this.findOwnTask(userId, id);
    if (TERMINAL.includes(task.status as TaskStatus)) {
      throw new BadRequestException("任务已结束，不能再修改");
    }
    const data: any = {};
    if (body.status !== undefined) {
      if (!TASK_STATUSES.includes(body.status)) throw new BadRequestException("status 不合法");
      data.status = body.status;
      if (body.status === "running" && !task.startedAt) data.startedAt = new Date();
      if (TERMINAL.includes(body.status)) data.finishedAt = new Date();
    }
    for (const key of ["outputKind", "outputText", "outputPath", "error"]) {
      if (body[key] !== undefined) data[key] = body[key];
    }
    if (body.outputMeta !== undefined) data.outputMeta = body.outputMeta;
    if (body.creditsCharged !== undefined) {
      const n = Number(body.creditsCharged);
      if (!Number.isFinite(n) || n < 0) throw new BadRequestException("creditsCharged 不合法");
      data.creditsCharged = Math.floor(n);
    }
    const rows = Array.isArray(body.artifacts) ? body.artifacts
        .filter((a: any) => a && typeof a === "object")
        .map((a: any) => ({
          taskId: id,
          kind: typeof a.kind === "string" ? a.kind : "text",
          path: a.path ?? null,
          url: a.url ?? null,
          text: a.text ?? null,
          mime: a.mime ?? null,
        })) : [];
    const updated = await this.prisma.$transaction(async tx => {
      if (body.claimToken !== undefined) {
        if (typeof body.claimToken !== 'string' || !body.claimToken) throw new BadRequestException('任务领取凭据无效');
        const changed = await tx.employeeTask.updateMany({ where: { id, userId, status: 'running', outputMeta: { path: '$.claimToken', equals: body.claimToken } }, data });
        if (!changed.count) throw new BadRequestException('任务领取已失效');
      } else if (Object.keys(data).length) await tx.employeeTask.update({ where: { id }, data });
      if (rows.length) await tx.employeeTaskArtifact.createMany({ data: rows });
      return tx.employeeTask.findUniqueOrThrow({ where: { id } });
    });
    const [withArtifacts] = await this.attachArtifacts([updated]);
    return withArtifacts;
  }

  private async review(userId: string, id: string, approve: boolean, reason?: string) {
    const task = await this.findOwnTask(userId, id);
    if (task.status !== "awaiting_approval") {
      throw new BadRequestException("只有待验收任务可以审批");
    }
    const meta = (parseJson(task.outputMeta, {}) as Record<string, unknown>) || {};
    const updated = await this.prisma.employeeTask.update({
      where: { id },
      data: {
        status: approve ? "succeeded" : "failed",
        finishedAt: new Date(),
        outputMeta: { ...meta, approved: approve, reviewReason: reason ?? null, reviewedAt: new Date().toISOString() },
        ...(approve ? {} : { error: reason || "验收驳回" }),
      },
    });
    const [withArtifacts] = await this.attachArtifacts([updated]);
    return withArtifacts;
  }

  approve(userId: string, id: string, body: any = {}) {
    return this.review(userId, id, true, body.reason);
  }

  reject(userId: string, id: string, body: any = {}) {
    return this.review(userId, id, false, body.reason);
  }
}
