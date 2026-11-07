# P17 员工派活 + 定时任务能力（employee-tools）

新增能力目录项与 handler 工厂，供 AI 员工在工具循环里调用「给别的员工派活」与「给自己加/查/删定时任务」。

- 实现文件：`packages/server/src/capabilities/capabilities/employee-tools.ts`
- 冒烟脚本：`scripts/smoke-p17-employee-tools.mjs`
- 未改动任何既有文件（注册由 lead 接线）。

## 一、能力表

所有 handler 抛错统一为 `BadRequestException("中文原因")`，能力层 `CapabilityService.run` 会把它归一成
`{ success:false, data:null, error, error_code:"BadRequestException" }`。所有返回字段为驼峰，时间字段统一 ISO 字符串。

### 1. employee_dispatch —— 给另一个员工派活

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `employeeSlug` | 是 | 目标员工 slug |
| `input` | 是 | 交给该员工的需求文本 |
| `title` | 否 | 任务标题，默认 `员工名 + " · 派活"` |
| `parentEmployeeSlug` | 否 | 当前员工 slug；与目标 slug 相同会被拒绝（防自派活） |

行为：按 slug 找 `AiEmployee`（要求 `isActive`）→ 校验安装/授权（口径同 `EmployeeService.run`）→
统计当前用户 `queued/running` 任务数（上限 5）→ 创建 `EmployeeTask`（`status=queued`，
`executor = emp.cliRequirement === "required" ? "desktop" : "cloud"`）。

返回：

```json
{ "taskId": "…", "employee": { "slug": "…", "name": "…" }, "status": "queued", "executor": "cloud" }
```

错误：`employeeSlug 必填` / `input 必填` / `parentEmployeeSlug 不合法` / `员工不存在或已下架` /
`员工未安装或授权已过期` / `不能给自己派活` / `派活过于频繁，请等当前任务完成`。

### 2. employee_task_status —— 查任务进度

参数：`taskId`（必填）。

行为：`employeeTask.findUnique({ id })` 后校验 `task.userId === 当前 userId`；不匹配或不存在的任务一律
抛 `任务不存在`（不泄露他人任务是否存在）。附件按 `createdAt` 升序。

返回：

```json
{
  "taskId": "…",
  "status": "queued|running|succeeded|failed|needs_input|awaiting_approval",
  "title": "…",
  "employee": { "slug": "…", "name": "…" },
  "outputText": "截断到 4000 字",
  "artifacts": [{ "kind": "text", "url": null, "text": "截断到 300 字" }],
  "error": null,
  "createdAt": "2026-11-01T02:00:00.000Z",
  "finishedAt": null
}
```

错误：`taskId 必填` / `任务不存在`。

### 3. cron_create —— 给员工创建定时任务

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `employeeSlug` | 是 | 员工 slug |
| `cronExpr` | 是 | 标准 cron 表达式（5 段） |
| `timezone` | 否 | 默认 `Asia/Shanghai` |
| `workflowKey` | 否 | 默认 `default` |
| `title` | 否 | 见下方「已知限制」 |

行为：找 `AiEmployee`（`isActive`）→ 校验安装（口径同 `EmployeeCronService.create`：`install.enabled` 且
未过期）→ 用与 `employee-cron.service.ts` 一致的 `nextDate`（`CronTime(expr, zone).getNextDateFrom`）计算
`nextRunAt` → 创建 `EmployeeCron`（`enabled=true`）。

返回：

```json
{ "cronId": "…", "nextRunAt": "2026-11-08T01:00:00.000Z", "cronExpr": "0 9 * * *", "timezone": "Asia/Shanghai", "employee": { "slug": "…", "name": "…" } }
```

错误：`employeeSlug 必填` / `cronExpr 必填` / `timezone 不合法` / `员工不存在或已下架` /
`员工未安装或授权已过期` / `cronExpr 或 timezone 不合法`。

### 4. cron_list —— 我的定时任务

参数：无（`{}`）。

行为：只查当前 `userId` 的 `EmployeeCron`，按 `nextRunAt` 升序；员工信息批量查 `AiEmployee` 后映射。

返回：

```json
{
  "items": [{
    "cronId": "…",
    "employee": { "slug": "…", "name": "…" },
    "cronExpr": "0 9 * * *",
    "timezone": "Asia/Shanghai",
    "enabled": true,
    "nextRunAt": "2026-11-08T01:00:00.000Z",
    "lastRunAt": null
  }],
  "total": 1
}
```

### 5. cron_delete —— 删除定时任务

参数：`cronId`（必填）。

行为：`findFirst({ id, userId })` 归属校验，不存在/不属于自己抛 `定时器不存在`；再 `deleteMany({ id, userId })`。

返回：`{ "cronId": "…", "deleted": true }`

错误：`cronId 必填` / `定时器不存在`。

## 二、安全边界

1. **越权隔离**：`employee_task_status` 与 `cron_delete` 都按 `userId` 过滤，他人资源一律按「不存在」处理，
   不返回 403，避免探测。
2. **派活并发上限**：同一用户同时存在的 `queued/running` 任务达到 5 条即拒绝，防止一个员工无限派生任务。
   统计的是该用户全部排队/执行中任务（不只派活产生的），偏保守；`succeeded/failed` 等终态不占额度。
3. **自派活防护**：`parentEmployeeSlug` 若等于目标 `employeeSlug` 直接拒绝；调用方未传时无法判断当前身份，
   由上层（工具循环）传入。
4. **权限口径与 `EmployeeService.run` 对齐**（有意复刻）：能力层只能拿到 `prisma`，拿不到 Nest 容器里的
   `EmployeeService` / `PackageService`，且任务要求不得修改 `employee.service.ts`，因此在本文件内用 prisma
   复刻同样的判定：
   - 安装记录存在、`enabled=true`、`expiresAt` 未过期；
   - 对 `!isBundled && price>0` 的付费员工，再以 `AiEmployeePurchase` 的 `status="active"` 且未过期为准
     （不信任安装时快照）。
   - **已知缺口**：`run` 里的 `PackageService.assertAccess(requiredPackage)`（团队套餐授权）没有复刻，
     能力层没有该 Service。需要套餐校验的员工仍应走原 `/employee` 接口，或后续给能力层注入
     `PackageService` 后再补。
5. **定时任务校验口径**：`cron_create` 与 `EmployeeCronService.create` 一致，只校验安装启用/未过期，
   不再查购买记录（原服务就是这样，保持一致优先）。
6. **时间与长度**：所有时间字段输出 ISO；`outputText` 截 4000 字、产物 `text` 截 300 字，避免把大文本
   塞回工具循环上下文。

## 三、已知限制

- `cron_create` 的 `title` 参数**不落库**：`EmployeeCron` 表没有 title 字段，而本任务禁止改
  `schema.prisma`。当前接受并忽略该参数；若后续要支持，需要迁移给 `EmployeeCron` 加列，再在
  `cron_create` 的 `data` 与 `cron_list` 的 items 中透出。
- `nextDate` 是 `employee-cron.service.ts` 的模块私有函数（未导出）。在不修改该文件的前提下，本文件
  内部复刻了逐字一致的实现（`CronTime` + 非法时间兜底 + 同一错误文案）。若将来该 helper 导出，可改为
  import 以消除重复。

## 四、如何注册（lead 需要改 `capability.service.ts`）

在既有 import 区（`media-tools` 那一行之后）加一行：

```ts
import { descriptors as employeeDescriptors, buildEmployeeHandlers } from "./capabilities/employee-tools";
```

在 `private readonly descriptors` 数组末尾展开：

```ts
private readonly descriptors: CapabilityDescriptor[] = [webExtractDescriptor, webBatchDescriptor, ...contentDescriptors, ...customerDescriptors, ...llmDescriptors, searchDescriptor, ...fileDescriptors, ...docDescriptors, ...docWriteDescriptors, ...mediaDescriptors, ...employeeDescriptors];
```

在构造函数的 `this.handlers` 对象末尾展开：

```ts
this.handlers = {
  web_extract: webExtractHandler,
  ...buildContentHandlers(toolapi, prisma),
  ...buildCustomerHandlers(toolapi),
  ...buildLlmHandlers(toolapi),
  web_search: searchHandler,
  web_batch: webBatchHandler,
  ...fileHandlers,
  ...docHandlers,
  ...docWriteHandlers,
  ...mediaHandlers,
  ...buildEmployeeHandlers(prisma),
} as Record<string, CapabilityHandler>;
```

只加这两处展开 + 一行 import 即可，无需改构造函数签名（`prisma` 已注入）。

## 五、验证记录

```powershell
# 类型检查（TSC_EXIT=0）
C:\Users\30290\Desktop\REA逆向\toolchain\node-v24.22.1-win-x64\node.exe node_modules\typescript\bin\tsc -p packages\server\tsconfig.json

# 冒烟（内存 prisma 桩，32 项断言）
C:\Users\30290\Desktop\REA逆向\toolchain\node-v24.22.1-win-x64\node.exe scripts\smoke-p17-employee-tools.mjs
# 最后一行：P17 employee-tools SMOKE OK (32 checks)
```

覆盖：员工不存在/下架、未安装、安装过期、安装禁用、付费员工无购买记录、正常派活（cloud/desktop）、
自定义标题、input/slug 缺失、自派活、并发上限（含终态不占额度、跨用户隔离）、任务归属与不存在、
输出/产物截断、ISO 时间、cron 非法表达式、cron 员工不存在/未安装、cron 正常创建与 nextRunAt、
自定义时区、列表排序与用户隔离、删除他人/不存在/自己的定时器。
