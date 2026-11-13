import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ToolapiService } from "../toolapi/toolapi.service";
import { resolvePhone } from "../common/owner";
import type { CapabilityDescriptor, CapabilityHandler, CapabilityResult } from "./capability.types";
import { descriptor as webExtractDescriptor, handler as webExtractHandler } from "./capabilities/web-extract";
import { contentDescriptors, buildContentHandlers } from "./capabilities/content";
import { customerDescriptors, buildCustomerHandlers } from "./capabilities/customer";
import { llmDescriptors, buildLlmHandlers } from "./capabilities/llm";
import { descriptor as searchDescriptor, handler as searchHandler } from "./capabilities/search";
import { descriptor as webBatchDescriptor, handler as webBatchHandler } from "./capabilities/web-batch";
import { descriptor as sourceCheckDescriptor, handler as sourceCheckHandler } from "./capabilities/source-check";
import { descriptors as fileDescriptors, handlers as fileHandlers } from "./capabilities/files";
import { descriptors as docDescriptors, handlers as docHandlers } from "./capabilities/docs";
import { descriptors as docWriteDescriptors, handlers as docWriteHandlers } from "./capabilities/docs-write";
import { descriptors as mediaDescriptors, handlers as mediaHandlers } from "./capabilities/media-tools";
import { descriptors as asrDescriptors, handlers as asrHandlers } from "./capabilities/asr";
import { descriptors as visionDescriptors, buildVisionHandlers } from "./capabilities/vision";
import { descriptors as employeeDescriptors, buildEmployeeHandlers } from "./capabilities/employee-tools";
import { descriptors as memoryDescriptors, buildMemoryHandlers } from "./capabilities/memory-tools";
import { descriptors as memoryMaintenanceDescriptors, buildMemoryMaintenanceHandlers } from "./capabilities/memory-maintenance";
import { descriptors as platformDescriptors, buildPlatformHandlers } from "./capabilities/platform-tools";
import { ProvidersService } from "../providers/providers.service";
import { descriptor as platformMetricsDescriptor, handler as platformMetricsHandler } from "./platform-metrics";

/**
 * 能力层：原版 agent-tool-box 的 36 个 .pyc 原子能力的明文本地重写。
 * 契约与原版一致：一条能力名 + 一个 params 对象 → { success, data, error, error_code }。
 */
@Injectable()
export class CapabilityService {
  private readonly logger = new Logger(CapabilityService.name);
  private readonly descriptors: CapabilityDescriptor[] = [webExtractDescriptor, webBatchDescriptor, sourceCheckDescriptor, ...contentDescriptors, ...customerDescriptors, ...llmDescriptors, searchDescriptor, ...fileDescriptors, ...docDescriptors, ...docWriteDescriptors, ...mediaDescriptors, ...asrDescriptors, ...visionDescriptors, ...employeeDescriptors, ...memoryDescriptors, ...memoryMaintenanceDescriptors, ...platformDescriptors, platformMetricsDescriptor];
  private readonly handlers: Record<string, CapabilityHandler>;

  constructor(private readonly prisma: PrismaService, private readonly toolapi: ToolapiService, private readonly providers: ProvidersService) {
    this.handlers = {
      web_extract: webExtractHandler,
      ...buildContentHandlers(toolapi, prisma),
      ...buildCustomerHandlers(toolapi),
      ...buildLlmHandlers(toolapi),
      web_search: searchHandler,
      web_batch: webBatchHandler,
      source_check: sourceCheckHandler,
      ...fileHandlers,
      ...docHandlers,
      ...docWriteHandlers,
      ...mediaHandlers,
      ...asrHandlers,
      ...buildVisionHandlers(providers),
      ...buildEmployeeHandlers(prisma, toolapi),
      ...buildMemoryHandlers(prisma, providers),
      ...buildMemoryMaintenanceHandlers(prisma, providers),
      ...buildPlatformHandlers(),
      platform_metrics_parse: platformMetricsHandler,
    } as Record<string, CapabilityHandler>;
  }

  list(): CapabilityDescriptor[] {
    return this.descriptors;
  }

  async run(user: { id: string; phone?: string | null }, name: string, params: Record<string, any>): Promise<CapabilityResult> {
    const handler = this.handlers[name];
    if (!handler) throw new NotFoundException(`能力不存在: ${name}`);
    const phone = (await resolvePhone(this.prisma, user).catch(() => null)) ?? null;
    const startedAt = Date.now();
    try {
      const data = await handler({ userId: user.id, phone, params: params || {} });
      this.logger.log(`capability ${name} ok ${Date.now() - startedAt}ms user=${user.id}`);
      return { success: true, data, error: null };
    } catch (error) {
      const message = this.errorMessage(error);
      const code = String((error as any)?.constructor?.name || (error as any)?.getStatus ? "HttpException" : "Error");
      this.logger.warn(`capability ${name} failed: ${message}`);
      return { success: false, data: null, error: message, error_code: code };
    }
  }

  /** Nest 的 HttpException 常带结构化 response（如 { error: { message } }），message 本身只是 "Bad Gateway Exception"，这里把真正的说明捞出来。 */
  private errorMessage(error: unknown): string {
    const resp = (error as any)?.getResponse?.();
    if (resp && typeof resp === "object") {
      const nested = (resp as any).error?.message || (resp as any).message;
      if (typeof nested === "string" && nested.trim()) return nested;
      if (Array.isArray(nested) && nested.length) return nested.join("; ");
    }
    return error instanceof Error ? error.message : String(error);
  }

  async runStrict(user: { id: string; phone?: string | null }, name: string, params: Record<string, any>) {
    if (!Object.prototype.hasOwnProperty.call(this.handlers, name)) throw new BadRequestException(`能力不存在: ${name}`);
    return this.run(user, name, params);
  }
}
