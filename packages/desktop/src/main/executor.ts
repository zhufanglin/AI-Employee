import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runToolLoop } from '../../../worker/tool-loop.mjs'

export interface ExecutorDeps {
  api: (path: string, init?: RequestInit & { auth?: boolean }) => Promise<any>
  getToken: () => string | undefined
  onEvent?: (evt: { type: string; taskId?: string; message?: string }) => void
}

interface TaskRow {
  id: string
  employeeId: string
  title?: string
  input?: any
  status?: string
  outputMeta?: any
}

const POLL_MS = Number(process.env.FCM_EXECUTOR_POLL_MS || 8000)
const MAX_OUTPUT_CHARS = 200_000
// 本机执行器并发度：默认 2（客户端是普通办公机，再高会被模型调用与文件读写拖慢）
const CONCURRENCY = (() => {
  const raw = Number(process.env.FCM_EXECUTOR_CONCURRENCY || 2)
  if (!Number.isFinite(raw) || raw < 1) return 2
  return Math.min(4, Math.floor(raw))
})()

function str(v: any, fallback = ''): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback
}

function list(v: any): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).filter(Boolean)
  return []
}

/** 本机员工执行器：拉取端上执行的 queued 任务 -> 调模型产出 -> 回写 awaiting_approval */
export class TaskExecutor {
  private timer: NodeJS.Timeout | null = null
  private lastRun: { at: string; taskId?: string; ok: boolean; error?: string } | null = null
  private employees = new Map<string, any>()
  private employeesAt = 0
  private startedAt: string | null = null
  /** 正在跑的任务数（含「已领到、正等同一员工空闲」） */
  private inFlight = 0
  /** employeeId -> 该员工当前任务的 Promise：同一员工同时只跑 1 条 */
  private readonly inFlightByEmployee = new Map<string, Promise<void>>()

  constructor(private readonly deps: ExecutorDeps) {}

  status() {
    return { running: !!this.timer, busy: this.inFlight > 0, inFlight: this.inFlight, concurrency: CONCURRENCY, startedAt: this.startedAt, lastRun: this.lastRun, pollMs: POLL_MS }
  }

  start() {
    if (this.timer) return this.status()
    this.startedAt = new Date().toISOString()
    this.timer = setInterval(() => void this.tick(), POLL_MS)
    setTimeout(() => void this.tick(), 1500)
    this.log('started')
    return this.status()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.log('stopped')
    return this.status()
  }

  private log(message: string, extra?: any) {
    console.log('[executor] ' + message, extra ?? '')
    this.deps.onEvent?.({ type: 'log', message })
  }

  private async loadEmployees() {
    if (Date.now() - this.employeesAt < 60_000 && this.employees.size) return
    const r = await this.deps.api('/employees/mine')
    const items: any[] = Array.isArray(r?.items) ? r.items : []
    this.employees = new Map(items.map((e) => [e.id, e]))
    this.employeesAt = Date.now()
  }

  private async pickModel(emp: any): Promise<string | undefined> {
    const cfg = (() => {
      try {
        return typeof emp?.agentConfig === 'string' ? JSON.parse(emp.agentConfig) : emp?.agentConfig
      } catch {
        return null
      }
    })()
    if (cfg && typeof cfg.model === 'string' && cfg.model.trim()) return cfg.model.trim()
    const r = await this.deps.api('/compute/models')
    const arr: any[] = Array.isArray(r) ? r : r?.data || []
    return arr[0]?.id
  }

  private buildMessages(task: TaskRow, emp: any) {
    const name = str(emp?.name, 'AI 员工')
    const lines = [
      '你是「' + name + '」，一个可交付结果的 AI 员工。',
      str(emp?.title) ? '岗位：' + str(emp.title) : '',
      str(emp?.mission) ? '使命：' + str(emp.mission) : '',
      str(emp?.coreDirective) ? '核心指令：' + str(emp.coreDirective) : '',
      str(emp?.description) ? '职责说明：' + str(emp.description) : '',
      list(emp?.capabilities).length ? '能力：' + list(emp.capabilities).join('；') : '',
      list(emp?.kpi).length ? '考核指标：' + list(emp.kpi).join('；') : '',
      str(emp?.usageExample) ? '使用示例：' + str(emp.usageExample) : '',
      '最终交付应是可验收的成品，通过 finish 工具返回。'
    ].filter(Boolean)
    const input = task.input
    const inputText =
      typeof input === 'string'
        ? input
        : input && typeof input === 'object'
          ? str((input as any).text) || str((input as any).prompt) || JSON.stringify(input, null, 2)
          : ''
    return [
      { role: 'system', content: lines.join('\n') },
      {
        role: 'user',
        content:
          '任务标题：' + str(task.title, '一次性任务') +
          (inputText ? '\n\n任务输入：\n' + inputText : '\n\n（无额外输入，按你的岗位职责给出本次可交付结果）')
      }
    ]
  }

  /** 读工作区的 AGENTS.md 与 TOOLS.md（不存在就跳过），拼成一段规则文本 */
  private readWorkspaceRules(): string {
    const home = app.getPath('userData')
    const parts: string[] = []
    for (const name of ['AGENTS.md', 'TOOLS.md']) {
      const file = join(home, name)
      try {
        if (!existsSync(file)) continue
        const text = readFileSync(file, 'utf8').trim()
        if (text) parts.push('### ' + name + '\n' + text)
      } catch { /* 读不到就跳过，不影响任务执行 */ }
    }
    return parts.join('\n\n')
  }

  private async execute(task: TaskRow, signal: AbortSignal) {
    await this.loadEmployees()
    let emp = this.employees.get(task.employeeId)
    // 刚安装的员工可能还没进 60s 缓存：强制刷新一次再判失败
    if (!emp) {
      this.employeesAt = 0
      await this.loadEmployees()
      emp = this.employees.get(task.employeeId)
    }
    if (!emp) throw new Error('员工未安装或不在我的员工列表中，无法执行')
    const model = await this.pickModel(emp)
    const skill = str((task as any).employeeSkillMd) || str(emp?.skillMd)
    // P42：战略/人设由服务端按岗位 needs 切片后随任务下发
    const strategy = str((task as any).strategyText)
    const persona = str((task as any).personaText)
    const needs = Array.isArray((task as any).employeeNeeds) ? ((task as any).employeeNeeds as string[]) : []
    // P43：工作区规则文件（AGENTS.md / TOOLS.md）原版每会话注入，这里从 userData 读
    const rules = str((task as any).workspaceRules) || this.readWorkspaceRules()
    const out = await runToolLoop({ api: this.deps.api, model, messages: this.buildMessages(task, emp), skill, strategy, persona, needs, workspaceRules: rules, strategyMeta: { version: str((task as any).strategyVersion), updatedAt: str((task as any).strategyUpdatedAt) }, signal, maxSteps: Number(process.env.FCM_EXECUTOR_MAX_STEPS || 8), timeoutMs: Number(process.env.FCM_EXECUTOR_TASK_TIMEOUT_MS || 900000) })
    const content: string = out.content
    const dir = join(app.getPath('userData'), 'employee-output')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, task.id + '.md')
    writeFileSync(file, '# ' + str(task.title, '任务产出') + '\n\n' + content.slice(0, MAX_OUTPUT_CHARS), 'utf8')
    return { ...out, content, file, model }
  }

  /** 领到一条任务后立刻占住槽位开跑（并行，同员工串行），不阻塞其它槽位 */
  private startTask(task: TaskRow) {
    const employeeId = str(task.employeeId)
    const previous = employeeId ? this.inFlightByEmployee.get(employeeId) : undefined
    this.inFlight += 1
    const promise = (async () => {
      if (previous) {
        this.log('wait-employee', { taskId: task.id, employeeId, inFlight: this.inFlight })
        try { await previous } catch { /* 前一条失败不影响本条 */ }
      }
      await this.runOne(task)
    })()
    if (employeeId) this.inFlightByEmployee.set(employeeId, promise)
    promise.catch(() => {}).finally(() => {
      this.inFlight -= 1
      if (employeeId && this.inFlightByEmployee.get(employeeId) === promise) this.inFlightByEmployee.delete(employeeId)
    })
  }

  /** 一轮调度：只在有空闲槽位时领取；领到的任务丢进并发池 */
  async tick(): Promise<any> {
    if (!this.deps.getToken()) return { skipped: 'no-token' }
    const free = CONCURRENCY - this.inFlight
    if (free <= 0) return { skipped: 'busy', inFlight: this.inFlight }
    let pulled: any
    try {
      pulled = await this.deps.api('/employee-tasks/pull?limit=' + Math.min(free, 4))
    } catch (e: any) {
      this.lastRun = { at: new Date().toISOString(), ok: false, error: String(e?.message || e) }
      this.log('poll-failed: ' + String(e?.message || e))
      return { ok: false, error: String(e?.message || e) }
    }
    const items: TaskRow[] = Array.isArray(pulled?.items) ? pulled.items : []
    if (!items.length) return { idle: true }
    let started = 0
    for (const task of items) {
      if (this.inFlight >= CONCURRENCY) break
      // 同一员工同时只跑一条：避免两个任务抢同一份工作区/记忆
      if (str(task.employeeId) && this.inFlightByEmployee.has(str(task.employeeId))) continue
      this.startTask(task)
      started += 1
    }
    return started ? { started, inFlight: this.inFlight } : { skipped: 'all-employees-busy' }
  }

  private async runOne(task: TaskRow): Promise<any> {
    const claimToken = task.outputMeta?.claimToken
    if (!claimToken) {
      this.log('claim-error', { taskId: task.id, error: '任务缺少领取凭据' })
      return { ok: false, taskId: task.id, error: '任务缺少领取凭据' }
    }
    this.log('claimed', { taskId: task.id, title: task.title, inFlight: this.inFlight })
    const abort = new AbortController()
    const taskHeartbeat = setInterval(() => {
      this.deps.api('/employee-execution/tasks/' + encodeURIComponent(task.id) + '/heartbeat', { method: 'POST', body: JSON.stringify({ claimToken }) })
        .catch((e: any) => { if (/领取已失效/.test(String(e?.message || e))) abort.abort() })
    }, 30000)
    try {
      const out = await this.execute(task, abort.signal)
      await this.deps.api('/employee-tasks/' + encodeURIComponent(task.id), {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'awaiting_approval',
          claimToken,
          outputKind: 'text',
          outputText: out.content.slice(0, MAX_OUTPUT_CHARS),
          outputPath: out.file,
          outputMeta: { ...(task.outputMeta || {}), executor: 'desktop', model: out.model, usage: out.usages, steps: out.steps, media: out.media, finishedAt: new Date().toISOString() },
          artifacts: [
            { kind: 'text', text: out.content.slice(0, 20000), mime: 'text/plain' },
            { kind: 'file', path: out.file, mime: 'text/markdown' },
            ...(out.files || []).map((f: any) => ({ kind: 'workspace-file', path: f.key, text: f.name, mime: 'application/octet-stream' })),
            ...out.media.filter((m: any) => m.url).map((m: any) => ({ kind: m.kind, path: m.url, mime: m.kind === 'image' ? 'image/*' : 'video/*' }))
          ]
        })
      })
      this.lastRun = { at: new Date().toISOString(), taskId: task.id, ok: true }
      this.log('done', { taskId: task.id, inFlight: this.inFlight })
      return { ok: true, taskId: task.id }
    } catch (e: any) {
      const message = String(e?.message || e).slice(0, 500)
      this.lastRun = { at: new Date().toISOString(), taskId: task.id, ok: false, error: message }
      try {
        await this.deps.api('/employee-tasks/' + encodeURIComponent(task.id), {
          method: 'PATCH',
          body: JSON.stringify({ status: 'failed', claimToken, error: message, outputMeta: { ...(task.outputMeta || {}), executor: 'desktop', failedAt: new Date().toISOString(), ...(e?.partial || {}) }, artifacts: (e?.partial?.media || []).filter((m: any) => m.url).map((m: any) => ({ kind: m.kind, path: m.url, mime: m.kind === 'image' ? 'image/*' : 'video/*' })) })
        })
      } catch (e2: any) {
        this.log('report-failed', { taskId: task.id, error: String(e2?.message || e2) })
      }
      this.log('task-failed', { taskId: task.id, error: message })
      return { ok: false, taskId: task.id, error: message }
    } finally {
      clearInterval(taskHeartbeat)
    }
  }
}
