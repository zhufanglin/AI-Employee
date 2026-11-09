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
 *   - 单实例串行：同一时间只发一条任务；任务内勾选多个平台时也逐个串行，
 *     避免多个平台同时抢窗口和鼠标（P31 多平台分发）。
 *   - 错过就补跑：客户端关着的时候到点的任务，打开后会立刻补发（超过 LATE_MS 记为迟到）。
 *   - 状态只前进不后退：pending → running → done | failed，failed 可手动重试。
 *   - 文件写入用「临时文件 + rename」，避免断电/崩溃留下半截 JSON。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type JobStatus = 'pending' | 'running' | 'done' | 'failed'

/** 单个平台的发布结果。多平台串行发布时，每发完一个就往 job.results 里落一条。 */
export interface PublishResult {
  platform: string
  ok: boolean
  /** 成功时的作品链接 */
  url?: string
  /** 成功提示或中文失败原因 */
  message: string
}

export interface ScheduledJob {
  id: string
  /** 兼容老队列文件与老界面：等于 platforms[0] */
  platform: string
  /** 这条任务要发的平台（去重后 1~3 个，按用户勾选顺序串行发布） */
  platforms: string[]
  /** 已经发完的平台结果；中途崩溃也能从盘上看到完成到哪一步 */
  results: PublishResult[]
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
/** 平台中文名，用于队列日志与多平台失败汇总文案 */
export const PLATFORM_LABELS: Record<string, string> = {
  douyin: '抖音',
  xiaohongshu: '小红书',
  shipinhao: '视频号'
}
export const MAX_PLATFORMS = 3

export function platformLabel(id: string): string {
  return PLATFORM_LABELS[id] || id
}
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

function dedupePlatforms(value: unknown): string[] {
  const out: string[] = []
  if (!Array.isArray(value)) return out
  for (const item of value) {
    const id = text(item)
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * 把新增入参归一成平台数组：优先 platforms，其次兼容旧的 platform。
 * 规则：至少 1 个、最多 3 个、必须在白名单内、去重；非法抛中文错误。
 */
export function normalizePlatforms(input: any): string[] {
  const hasPlatforms = !!input && Object.prototype.hasOwnProperty.call(input, 'platforms') && input.platforms !== undefined
  if (hasPlatforms) {
    if (!Array.isArray(input.platforms)) throw new Error('平台参数格式不对：platforms 必须是平台 id 数组')
    if (input.platforms.length > MAX_PLATFORMS) throw new Error(`最多选择 ${MAX_PLATFORMS} 个发布平台`)
    const picked = dedupePlatforms(input.platforms)
    if (picked.length === 0) throw new Error('至少选择一个发布平台')
    const invalid = picked.filter((id) => !PLATFORMS.includes(id as any))
    if (invalid.length > 0) {
      throw new Error('平台只能是 douyin / xiaohongshu / shipinhao（收到：' + invalid.join('、') + '）')
    }
    return picked
  }
  const single = text(input?.platform)
  if (!single) throw new Error('至少选择一个发布平台')
  if (!PLATFORMS.includes(single as any)) {
    throw new Error('平台只能是 douyin / xiaohongshu / shipinhao（收到：' + single + '）')
  }
  return [single]
}

/** 读老队列文件时的平台归一：platforms 优先，缺失时退回 platform；非法项丢弃。 */
function loadPlatforms(raw: any): string[] {
  const list = Array.isArray(raw?.platforms) ? dedupePlatforms(raw.platforms) : []
  const single = text(raw?.platform)
  const candidates = list.length > 0 ? list : single ? [single] : []
  return candidates.filter((id) => PLATFORMS.includes(id as any)).slice(0, MAX_PLATFORMS)
}

/** 读盘时只保留结构合法的结果项，避免旧文件/手改文件把界面搞崩。 */
function loadResults(raw: any): PublishResult[] {
  if (!Array.isArray(raw)) return []
  const out: PublishResult[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const platform = text(item.platform)
    if (!PLATFORMS.includes(platform as any)) continue
    const ok = item.ok === true
    out.push({
      platform,
      ok,
      url: text(item.url) || undefined,
      message: text(item.message) || (ok ? '发布成功' : '发布失败，原因未知')
    })
  }
  return out
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
    // 老队列文件只有 platform；新文件有 platforms，统一归一成数组。
    const platforms = loadPlatforms(raw)
    if (platforms.length === 0) return null
    const scheduledAt = text(raw.scheduledAt)
    if (!Number.isFinite(parseWhen(scheduledAt))) return null
    const status: JobStatus = ['pending', 'running', 'done', 'failed'].includes(raw.status)
      ? raw.status
      : 'pending'
    return {
      id: text(raw.id) || newId(this.nowMs()),
      platform: platforms[0],
      platforms,
      results: loadResults(raw.results),
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
    const platforms = normalizePlatforms(input)
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
      platform: platforms[0],
      platforms,
      results: [],
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
    this.log(`已排程发布：${platforms.map(platformLabel).join('/')} «${title}» @ ${job.scheduledAt}`)
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
    // 重试会把所有平台重发一遍（包括上次已成功的），所以清空旧结果。
    job.results = []
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

  /** 取任务的平台列表；老数据没有 platforms 时退回 platform。 */
  private platformsOf(job: ScheduledJob): string[] {
    const list = Array.isArray(job.platforms) && job.platforms.length > 0 ? job.platforms : [job.platform]
    return list.filter((id) => PLATFORMS.includes(id as any))
  }

  /**
   * 执行一条任务：按勾选顺序逐个平台串行发布（平台窗口/鼠标不能并发抢）。
   * 每发完一个平台就 push 一条 result 并落盘，进程中途崩溃也能看到完成到哪一步。
   * 某个平台抛异常只记该平台失败，继续发后面的平台。
   */
  private async runJob(job: ScheduledJob): Promise<void> {
    const startedMs = this.nowMs()
    job.status = 'running'
    job.attempts += 1
    job.startedAt = new Date(startedMs).toISOString()
    job.late = startedMs - parseWhen(job.scheduledAt) > LATE_MS
    job.message = undefined
    job.url = undefined
    // 重新跑就重发所有平台，先清空上一次尝试的中间结果（之后每发完一个会立刻写盘）。
    job.results = []
    this.save()
    this.notify('queue', { action: 'start', job })

    const platforms = this.platformsOf(job)
    if (platforms.length === 0) {
      job.status = 'failed'
      job.message = '任务没有可发布的平台（数据可能已损坏，请删除后重建）'
      job.finishedAt = new Date(this.nowMs()).toISOString()
      this.save()
      this.notify('queue', { action: 'failed', job })
      return
    }

    for (const platform of platforms) {
      let result: PublishResult
      try {
        const published = await this.deps.publish({
          platform,
          type: job.type,
          title: job.title,
          content: job.content,
          tags: job.tags,
          mediaPaths: job.mediaPaths
        })
        const ok = published && (published.ok === true || published.success === true)
        if (ok) {
          result = {
            platform,
            ok: true,
            url: text(published?.url) || undefined,
            message: text(published?.message) || '发布成功'
          }
          this.log(`定时发布成功：${platformLabel(platform)} «${job.title}»${result.url ? ' → ' + result.url : ''}`)
        } else {
          result = {
            platform,
            ok: false,
            message: text(published?.message) || text(published?.error) || '发布失败，原因未知'
          }
          this.log(`定时发布失败：${platformLabel(platform)} «${job.title}»：${result.message}`)
        }
      } catch (e) {
        result = { platform, ok: false, message: text(e) || '发布失败，原因未知' }
        this.log(`定时发布异常：${platformLabel(platform)} «${job.title}»：${result.message}`)
      }
      job.results.push(result)
      // 单个平台一结束就落盘 + 通知界面，中途崩溃也能看到已完成哪几个。
      this.save()
      this.notify('queue', { action: 'progress', job, result })
    }

    const total = job.results.length
    const succeeded = job.results.filter((item) => item.ok)
    const failed = job.results.filter((item) => !item.ok)
    if (total === 1) {
      // 单平台保持 P26 的原文案（成功提示 / 失败原因原样展示），老界面与老用例不受影响。
      const only = job.results[0]
      job.status = only.ok ? 'done' : 'failed'
      job.url = only.ok ? only.url : undefined
      job.message = only.message
    } else if (failed.length === 0) {
      job.status = 'done'
      job.url = succeeded[0]?.url
      job.message = `${total} 个平台全部发布成功`
    } else if (succeeded.length > 0) {
      // 部分成功也记为 done：保留「已完成」语义，同时避免自动重试把已成功的平台再发一遍。
      job.status = 'done'
      job.url = succeeded[0]?.url
      job.message =
        `${succeeded.length}/${total} 个平台发布成功，失败：` +
        failed.map((item) => `${platformLabel(item.platform)}（${item.message}）`).join('、')
    } else {
      job.status = 'failed'
      job.url = undefined
      job.message =
        '全部平台发布失败：' +
        failed.map((item) => `${platformLabel(item.platform)}（${item.message}）`).join('、')
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
