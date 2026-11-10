/**
 * P42 战略与人设主进程实现。
 *
 * 服务端契约（已约定，勿改）：
 *   GET    /api/strategy            -> { version, updatedAt, updatedBy, content }
 *   PUT    /api/strategy            body { content, versionType?, trigger?, summary?, author?, docUrl? }
 *                                   -> { version, updatedAt }
 *   GET    /api/strategy/iterations -> { items: [{ versionNo, versionType, iteratedAt, trigger, sections, summary, author, docUrl }] }
 *   GET    /api/personas            -> { items: [{ id, name, positioning, plan, accountId, followers, homepage, effectiveAt }] }
 *   POST   /api/personas            body { name, positioning?, plan?, accountId?, followers?, homepage?, effectiveAt? }
 *                                   -> { item }
 *   DELETE /api/personas/:id        -> { ok: true }
 *
 * 返回统一收敛成 { ok: true, data } | { ok: false, error }，渲染进程不用关心 HTTP 状态。
 */

import type { IpcMain } from 'electron'

export interface StrategyOpsDeps {
  api: (path: string, init?: any) => Promise<any>
}

export interface StrategyDocView {
  version: string
  updatedAt: string
  updatedBy?: string
  content: string
}

export interface StrategyIterationItem {
  versionNo: string
  versionType: string
  iteratedAt: string
  trigger: string
  sections?: string
  summary: string
  author?: string
  docUrl?: string
}

export interface PersonaItem {
  id: string
  name: string
  positioning?: string
  plan?: string
  accountId?: string
  followers?: string
  homepage?: string
  effectiveAt?: string
}

export interface StrategySaveInput {
  content: string
  versionType?: string
  trigger?: string
  summary?: string
}

export interface PersonaSaveInput {
  name: string
  positioning?: string
  plan?: string
  accountId?: string
  followers?: string
  homepage?: string
  effectiveAt?: string
}

export type StrategyOpResult<T = any> = { ok: true; data: T } | { ok: false; error: string }

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Error) return value.message.trim()
  if (value && typeof value === 'object' && typeof (value as any).message === 'string') {
    return String((value as any).message).trim()
  }
  return ''
}

/** 正文/长文本保留原始空白，只压掉首尾空行 */
function keepText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function fail(message: string): StrategyOpResult<never> {
  return { ok: false, error: message }
}

function normalizeDoc(raw: any): StrategyDocView {
  return {
    version: text(raw?.version) || 'V1.0',
    updatedAt: text(raw?.updatedAt),
    updatedBy: text(raw?.updatedBy) || undefined,
    content: keepText(raw?.content)
  }
}

function normalizeIteration(raw: any): StrategyIterationItem {
  return {
    versionNo: text(raw?.versionNo),
    versionType: text(raw?.versionType) || '微调',
    iteratedAt: text(raw?.iteratedAt),
    trigger: text(raw?.trigger),
    sections: text(raw?.sections) || undefined,
    summary: text(raw?.summary),
    author: text(raw?.author) || undefined,
    docUrl: text(raw?.docUrl) || undefined
  }
}

function normalizePersona(raw: any): PersonaItem {
  return {
    id: text(raw?.id),
    name: text(raw?.name),
    positioning: text(raw?.positioning) || undefined,
    plan: keepText(raw?.plan),
    accountId: text(raw?.accountId) || undefined,
    followers: text(raw?.followers) || undefined,
    homepage: text(raw?.homepage) || undefined,
    effectiveAt: text(raw?.effectiveAt) || undefined
  }
}

async function getStrategy(deps: StrategyOpsDeps): Promise<StrategyOpResult<StrategyDocView>> {
  const raw = await deps.api('/strategy')
  if (!raw || typeof raw !== 'object') {
    return fail('服务端没有返回战略内容，请稍后重试')
  }
  return { ok: true, data: normalizeDoc(raw) }
}

async function saveStrategy(deps: StrategyOpsDeps, input: StrategySaveInput | undefined): Promise<StrategyOpResult<{ version: string; updatedAt: string }>> {
  const args = input && typeof input === 'object' ? input : ({} as StrategySaveInput)
  if (typeof args.content !== 'string') return fail('战略正文不能为空')
  const body: Record<string, unknown> = { content: args.content }
  const versionType = text(args.versionType)
  if (versionType) body.versionType = versionType
  const trigger = text(args.trigger)
  if (trigger) body.trigger = trigger
  const summary = text(args.summary)
  if (summary) body.summary = summary

  const raw = await deps.api('/strategy', { method: 'PUT', body: JSON.stringify(body) })
  if (!raw || typeof raw !== 'object') {
    return fail('服务端没有返回保存结果，请刷新页面确认是否已保存')
  }
  return {
    ok: true,
    data: {
      version: text(raw.version) || 'V1.1',
      updatedAt: text(raw.updatedAt) || new Date().toISOString()
    }
  }
}

async function listIterations(deps: StrategyOpsDeps): Promise<StrategyOpResult<{ items: StrategyIterationItem[] }>> {
  const raw = await deps.api('/strategy/iterations')
  const rawItems = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw) ? raw : []
  return { ok: true, data: { items: rawItems.map(normalizeIteration) } }
}

async function listPersonas(deps: StrategyOpsDeps): Promise<StrategyOpResult<{ items: PersonaItem[] }>> {
  const raw = await deps.api('/personas')
  const rawItems = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw) ? raw : []
  return { ok: true, data: { items: rawItems.map(normalizePersona) } }
}

async function savePersona(deps: StrategyOpsDeps, input: PersonaSaveInput | undefined): Promise<StrategyOpResult<{ item: PersonaItem }>> {
  const args = input && typeof input === 'object' ? input : ({} as PersonaSaveInput)
  const name = text(args.name)
  if (!name) return fail('人设名称必填')

  // 空字符串也照传：同名 upsert 时用户可能是想把某个字段清空。
  const body: Record<string, unknown> = {
    name,
    positioning: text(args.positioning),
    plan: keepText(args.plan),
    accountId: text(args.accountId),
    followers: text(args.followers),
    homepage: text(args.homepage)
  }
  const effectiveAt = text(args.effectiveAt)
  if (effectiveAt) body.effectiveAt = effectiveAt

  const raw = await deps.api('/personas', { method: 'POST', body: JSON.stringify(body) })
  const itemRaw = raw && typeof raw === 'object' && raw.item ? raw.item : raw
  if (!itemRaw || typeof itemRaw !== 'object') {
    return fail('服务端没有返回人设数据，请刷新列表确认是否已保存')
  }
  return { ok: true, data: { item: normalizePersona(itemRaw) } }
}

async function removePersona(deps: StrategyOpsDeps, input: { id?: string } | undefined): Promise<StrategyOpResult<{ ok: boolean }>> {
  const id = text(input?.id)
  if (!id) return fail('人设 id 必填')
  await deps.api('/personas/' + encodeURIComponent(id), { method: 'DELETE' })
  return { ok: true, data: { ok: true } }
}

/**
 * 注册战略与人设 IPC 通道：
 *   strategy:get / strategy:save / strategy:iterations
 *   persona:list / persona:save / persona:remove
 * 所有异常都在主进程兜住，渲染层永远拿到 { ok, data?, error? }。
 */
export function registerStrategyOps(ipc: IpcMain, deps: StrategyOpsDeps): void {
  const guard = async (label: string, task: () => Promise<StrategyOpResult<any>>): Promise<StrategyOpResult<any>> => {
    try {
      if (typeof deps?.api !== 'function') return fail('战略与人设服务未就绪，请重启客户端')
      return await task()
    } catch (e) {
      const reason = text(e) || '未知错误'
      return fail(label + '：' + reason)
    }
  }

  ipc.handle('strategy:get', () => guard('读取战略失败', () => getStrategy(deps)))
  ipc.handle('strategy:save', (_event, input) => guard('保存战略失败', () => saveStrategy(deps, input)))
  ipc.handle('strategy:iterations', () => guard('读取战略迭代记录失败', () => listIterations(deps)))
  ipc.handle('persona:list', () => guard('读取账号人设失败', () => listPersonas(deps)))
  ipc.handle('persona:save', (_event, input) => guard('保存账号人设失败', () => savePersona(deps, input)))
  ipc.handle('persona:remove', (_event, input) => guard('删除账号人设失败', () => removePersona(deps, input)))
}
