/**
 * P27 定时任务主进程实现。
 *
 * 服务端能力统一走 POST /capabilities/run：
 *   { name: 'cron_create' | 'cron_list' | 'cron_delete', params }
 *
 * 注意：能力失败时服务端仍返回 HTTP 201，真正的成败在 body.success，
 * 中文错误原文在 body.error。这里把返回统一收敛成 { ok, data?, error? }，
 * 渲染进程不需要关心 HTTP 状态码和 body 结构。
 */

import type { IpcMain } from 'electron'

export interface CronOpsDeps {
  api: (path: string, init?: any) => Promise<any>
}

export interface CronItem {
  cronId: string
  employeeSlug: string
  employeeName: string
  cronExpr: string
  timezone: string
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
}

export interface CronCreateInput {
  employeeSlug: string
  cronExpr: string
  timezone?: string
  workflowKey?: string
  title?: string
}

export type CronOpResult<T = any> = { ok: true; data: T } | { ok: false; error: string }

const CAPABILITY_RUN = '/capabilities/run'
const DEFAULT_TIMEZONE = 'Asia/Shanghai'

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value instanceof Error) return value.message.trim()
  if (value && typeof value === 'object' && typeof (value as any).message === 'string') {
    return (value as any).message.trim()
  }
  return ''
}

/** body.error 正常是字符串；兼容 { error: { message } } 这类包装 */
function errorText(value: unknown): string {
  const direct = text(value)
  if (direct) return direct
  if (value && typeof value === 'object' && typeof (value as any).message === 'string') {
    return String((value as any).message).trim()
  }
  return ''
}

function fail(message: string): CronOpResult<never> {
  return { ok: false, error: message }
}

function normalizeItem(raw: any): CronItem {
  const employee = raw && typeof raw.employee === 'object' && raw.employee ? raw.employee : {}
  return {
    cronId: text(raw?.cronId),
    // 服务端当前返回 employee: { slug, name }，契约文档写的是 employeeSlug，两种都兼容。
    employeeSlug: text(raw?.employeeSlug) || text(employee.slug),
    employeeName: text(raw?.employeeName) || text(employee.name),
    cronExpr: text(raw?.cronExpr),
    timezone: text(raw?.timezone) || DEFAULT_TIMEZONE,
    enabled: raw?.enabled !== false && raw?.enabled !== 0,
    nextRunAt: text(raw?.nextRunAt) || null,
    lastRunAt: text(raw?.lastRunAt) || null
  }
}

/** 调一次能力，并把 { success, data, error } 收敛成 CronOpResult */
async function runCapability(deps: CronOpsDeps, name: string, params: Record<string, unknown>): Promise<CronOpResult<any>> {
  let body: any
  try {
    body = await deps.api(CAPABILITY_RUN, {
      method: 'POST',
      body: JSON.stringify({ name, params })
    })
  } catch (e) {
    const reason = text(e) || '未知错误'
    return fail('连接定时任务服务失败：' + reason)
  }

  if (!body || typeof body !== 'object') {
    return fail('服务端返回异常：没有拿到定时任务数据，请稍后重试')
  }

  // 201 + success:false 才是服务端的业务失败，必须原样透传中文文案。
  if (body.success === false) {
    return fail(errorText(body.error) || '定时任务操作失败，请稍后重试')
  }

  // 标准返回 { success:true, data }；也兼容上游封装已经把 data 解包出来的情况。
  const data = body.success === true ? body.data : body
  return { ok: true, data: data ?? null }
}

async function listCron(deps: CronOpsDeps): Promise<CronOpResult<{ items: CronItem[]; total: number }>> {
  const result = await runCapability(deps, 'cron_list', {})
  if (!result.ok) return result
  const raw = result.data
  const rawItems = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw) ? raw : []
  const items = rawItems.map(normalizeItem)
  const total = Number.isFinite(Number(raw?.total)) ? Number(raw.total) : items.length
  return { ok: true, data: { items, total } }
}

async function createCron(deps: CronOpsDeps, input: CronCreateInput | undefined): Promise<CronOpResult<{ cronId: string; nextRunAt: string | null }>> {
  const args = input && typeof input === 'object' ? input : ({} as CronCreateInput)
  const employeeSlug = text(args.employeeSlug)
  if (!employeeSlug) return fail('员工 slug 必填')
  const cronExpr = text(args.cronExpr)
  if (!cronExpr) return fail('cron 表达式必填')
  // 服务端只接受 5 段标准 cron（分 时 日 月 周），本地先挡一层，少一次无用请求。
  if (cronExpr.split(/\s+/).length !== 5) {
    return fail('cron 表达式必须是 5 段（分 时 日 月 周），例如 0 9 * * *')
  }

  const params: Record<string, unknown> = {
    employeeSlug,
    cronExpr,
    timezone: text(args.timezone) || DEFAULT_TIMEZONE
  }
  const workflowKey = text(args.workflowKey)
  if (workflowKey) params.workflowKey = workflowKey
  const title = text(args.title)
  if (title) params.title = title

  const result = await runCapability(deps, 'cron_create', params)
  if (!result.ok) return result
  const data = result.data
  const cronId = text(data?.cronId)
  if (!cronId) return fail('服务端没有返回定时任务 id，请刷新列表确认是否已创建')
  return { ok: true, data: { cronId, nextRunAt: text(data?.nextRunAt) || null } }
}

async function deleteCron(deps: CronOpsDeps, input: { cronId?: string } | undefined): Promise<CronOpResult<{ deleted: boolean }>> {
  const cronId = text(input?.cronId)
  if (!cronId) return fail('cronId 必填')
  const result = await runCapability(deps, 'cron_delete', { cronId })
  if (!result.ok) return result
  return { ok: true, data: { deleted: true } }
}

/**
 * 注册定时任务 IPC 通道：cron:list / cron:create / cron:delete。
 * 所有异常都在这里兜住，渲染进程永远拿到 { ok, data?, error? }。
 */
export function registerCronOps(ipc: IpcMain, deps: CronOpsDeps): void {
  const guard = async (task: () => Promise<CronOpResult<any>>): Promise<CronOpResult<any>> => {
    try {
      if (typeof deps?.api !== 'function') return fail('定时任务服务未就绪，请重启客户端')
      return await task()
    } catch (e) {
      const reason = text(e) || '未知错误'
      return fail('定时任务操作失败：' + reason)
    }
  }

  ipc.handle('cron:list', () => guard(() => listCron(deps)))
  ipc.handle('cron:create', (_event, input) => guard(() => createCron(deps, input)))
  ipc.handle('cron:delete', (_event, input) => guard(() => deleteCron(deps, input)))
}
