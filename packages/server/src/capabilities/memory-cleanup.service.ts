import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CapabilityService } from "./capability.service";

/**
 * P22 记忆清理定时任务。
 *
 * 目标：不用人工记得跑，每周日凌晨自动把存量重复记忆收一遍（默认 apply）。
 *
 * 设计取舍：
 * - 不引入 @nestjs/schedule / node-cron：只有一个固定周期的任务，用 setTimeout 自排程足够，
 *   少一个生产依赖（生产装依赖踩过 prune 的坑）。
 * - 只处理「记忆条数 ≥ MEMORY_CLEANUP_MIN_ROWS」的用户：几条记忆的账号没必要每周打一次模型。
 * - 复用 CapabilityService.run 调 memory_dedupe，保证「定时」和「手动」走完全相同的判定与合并逻辑。
 * - 单用户失败只记日志、不中断；下一周会再试（清理本身幂等，重复跑不会多删）。
 */

const WEEK_MS = 7 * 86400000;
const DAY_MS = 86400000;
/** 中国自 1991 年起不实行夏令时，固定 +8 即可 */
const SHANGHAI_OFFSET_MS = 8 * 3600000;

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

/**
 * 下一个「周日 hour:00（Asia/Shanghai）」对应的 UTC 时刻。
 * 例：now = 2026-11-08 02:00（上海，周日）→ 2026-11-08 03:00（上海）
 *     now = 2026-11-08 04:00（上海，周日）→ 2026-11-15 03:00（上海）
 */
export function nextWeeklyRun(now: Date, hour = 3): Date {
  const wallMs = now.getTime() + SHANGHAI_OFFSET_MS;
  const wall = new Date(wallMs);
  const weekday = wall.getUTCDay(); // 0 = 周日
  const todayAtHour = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), hour, 0, 0, 0);
  let daysAhead = (7 - weekday) % 7;
  if (daysAhead === 0 && wallMs >= todayAtHour) daysAhead = 7;
  const target = todayAtHour + daysAhead * DAY_MS - SHANGHAI_OFFSET_MS;
  return new Date(target);
}

export type MemoryCleanupRun = {
  at: string;
  reason: string;
  users: number;
  applied: number;
  proposals: number;
  failed: number;
  durationMs: number;
};

@Injectable()
export class MemoryCleanupService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MemoryCleanupService.name);
  private timer: NodeJS.Timeout | null = null;
  private nextAt: Date | null = null;
  private lastRun: MemoryCleanupRun | null = null;

  constructor(private readonly prisma: PrismaService, private readonly capabilities: CapabilityService) {}

  private get enabled(): boolean {
    return envFlag("MEMORY_CLEANUP_ENABLED", true);
  }

  private get hour(): number {
    const value = envInt("MEMORY_CLEANUP_HOUR", 3);
    return value >= 0 && value <= 23 ? value : 3;
  }

  private get mode(): string {
    return process.env.MEMORY_CLEANUP_MODE === "report" ? "report" : "apply";
  }

  private get limit(): number {
    const value = envInt("MEMORY_CLEANUP_LIMIT", 60);
    return value >= 1 && value <= 60 ? value : 60;
  }

  private get minRows(): number {
    const value = envInt("MEMORY_CLEANUP_MIN_ROWS", 20);
    return value >= 0 ? value : 20;
  }

  onApplicationBootstrap() {
    if (!this.enabled) {
      this.logger.log("记忆清理定时任务已关闭（MEMORY_CLEANUP_ENABLED=0）");
      return;
    }
    this.arm();
  }

  onApplicationShutdown() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  status() {
    return {
      enabled: this.enabled,
      schedule: "每周日 " + String(this.hour).padStart(2, "0") + ":00（Asia/Shanghai）",
      mode: this.mode,
      limit: this.limit,
      minRows: this.minRows,
      nextAt: this.nextAt ? this.nextAt.toISOString() : null,
      lastRun: this.lastRun,
    };
  }

  private arm() {
    const now = new Date();
    const next = nextWeeklyRun(now, this.hour);
    const delay = Math.max(1000, next.getTime() - now.getTime());
    this.nextAt = next;
    this.logger.log(
      "记忆清理已排程：每周日 " +
        String(this.hour).padStart(2, "0") +
        ":00（Asia/Shanghai），下次 " +
        next.toISOString() +
        "（约 " +
        Math.round(delay / 60000) +
        " 分钟后，mode=" +
        this.mode +
        "，limit=" +
        this.limit +
        "）",
    );
    this.timer = setTimeout(() => {
      this.runOnce("每周定时")
        .catch((error) => this.logger.warn("记忆清理定时任务异常：" + (error?.message ?? error)))
        .finally(() => {
          if (this.enabled) this.arm();
        });
    }, delay);
    // 不阻止进程退出（systemd 停服务时能立刻退出）
    (this.timer as any).unref?.();
  }

  /** 跑一轮：按用户分别执行 memory_dedupe，单个用户失败不影响其他人 */
  async runOnce(reason = "手动", modeOverride?: string): Promise<MemoryCleanupRun | null> {
    if (!this.enabled) {
      this.logger.log("记忆清理已关闭，跳过本次（" + reason + "）");
      return null;
    }
    const startedAt = Date.now();
    // Prisma 6 的 groupBy 类型不接受仅 _count 的参数组合，这里放宽为 any（运行期正常）
    const groups: any[] = await (this.prisma.agentMemory as any).groupBy({ by: ["userId"], _count: { _all: true } });
    const targets = groups
      .map((group) => ({
        userId: String(group.userId),
        total: typeof group._count === "number" ? group._count : Number(group._count?._all ?? 0),
      }))
      .filter((item) => item.total >= this.minRows)
      .map((item) => item.userId);

    let applied = 0;
    let proposals = 0;
    let failed = 0;
    for (const userId of targets) {
      try {
        const mode = modeOverride === "report" ? "report" : modeOverride === "apply" ? "apply" : this.mode;
        const result = await this.capabilities.run({ id: userId }, "memory_dedupe", { mode, limit: this.limit });
        if (!result.success) {
          failed += 1;
          this.logger.warn("记忆清理失败 user=" + userId + "：" + (result.error || "未知错误"));
        } else {
          const data: any = result.data || {};
          applied += Number(data.applied || 0);
          proposals += Array.isArray(data.proposals) ? data.proposals.length : 0;
        }
      } catch (error: any) {
        failed += 1;
        this.logger.warn("记忆清理异常 user=" + userId + "：" + (error?.message ?? error));
      }
      // 用户之间稍作间隔，避免同一时刻对上游并发打满
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const run: MemoryCleanupRun = {
      at: new Date().toISOString(),
      reason,
      users: targets.length,
      applied,
      proposals,
      failed,
      durationMs: Date.now() - startedAt,
    };
    this.lastRun = run;
    this.logger.log(
      "记忆清理完成（" +
        reason +
        "）：用户 " +
        run.users +
        "，合并 " +
        run.applied +
        "，重复候选 " +
        run.proposals +
        "，失败 " +
        run.failed +
        "，耗时 " +
        run.durationMs +
        "ms",
    );
    return run;
  }
}
