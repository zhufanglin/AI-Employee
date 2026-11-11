import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { EmployeeOrderService } from "./employee-order.service";
import { EmployeeService } from "./employee.service";

/**
 * P43 P1：员工授权到期与未支付订单的自动扫描。
 *
 * 背景：原版 `dist/employee/employee-expiry.scheduler.js:44-55` 是服务端常驻定时器，
 * 复刻此前只有 `POST /admin/employee-orders/expire-scan` 手动入口 —— 没人点就永远不扫，
 * 导致 AiEmployeePurchase 停在 active、pending 订单越积越多（列表里显示「已过期」靠的是读时计算）。
 *
 * 设计取舍（与 P22 MemoryCleanupService 一致）：
 * - 不引入 @nestjs/schedule / node-cron：只有一个等间隔任务，setTimeout 自排程足够，
 *   少一个生产依赖（生产装依赖踩过 npm prune 的坑）。
 * - 启动时先扫一次：把停机期间过期的补掉，不必等第一个周期。
 * - 扫描本身幂等（updateMany 条件里带 status），重复跑不会多改。
 * - 关掉用 EMPLOYEE_EXPIRY_ENABLED=0；周期用 EMPLOYEE_EXPIRY_INTERVAL_MIN（默认 10 分钟）。
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return !["0", "false", "off", "no"].includes(String(raw).trim().toLowerCase());
}

export type EmployeeExpiryRun = {
  at: string;
  reason: string;
  expiredPurchases: number;
  closedOrders: number;
  /** P43 P1：超过审批时限被自动通过的任务数 */
  autoApproved: number;
  durationMs: number;
};

@Injectable()
export class EmployeeExpiryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(EmployeeExpiryService.name);
  private timer: NodeJS.Timeout | null = null;
  private nextAt: Date | null = null;
  private lastRun: EmployeeExpiryRun | null = null;
  private stopped = false;

  constructor(
    private readonly orders: EmployeeOrderService,
    private readonly employees: EmployeeService,
  ) {}

  private get enabled(): boolean {
    return envFlag("EMPLOYEE_EXPIRY_ENABLED", true);
  }

  private get intervalMin(): number {
    const value = envInt("EMPLOYEE_EXPIRY_INTERVAL_MIN", 10);
    return value >= 1 ? value : 10;
  }

  /**
   * 审批超时自动通过（P43 P1）：默认 0 = 关闭，行为与原版一致（原版没有审批机制）。
   * 开着时，超过 N 小时没人验收的任务自动置 succeeded 并打 autoApproved 标记，
   * 避免渠道回推的长任务永远悬在 awaiting_approval。
   */
  private get approvalTimeoutHours(): number {
    const value = envInt("EMPLOYEE_APPROVAL_TIMEOUT_HOURS", 0);
    return value > 0 ? value : 0;
  }

  onApplicationBootstrap() {
    if (!this.enabled) {
      this.logger.log("员工到期扫描已关闭（EMPLOYEE_EXPIRY_ENABLED=0）");
      return;
    }
    // 启动先扫一次，把停机期间过期的授权/订单补掉
    this.runOnce("启动时扫描")
      .catch((error) => this.logger.warn("员工到期扫描（启动）异常：" + (error?.message ?? error)))
      .finally(() => {
        if (!this.stopped && this.enabled) this.arm();
      });
  }

  onApplicationShutdown() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  status() {
    return {
      enabled: this.enabled,
      intervalMin: this.intervalMin,
      schedule: "每 " + this.intervalMin + " 分钟",
      approvalTimeoutHours: this.approvalTimeoutHours,
      nextAt: this.nextAt ? this.nextAt.toISOString() : null,
      lastRun: this.lastRun,
    };
  }

  private arm() {
    if (this.stopped) return;
    const delay = this.intervalMin * 60000;
    this.nextAt = new Date(Date.now() + delay);
    this.timer = setTimeout(() => {
      this.runOnce("定时扫描")
        .catch((error) => this.logger.warn("员工到期扫描异常：" + (error?.message ?? error)))
        .finally(() => {
          if (!this.stopped && this.enabled) this.arm();
        });
    }, delay);
    // 不阻止进程退出（systemd 停服务时能立刻退出）
    (this.timer as any).unref?.();
  }

  /** 扫一轮：过期授权置 expired、超时未支付订单置 closed。 */
  async runOnce(reason = "手动"): Promise<EmployeeExpiryRun | null> {
    if (!this.enabled) {
      this.logger.log("员工到期扫描已关闭，跳过本次（" + reason + "）");
      return null;
    }
    const startedAt = Date.now();
    const result = await this.orders.expireEmployees();
    // 审批超时自动通过（默认关闭）
    let autoApproved = 0;
    if (this.approvalTimeoutHours > 0) {
      try {
        autoApproved = await this.employees.autoApproveOverdue(this.approvalTimeoutHours);
      } catch (error: any) {
        this.logger.warn("审批超时自动通过失败：" + (error?.message ?? error));
      }
    }
    const run: EmployeeExpiryRun = {
      at: new Date().toISOString(),
      reason,
      expiredPurchases: Number(result?.expiredPurchases || 0),
      closedOrders: Number(result?.closedOrders || 0),
      autoApproved,
      durationMs: Date.now() - startedAt,
    };
    this.lastRun = run;
    if (run.expiredPurchases > 0 || run.closedOrders > 0 || run.autoApproved > 0) {
      this.logger.log(
        "员工到期扫描（" + reason + "）：过期授权 " + run.expiredPurchases + " 条，关闭超时订单 " + run.closedOrders + " 条，自动通过审批 " + run.autoApproved + " 条",
      );
    }
    return run;
  }
}
