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
import {
  PLATFORM_RETRY_DELAY_MS,
  PLATFORM_RETRY_TIMES,
  derivePublishStage,
  isTransientPublishError,
  transientErrorKind
} from './publish-resilience'

export type JobStatus = 'pending' | 'running' | 'done' | 'failed'

/** 单个平台的发布结果。多平台串行发布时，每发完一个就往 job.results 里落一条。 */
export interface PublishResult {
  platform: string
  ok: boolean
  /** 成功时的作品链接 */
  url?: string
  /** 成功提示或中文失败原因 */
  message: string
  /** 失败时的可诊断错误（与 message 同文案，供日志/脚本稳定读取） */
  error?: string
  /** 失败阶段：登录 / 准备 / 上传 / 填写 / 提交 / 判定 */
  stage?: string
  /** 平台 publish() 留下的失败截图路径（上传/填写/提交/判定各阶段） */
  screenshots?: string[]
  /** 该平台是否经过瞬时失败后的自动重试（true 表示至少重试过一次） */
  retried?: boolean
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
  /** 失败诊断：第一个失败平台的错误文案（未登录预检失败时与 result.message 完全一致） */
  error?: string
  /** 迟到补跑时标记：到点时客户端没有开着 */
  late?: boolean
}

export interface PublishQueueDeps {
  /** 队列 JSON 的绝对路径（一般是 userData/publish-queue.json） */
  file: () => string
  /** 真正执行发布，通常是 platform.publish(input) */
  publish: (input: { platform: string; type: 'video' | 'image'; title: string; content: string; tags: string[]; mediaPaths: string[] }) => Promise<any>
  /**
   * 登录态预检，通常是 platform.status(platform, opts)。
   * 发布前用 maxAgeMs: 0 绕过 PlatformManager 的 5 分钟 STATUS_CACHE_MS，避免拿着过期登录态去发。
   */
  status?: (platform: string, opts?: { maxAgeMs?: number }) => Promise<any>
  log?: (message: string) => void
  /** 状态变化时通知渲染层（main 里接 win.webContents.send） */
  notify?: (event: string, payload: any) => void
  /** 便于单测注入固定时间 */
  now?: () => number
  /** 便于单测跳过 8 秒等待；默认 setTimeout */
  sleep?: (ms: number) => Promise<void>
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
    const screenshots = Array.isArray(item.screenshots)
      ? item.screenshots.map((shot: any) => text(shot)).filter(Boolean)
      : undefined
    out.push({
      platform,
      ok,
      url: text(item.url) || undefined,
      message: text(item.message) || (ok ? '发布成功' : '发布失败，原因未知'),
      error: text(item.error) || undefined,
      stage: text(item.stage) || undefined,
      screenshots: screenshots && screenshots.length > 0 ? screenshots : undefined,
      retried: item.retried === true
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
  private readonly deps: PublishQueueDeps

  constructor(deps: PublishQueueDeps) {
    this.deps = deps
  }

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
      // 上次进程在「运行中」被杀掉的任务：normalize 会把状态改回 pending，这里数一下便于留日志。
      const interrupted = items.filter((item: any) => item && item.status === 'running').length
      this.jobs = items.map((item: any) => this.normalize(item)).filter(Boolean) as ScheduledJob[]
      if (interrupted > 0) {
        this.log(
          `定时发布队列：${interrupted} 条上次中断的任务已从 running 恢复为 pending，已到点（含错过时间）的会立即重跑`
        )
        try {
          // 立刻落盘，避免恢复后再次崩溃时盘上还留着 running。
          this.save()
        } catch (e) {
          this.log('定时发布队列恢复后写盘失败（不影响本次启动）：' + text(e))
        }
      }
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
      // 注意：results 原样保留（loadResults），所以多平台崩溃后已完成的平台记录不会丢；
      // runJob 真正开跑时会清空 results 重发所有平台（与手动 retry 的语义一致）。
      status: status === 'running' ? 'pending' : status,
      attempts: Number(raw.attempts) || 0,
      createdAt: text(raw.createdAt) || new Date(this.nowMs()).toISOString(),
      startedAt: text(raw.startedAt) || undefined,
      finishedAt: text(raw.finishedAt) || undefined,
      url: text(raw.url) || undefined,
      message: text(raw.message) || undefined,
      error: text(raw.error) || undefined,
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
    job.error = undefined
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
      // 1) 发布前登录态预检：必须绕过 PlatformManager 的 5 分钟缓存，否则拿过期状态去发。
      //    未登录直接记该平台失败，不抛异常，后面的平台继续发。
      const notLoggedIn = await this.checkLoggedIn(platform)
      let result: PublishResult
      if (notLoggedIn) {
        result = { platform, ok: false, message: notLoggedIn, error: notLoggedIn, stage: '登录' }
        this.log(`定时发布跳过：${platformLabel(platform)} «${job.title}»：${notLoggedIn}`)
      } else {
        // 2) 真正发布；瞬时失败（超时/页面没响应/net::/target closed 等）同一平台最多自动重试 1 次。
        result = await this.publishWithRetry(job, platform)
      }
      if (!result.ok && !job.error) job.error = result.error || result.message
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

  private sleep(ms: number): Promise<void> {
    if (this.deps.sleep) return this.deps.sleep(ms)
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * 发布前登录态预检。
   *   - 返回字符串 = 未登录（文案可直接展示，调用方直接记为失败）；
   *   - 返回 undefined = 已登录，或没有注入 status / 预检本身异常（此时放行，让 publish 自己判登录，
   *     避免「检查登录态」这种辅助步骤把本来能发的任务误杀）。
   * maxAgeMs: 0 是关键：status() 默认复用 5 分钟缓存，用户刚退出登录时缓存还是 true。
   */
  private async checkLoggedIn(platform: string): Promise<string | undefined> {
    if (!this.deps.status) return undefined
    const label = platformLabel(platform)
    try {
      const list = await this.deps.status(platform, { maxAgeMs: 0 })
      const all = Array.isArray(list) ? list : list ? [list] : []
      const entry = all.find((item: any) => text(item?.platform) === platform) || all[0]
      if (!entry) {
        this.log(`[queue] ${label} 登录态预检没有返回结果，交给发布流程自行判定`)
        return undefined
      }
      if (entry.loggedIn === true) return undefined
      if (entry.error) this.log(`[queue] ${label} 登录态预检异常：${text(entry.error)}`)
      return `${label}未登录，请到「平台发布」页点「扫码登录」后再试`
    } catch (e) {
      this.log(`[queue] ${label} 登录态预检失败，跳过预检直接发布：` + text(e))
      return undefined
    }
  }

  /**
   * 执行一次平台发布并归一结果：成功/失败信息、失败阶段、截图都从 platform.publish() 的返回里取。
   * platform.publish() 目前没有 stage 字段，但会返回 steps（每步 step/ok/detail）和 screenshots，
   * 所以在 queue 侧用 derivePublishStage(steps, message) 补出「上传/填写/提交/判定」。
   */
  private async publishOnce(job: ScheduledJob, platform: string): Promise<PublishResult> {
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
      const screenshots = Array.isArray(published?.screenshots)
        ? published.screenshots.map((shot: any) => text(shot)).filter(Boolean)
        : []
      if (ok) {
        const message = text(published?.message) || '发布成功'
        this.log(`定时发布成功：${platformLabel(platform)} «${job.title}»${published?.url ? ' → ' + published.url : ''}`)
        return {
          platform,
          ok: true,
          url: text(published?.url) || undefined,
          message,
          screenshots: screenshots.length > 0 ? screenshots : undefined
        }
      }
      const message = text(published?.message) || text(published?.error) || '发布失败，原因未知'
      // 先透传 publish 自带的 stage（如果以后 platform.ts 加了）；没有就从 steps/文案推断。
      const stage = text(published?.stage) || derivePublishStage(published?.steps, message)
      this.log(`定时发布失败：${platformLabel(platform)} «${job.title}» [${stage}]：${message}`)
      return {
        platform,
        ok: false,
        message,
        error: message,
        stage,
        screenshots: screenshots.length > 0 ? screenshots : undefined
      }
    } catch (e) {
      const message = text(e) || '发布失败，原因未知'
      this.log(`定时发布异常：${platformLabel(platform)} «${job.title}» [${derivePublishStage([], message)}]：${message}`)
      return {
        platform,
        ok: false,
        message,
        error: message,
        stage: derivePublishStage([], message)
      }
    }
  }

  /**
   * 同一平台失败后的有限自动重试：只有瞬时特征才重试，最多 PLATFORM_RETRY_TIMES 次，
   * 每次前等 PLATFORM_RETRY_DELAY_MS。一旦重试过就在结果里标 retried=true（重试成功也标）。
   * 稳定的业务失败（未选中图片/标题过长/未登录）一次就停。
   */
  private async publishWithRetry(job: ScheduledJob, platform: string): Promise<PublishResult> {
    let result = await this.publishOnce(job, platform)
    let retriedTimes = 0
    while (
      !result.ok &&
      retriedTimes < PLATFORM_RETRY_TIMES &&
      isTransientPublishError(result.error || result.message)
    ) {
      retriedTimes += 1
      const kind = transientErrorKind(result.error || result.message) || '瞬时失败'
      this.log(
        `定时发布遇到瞬时故障（${kind}），${Math.round(PLATFORM_RETRY_DELAY_MS / 1000)} 秒后自动重试 ` +
          `${platformLabel(platform)}（第 ${retriedTimes}/${PLATFORM_RETRY_TIMES} 次）：${result.message}`
      )
      this.notify('queue', { action: 'retrying', job, platform, attempt: retriedTimes, kind })
      await this.sleep(PLATFORM_RETRY_DELAY_MS)
      result = await this.publishOnce(job, platform)
      // 只要重试过就标记，方便界面/日志区分「一次就成」和「重试后才成」。
      result.retried = true
    }
    return result
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
