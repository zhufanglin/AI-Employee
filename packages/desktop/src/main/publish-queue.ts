/**
 * P26 定时发布：客户端本地定时发布队列。
 *
 * 为什么不复用服务端的 EmployeeCron：
 *   EmployeeCron 只存「员工 + cron 表达式」，不存要发布的内容（标题/正文/素材/平台），
 *   而发布本身必须在用户本机的浏览器会话里跑（平台按 IP/设备风控）。
 *   所以定时发布的内容与到点触发都放在客户端，落盘在 userData 下的 JSON 文件里，
 *   关掉客户端再打开也不会丢，到点（或补跑）由主进程的 tick 触发。
 *
 * 设计要点：
 *   - 单实例串行：同一时间只发一条，避免三个平台同时抢窗口和鼠标。
 *   - 错过就补跑：客户端关着的时候到点的任务，打开后会立刻补发（超过 LATE_MS 记为迟到）。
 *   - 状态只前进不后退：pending → running → done | failed，failed 可手动重试。
 *   - 文件写入用「临时文件 + rename」，避免断电/崩溃留下半截 JSON。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type JobStatus = 'pending' | 'running' | 'done' | 'failed'

export interface ScheduledJob {
  id: string
  platform: string
  type: 'video' | 'image'
  title: string
  content: string
  tags: string[]
  mediaPaths: string[]
  /** 计划发布时间（ISO 字符串） */
  scheduledAt: string
  status: JobStatus
  attempts: number
  createdAt: string
  startedAt?: string
  finishedAt?: string
  /** 成功时的作品链接 */
  url?: string
  /** 失败原因或成功提示 */
  message?: string
  /** 迟到补跑时标记：到点时客户端没有开着 */
  late?: boolean
}

export interface PublishQueueDeps {
  /** 队列 JSON 的绝对路径（一般是 userData/publish-queue.json） */
  file: () => string
  /** 真正执行发布，通常是 platform.publish(input) */
  publish: (input: { platform: string; type: 'video' | 'image'; title: string; content: string; tags: string[]; mediaPaths: string[] }) => Promise<any>
  log?: (message: string) => void
  /** 状态变化时通知渲染层（main 里接 win.webContents.send） */
  notify?: (event: string, payload: any) => void
  /** 便于单测注入固定时间 */
  now?: () => number
}

export const PLATFORMS = ['douyin', 'xiaohongshu', 'shipinhao'] as const
export const MAX_JOBS = 200
/** 超过这么久还没发，仍会补发，但标记 late 便于用户分辨 */
export const LATE_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 3

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value instanceof Error) return value.message.trim()
  if (value && typeof value === 'object' && typeof (value as any).message === 'string') {
    return String((value as any).message).trim()
  }
  return ''
}

function newId(nowMs: number): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `job_${nowMs.toString(36)}_${rand}`
}

function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean)
  const raw = text(value)
  if (!raw) return []
  return raw
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

/** 解析 datetime-local（2026-11-09T09:30）或 ISO 字符串 */
export function parseWhen(value: unknown): number {
  const raw = text(value)
  if (!raw) return NaN
  const ms = new Date(raw).getTime()
  return Number.isFinite(ms) ? ms : NaN
}

export class PublishQueue {
  private jobs: ScheduledJob[] = []
  private loaded = false
  private running = false

  constructor(private readonly deps: PublishQueueDeps) {}

  private filePath(): string {
    const path = this.deps.file()
    const parent = dirname(path)
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
    return path
  }

  private nowMs(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private log(message: string): void {
    if (this.deps.log) this.deps.log(message)
  }

  private notify(event: string, payload: any): void {
    if (this.deps.notify) this.deps.notify(event, payload)
  }

  /** 读盘。文件损坏时不覆盖，重命名成 .broken 留证，然后从空队列开始。 */
  load(): ScheduledJob[] {
    if (this.loaded) return this.jobs
    const path = this.filePath()
    this.loaded = true
    if (!existsSync(path)) {
      this.jobs = []
      return this.jobs
    }
    try {
      const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
      const parsed = JSON.parse(raw)
      const items = Array.isArray(parsed?.jobs) ? parsed.jobs : []
      this.jobs = items.map((item: any) => this.normalize(item)).filter(Boolean) as ScheduledJob[]
    } catch (e) {
      this.log('定时发布队列读取失败，已备份并从空队列开始：' + text(e))
      try {
        renameSync(path, path + '.broken')
      } catch {
        /* 备份失败也不阻塞启动 */
      }
      this.jobs = []
    }
    return this.jobs
  }

  private normalize(raw: any): ScheduledJob | null {
    if (!raw || typeof raw !== 'object') return null
    const platform = text(raw.platform)
    if (!PLATFORMS.includes(platform as any)) return null
    const scheduledAt = text(raw.scheduledAt)
    if (!Number.isFinite(parseWhen(scheduledAt))) return null
    const status: JobStatus = ['pending', 'running', 'done', 'failed'].includes(raw.status)
      ? raw.status
      : 'pending'
    return {
      id: text(raw.id) || newId(this.nowMs()),
      platform,
      type: raw.type === 'image' ? 'image' : 'video',
      title: text(raw.title),
      content: typeof raw.content === 'string' ? raw.content : '',
      tags: toList(raw.tags),
      mediaPaths: Array.isArray(raw.mediaPaths) ? raw.mediaPaths.map((p: any) => text(p)).filter(Boolean) : toList(raw.mediaPaths),
      scheduledAt,
      // 上次退出时还在 running 的任务已经没有进程在跑了，回到 pending 重排一次。
      status: status === 'running' ? 'pending' : status,
      attempts: Number(raw.attempts) || 0,
      createdAt: text(raw.createdAt) || new Date(this.nowMs()).toISOString(),
      startedAt: text(raw.startedAt) || undefined,
      finishedAt: text(raw.finishedAt) || undefined,
      url: text(raw.url) || undefined,
      message: text(raw.message) || undefined,
      late: raw.late === true
    }
  }

  private save(): void {
    const path = this.filePath()
    const tmp = path + '.tmp'
    const payload = { version: 1, jobs: this.jobs }
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    try {
      renameSync(tmp, path)
    } catch (e) {
      // Windows 上偶尔会因句柄占用失败，退化为直接写。
      this.log('定时发布队列写入 rename 失败，改为直接写：' + text(e))
      writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8')
      try {
        unlinkSync(tmp)
      } catch {
        /* 忽略 */
      }
    }
  }

  list(): ScheduledJob[] {
    this.load()
    return this.jobs
      .slice()
      .sort((a, b) => parseWhen(a.scheduledAt) - parseWhen(b.scheduledAt))
  }

  /** 新增一条定时发布。校验失败抛中文错误，由 IPC 层转成 { ok:false, error }。 */
  add(input: any): ScheduledJob {
    this.load()
    const platform = text(input?.platform)
    if (!PLATFORMS.includes(platform as any)) throw new Error('平台只能是 douyin / xiaohongshu / shipinhao')
    const title = text(input?.title)
    if (!title) throw new Error('标题必填')
    const type: 'video' | 'image' = input?.type === 'image' ? 'image' : 'video'
    const mediaPaths = toList(input?.mediaPaths)
    if (mediaPaths.length === 0) throw new Error('请先选择素材文件')
    const whenMs = parseWhen(input?.scheduledAt)
    if (!Number.isFinite(whenMs)) throw new Error('发布时间格式不对，请重新选择时间')
    if (whenMs < this.nowMs() - 60 * 1000) throw new Error('发布时间已经过去了，请选一个将来的时间')
    if (this.jobs.filter((job) => job.status === 'pending').length >= MAX_JOBS) {
      throw new Error('待发布任务太多了（上限 ' + MAX_JOBS + ' 条），请先删掉一些')
    }

    const job: ScheduledJob = {
      id: newId(this.nowMs()),
      platform,
      type,
      title,
      content: typeof input?.content === 'string' ? input.content : text(input?.content),
      tags: toList(input?.tags),
      mediaPaths,
      scheduledAt: new Date(whenMs).toISOString(),
      status: 'pending',
      attempts: 0,
      createdAt: new Date(this.nowMs()).toISOString()
    }
    this.jobs.push(job)
    this.save()
    this.log(`已排程发布：${platform} «${title}» @ ${job.scheduledAt}`)
    this.notify('queue', { action: 'add', job })
    return job
  }

  remove(id: string): boolean {
    this.load()
    const target = text(id)
    if (!target) throw new Error('任务 id 必填')
    const job = this.jobs.find((item) => item.id === target)
    if (!job) throw new Error('定时任务不存在或已删除')
    if (job.status === 'running') throw new Error('这条任务正在发布中，等它跑完再删')
    this.jobs = this.jobs.filter((item) => item.id !== target)
    this.save()
    this.notify('queue', { action: 'remove', id: target })
    return true
  }

  /** 失败的任务手动重试：状态回到 pending 并立即到点。 */
  retry(id: string): ScheduledJob {
    this.load()
    const job = this.jobs.find((item) => item.id === text(id))
    if (!job) throw new Error('定时任务不存在或已删除')
    if (job.status !== 'failed') throw new Error('只有失败的任务可以重试')
    job.status = 'pending'
    job.scheduledAt = new Date(this.nowMs()).toISOString()
    job.message = undefined
    job.finishedAt = undefined
    job.late = false
    this.save()
    this.notify('queue', { action: 'retry', job })
    return job
  }

  /** 到点（或迟到补跑）的任务，按计划时间从早到晚；同一时刻只取一条。 */
  dueJobs(): ScheduledJob[] {
    this.load()
    const now = this.nowMs()
    return this.jobs
      .filter((job) => job.status === 'pending' && parseWhen(job.scheduledAt) <= now)
      .sort((a, b) => parseWhen(a.scheduledAt) - parseWhen(b.scheduledAt))
  }

  /**
   * 跑一轮：把到点的任务串行发出去。
   * 返回本次真正执行的任务（便于单测断言），不抛异常。
   */
  async tick(): Promise<ScheduledJob[]> {
    if (this.running) return []
    this.load()
    const due = this.dueJobs()
    if (due.length === 0) return []
    this.running = true
    const executed: ScheduledJob[] = []
    try {
      for (const job of due) {
        // 每轮重新取，避免上一轮跑的时候用户手动删了后面的任务
        const current = this.jobs.find((item) => item.id === job.id)
        if (!current || current.status !== 'pending') continue
        await this.runJob(current)
        executed.push(current)
      }
    } finally {
      this.running = false
    }
    return executed
  }

  private async runJob(job: ScheduledJob): Promise<void> {
    const startedMs = this.nowMs()
    job.status = 'running'
    job.attempts += 1
    job.startedAt = new Date(startedMs).toISOString()
    job.late = startedMs - parseWhen(job.scheduledAt) > LATE_MS
    job.message = undefined
    this.save()
    this.notify('queue', { action: 'start', job })

    try {
      const result = await this.deps.publish({
        platform: job.platform,
        type: job.type,
        title: job.title,
        content: job.content,
        tags: job.tags,
        mediaPaths: job.mediaPaths
      })
      const ok = result && (result.ok === true || result.success === true)
      if (ok) {
        job.status = 'done'
        job.url = text(result?.url) || undefined
        job.message = text(result?.message) || '发布成功'
        this.log(`定时发布成功：${job.platform} «${job.title}»${job.url ? ' → ' + job.url : ''}`)
      } else {
        job.status = 'failed'
        job.message = text(result?.message) || text(result?.error) || '发布失败，原因未知'
        this.log(`定时发布失败：${job.platform} «${job.title}»：${job.message}`)
      }
    } catch (e) {
      job.status = 'failed'
      job.message = text(e) || '发布失败，原因未知'
      this.log(`定时发布异常：${job.platform} «${job.title}»：${job.message}`)
    }

    job.finishedAt = new Date(this.nowMs()).toISOString()
    if (job.status === 'failed' && job.attempts >= MAX_ATTEMPTS) {
      job.message = (job.message || '发布失败') + `（已尝试 ${job.attempts} 次，可手动重试）`
    }
    this.save()
    this.notify('queue', { action: job.status === 'done' ? 'done' : 'failed', job })
  }
}

/**
 * 注册定时发布 IPC：queue:list / queue:add / queue:remove / queue:retry。
 * 统一返回 { ok, data?, error? }，渲染层不需要 try/catch。
 */
export function registerPublishQueue(ipc: { handle: (channel: string, handler: (...args: any[]) => any) => void }, queue: PublishQueue): void {
  const guard = async (task: () => any) => {
    try {
      return { ok: true, data: await task() }
    } catch (e) {
      return { ok: false, error: text(e) || '定时发布操作失败' }
    }
  }
  ipc.handle('queue:list', () => guard(() => ({ items: queue.list() })))
  ipc.handle('queue:add', (_event: any, input: any) => guard(() => queue.add(input)))
  ipc.handle('queue:remove', (_event: any, input: any) => guard(() => ({ removed: queue.remove(text(input?.id) || text(input)) })))
  ipc.handle('queue:retry', (_event: any, input: any) => guard(() => queue.retry(text(input?.id) || text(input))))
}

export function defaultQueuePath(userDataDir: string): string {
  return join(userDataDir, 'publish-queue.json')
}
