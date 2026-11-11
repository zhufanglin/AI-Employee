export type FcmApi = {
  info: () => Promise<{ version: string; platform: string; electron: string; apiBase: string }>
  settings: {
    get: () => Promise<{ apiBase: string; user: any; hasToken: boolean; onboarded?: boolean }>
    setApiBase: (v: string) => Promise<boolean>
    markOnboarded: () => Promise<boolean>
    /** P43：恢复默认设置（保留登录态） */
    reset: () => Promise<{ apiBase: string; hasToken: boolean; onboarded: boolean }>
    /** P43：把一段文本另存到用户选定位置 */
    saveTextFile: (p: { defaultName?: string; content?: string; extension?: string }) => Promise<{ canceled: boolean; path?: string }>
  }
  // 客户端更新：状态推送走 onStatus，用户在设置页手动检查/下载/安装。
  update: {
    status: () => Promise<any>
    check: () => Promise<any>
    download: () => Promise<any>
    install: () => Promise<any>
    onStatus: (fn: (s: any) => void) => () => void
  }
  // asar 热更新（P43 P1-6）：只下载并替换 app.asar，替代整包 NSIS 安装。
  asarUpdate: {
    status: () => Promise<AsarOpResult<AsarUpdateStatus>>
    check: () => Promise<AsarOpResult<AsarCheckData>>
    download: () => Promise<AsarOpResult<AsarDownloadData>>
    install: () => Promise<AsarOpResult<AsarInstallData>>
  }
  // 客户端日志（P43 P1-7）：日志文件列表、最近 N 行、读文件、目录与路径。
  logs: {
    getDir: () => Promise<LogOpResult<{ dir: string }>>
    getFilePath: () => Promise<LogOpResult<{ path: string; name: string; exists: boolean }>>
    listFiles: () => Promise<LogOpResult<{ dir: string; items: LogFileItem[] }>>
    getRecent: (p?: { lines?: number; file?: string }) => Promise<LogOpResult<LogRecentData>>
    readFile: (p: { name?: string; path?: string; maxBytes?: number }) => Promise<LogOpResult<LogReadData>>
  }
  // 本机执行器（把云端派下来的员工任务拉到这台电脑上跑）
  employeeExecution: {
    heartbeat: () => Promise<any>
    nodes: () => Promise<any>
    status: () => Promise<any>
    tick: () => Promise<any>
    start: () => Promise<any>
    stop: () => Promise<any>
  }
  auth: {
    smsSend: (phone: string) => Promise<{ success: boolean; devCode?: string }>
    smsLogin: (p: { phone: string; code: string }) => Promise<any>
    passwordLogin: (p: { username: string; password: string }) => Promise<any>
    logout: () => Promise<boolean>
    me: () => Promise<any>
  }
  site: { config: () => Promise<any> }
  models: () => Promise<Model[]>
  credits: { balance: () => Promise<{ balance: number; totalConsumed: number; totalRecharged: number }>; usageRecords: (q?: string) => Promise<any> }
  // 兑换码与套餐（P43）：服务端 /packages/redeem 已有中文校验，客户端此前缺入口。
  packages: {
    presets: () => Promise<{ ok: boolean; data?: any; error?: string }>
    mine: () => Promise<{ ok: boolean; data?: PackageMine; error?: string }>
    redeem: (code: string) => Promise<{ ok: boolean; data?: PackageRedeemResult; error?: string }>
  }
  employees: {
    catalog: (q?: string) => Promise<any>
    mine: () => Promise<any>
    install: (slug: string) => Promise<any>
    uninstall: (slug: string) => Promise<any>
    run: (p: { slug: string; input: any; title?: string }) => Promise<any>
  }
  workspace: {
    pick: () => Promise<{ items: any[] }>
    list: (limit?: number) => Promise<any>
    download: (p: { key: string; name: string }) => Promise<{ canceled: boolean }>
    remove: (p: { key?: string; name?: string }) => Promise<any>
  }
  employeeTasks: {
    list: (q?: string) => Promise<any>
    approve: (p: { id: string; reason?: string }) => Promise<any>
    reject: (p: { id: string; reason?: string }) => Promise<any>
  }
  chat: {
    send: (p: { requestId: string; body: any }) => Promise<{ usage: any; content: string; aborted?: boolean }>
    /** P43：带附件发送（附件先传到工作区） */
    sendWithMedia: (p: { requestId: string; body: any; attachments?: Array<{ name: string; mime?: string; base64: string }> }) => Promise<{ usage: any; content: string; aborted?: boolean }>
    /** P0-2：中断正在生成的请求 */
    abort: (requestId: string) => Promise<boolean>
    /** 会话列表（默认 30 条） */
    sessions: (limit?: number) => Promise<{ items: ChatSessionSummary[] }>
    createSession: (p?: { model?: string; title?: string }) => Promise<{ session: ChatSession }>
    getSession: (id: string) => Promise<ChatSessionDetail>
    renameSession: (id: string, patch: { title?: string; model?: string }) => Promise<{ session: ChatSession }>
    removeSession: (id: string) => Promise<{ ok: boolean }>
    appendMessages: (id: string, messages: ChatAppendMessage[]) => Promise<{ ok: boolean; appended: number }>
    onChunk: (cb: (p: { requestId: string; delta: string }) => void) => () => void
    onDone: (cb: (p: { requestId: string; usage: any; content: string; aborted?: boolean }) => void) => () => void
    onError: (cb: (p: { requestId: string; message: string; status: number }) => void) => () => void
  }
  gateway: {
    status: () => Promise<{ running: boolean; pid?: number; port: number; token: string; home: string; healthy: boolean; lastError?: string }>
    start: () => Promise<any>
    stop: () => Promise<any>
    restart: () => Promise<any>
    logs: () => Promise<string[]>
    controlUrl: () => Promise<string>
  }
  // 平台发布（本机 RPA，见 docs/handoff/P24-平台发布RPA-契约.md）
  platform: {
    /** 预热隐藏窗口（提前拉起登录页，点「扫码登录」时几乎瞬时弹出） */
    warm: (p?: { platform?: string }) => Promise<{ ok: boolean }>
    status: (p?: { platform?: string; force?: boolean }) => Promise<PlatformStatus[]>
    login: (p: { platform: string }) => Promise<PlatformStatus>
    logout: (p: { platform: string }) => Promise<{ ok: boolean }>
    publish: (p: PlatformPublishInput) => Promise<PlatformPublishResult>
    openDebug: (p: { platform: string }) => Promise<{ ok: boolean }>
    pickMedia: (p: { type?: 'video' | 'image' }) => Promise<{ paths: string[] }>
    stats: (p: { platform: string; maxChars?: number }) => Promise<PlatformStatsSnapshot>
    /** 把数据快照的整页文本解析成结构化指标（P30，服务端纯函数） */
    parseMetrics: (p: { platform: string; text: string }) => Promise<PlatformMetricsParseResult>
    /** 读评论管理页的评论列表（P32） */
    comments: (p: { platform: string; maxItems?: number }) => Promise<PlatformCommentsSnapshot>
    /** 回复某条评论：index（0 起）或 match（评论里的几个字）定位（P32） */
    replyComment: (p: { platform: string; index?: number; match?: string; text: string }) => Promise<PlatformReplyResult>
  }
  // 工作区文件管理（P27，见 docs/handoff/P27-文件管理.md）
  files: {
    list: (p?: { dir?: string }) => Promise<FileListData | FileOpError>
    read: (p: { path: string; maxBytes?: number }) => Promise<FileReadData | FileOpError>
    write: (p: { path: string; text: string }) => Promise<FileWriteData | FileOpError>
    mkdir: (p: { path: string }) => Promise<FilePathData | FileOpError>
    rename: (p: { path: string; name: string }) => Promise<FilePathData | FileOpError>
    remove: (p: { path: string }) => Promise<FileOkData | FileOpError>
    reveal: (p: { path: string }) => Promise<FileOkData | FileOpError>
    open: (p: { path: string }) => Promise<FileOkData | FileOpError>
  }
  // 员工定时任务（P27，见 docs/handoff/P27-定时任务.md）
  cron: {
    list: () => Promise<CronOpResult<{ items: any[]; total: number }>>
    create: (input: { employeeSlug: string; cronExpr: string; timezone?: string }) => Promise<CronOpResult<{ cronId: string; nextRunAt: string | null }>>
    update: (input: { cronId: string; enabled?: boolean; cronExpr?: string; timezone?: string }) => Promise<
      CronOpResult<{ cronId: string; enabled: boolean; cronExpr: string; timezone: string; nextRunAt: string | null }>
    >
    remove: (p: { cronId: string }) => Promise<CronOpResult<{ deleted: boolean }>>
  }
  // 战略与人设（P42，见 docs/handoff/P42-原版战略表人设表-逆向.md）
  strategy: {
    get: () => Promise<CronOpResult<StrategyDocView>>
    save: (input: StrategySaveInput) => Promise<CronOpResult<{ version: string; updatedAt: string }>>
    iterations: () => Promise<CronOpResult<{ items: StrategyIterationItem[] }>>
    listPersonas: () => Promise<CronOpResult<{ items: PersonaItem[] }>>
    savePersona: (input: PersonaSaveInput) => Promise<CronOpResult<{ item: PersonaItem }>>
    removePersona: (p: { id: string }) => Promise<CronOpResult<{ ok: boolean }>>
  }
  // 定时发布（P26，见 docs/handoff/P26-定时发布.md）
  queue: {
    list: () => Promise<CronOpResult<{ items: ScheduledPublishJob[] }>>
    add: (input: ScheduledPublishInput) => Promise<CronOpResult<ScheduledPublishJob>>
    remove: (id: string) => Promise<CronOpResult<{ removed: boolean }>>
    retry: (id: string) => Promise<CronOpResult<ScheduledPublishJob>>
    onEvent: (cb: (p: { event: string; payload: any }) => void) => () => void
  }
  window: { minimize: () => void; maximize: () => void; close: () => void }
}

// 与 packages/desktop/src/main/file-ops.ts 的返回结构逐字对齐（渲染层直接读 r.ok / r.error）
export type FileItem = { name: string; path: string; isDir: boolean; size: number; mtime: number }
export type FileOpError = { ok: false; error: string }
export type FileListData = { ok: true; dir: string; items: FileItem[] }
export type FileReadData = { ok: true; path: string; text: string; truncated: boolean }
export type FileWriteData = { ok: true; path: string; size: number }
export type FilePathData = { ok: true; path: string }
export type FileOkData = { ok: true; error?: string }
// cron-ops.ts 的统一包裹：{ ok, data?, error? }
export type CronOpResult<T> = { ok: boolean; data?: T; error?: string }

// asar-update.ts / log-ops.ts 的统一包裹（与 CronOpResult 同形，单独命名便于阅读）
export type AsarOpResult<T> = { ok: boolean; data?: T; error?: string }
export type LogOpResult<T> = { ok: boolean; data?: T; error?: string }

// 与 packages/desktop/src/main/asar-update.ts 的 PendingAsarUpdate / AsarUpdateStatus 逐字对齐
export type PendingAsarUpdate = {
  version: string
  file: string
  sha512: string
  size: number
  publishedAt: string | null
  minVersion: string | null
  downloaded: boolean
  incompatible: boolean
}

export type AsarUpdateStatus = {
  currentVersion: string
  base: string
  lastCheckAt: string | null
  pending?: PendingAsarUpdate
  canInstall: boolean
  message?: string
}

export type AsarCheckData = AsarUpdateStatus & {
  latestVersion: string
  updateAvailable: boolean
  message: string
}

export type AsarDownloadData = AsarUpdateStatus & { filePath: string; message: string }
export type AsarInstallData = { restarting: true; version: string; backup: string }

// 与 packages/desktop/src/main/log-ops.ts 逐字对齐
export type LogFileItem = { name: string; size: number; mtime: number }

export type LogRecentData = {
  file: string
  path: string
  lines: string[]
  truncated: boolean
  size: number
}

export type LogReadData = {
  file: string
  path: string
  text: string
  size: number
  bytes: number
  truncated: boolean
}

// 战略与人设（P42）：GET /api/strategy 的返回，正文是整篇 markdown。
export type StrategyDocView = {
  version: string
  updatedAt: string
  updatedBy?: string
  content: string
}

// 战略迭代记录（对应原版「战略表」的核心字段）。
export type StrategyIterationItem = {
  versionNo: string
  versionType: string
  iteratedAt: string
  trigger: string
  sections?: string
  summary: string
  author?: string
  docUrl?: string
}

export type StrategySaveInput = {
  content: string
  versionType?: string
  trigger?: string
  summary?: string
}

// 账号人设（对应原版「人设规划表」8 字段；一账号一行）。
export type PersonaItem = {
  id: string
  name: string
  positioning?: string
  plan?: string
  accountId?: string
  followers?: string
  homepage?: string
  effectiveAt?: string
}

export type PersonaSaveInput = {
  name: string
  positioning?: string
  plan?: string
  accountId?: string
  followers?: string
  homepage?: string
  effectiveAt?: string
}

export type PlatformId = 'douyin' | 'xiaohongshu' | 'shipinhao'

export type PlatformStatus = {
  platform: string
  name: string
  loggedIn: boolean
  nickname?: string
  checkedAt: string
  error?: string
}

export type PlatformPublishInput = {
  platform: PlatformId | string
  type: 'video' | 'image'
  title?: string
  content: string
  tags?: string[]
  mediaPaths: string[]
  scheduledAt?: string
}

export type PlatformStatsSnapshot = {
  platform: string
  name: string
  ok: boolean
  loggedIn: boolean
  pageTitle: string
  href: string
  text: string
  screenshots: string[]
  message: string
}

// P32：评论列表（index 是本次扫描顺序，只用于定位）
export type PlatformCommentItem = { index: number; text: string }
export type PlatformCommentsSnapshot = {
  platform: string
  name: string
  ok: boolean
  loggedIn: boolean
  pageTitle: string
  href: string
  selector: string
  items: PlatformCommentItem[]
  screenshots: string[]
  message: string
}
export type PlatformReplyResult = {
  platform: string
  ok: boolean
  message: string
  target?: string
  screenshots: string[]
  steps: { step: string; ok: boolean; detail?: string }[]
}

// P30：平台数据快照的结构化解析结果（服务端能力 platform_metrics_parse）
export type PlatformMetricItem = {
  label: string
  value: number | null
  raw: string
}
export type PlatformWorkItem = {
  title: string
  playCount: number | null
  likeCount: number | null
  commentCount: number | null
  publishedAt: string | null
  raw: string
}
export type PlatformMetrics = {
  platform: string
  ok: boolean
  metrics: PlatformMetricItem[]
  works: PlatformWorkItem[]
  notes: string[]
}
export type PlatformMetricsParseResult = { ok: true; data: PlatformMetrics } | { ok: false; error: string }

export type PlatformPublishResult = {
  platform: string
  ok: boolean
  message: string
  url?: string
  screenshots: string[]
  steps: { step: string; ok: boolean; detail?: string }[]
}

// 与 packages/desktop/src/main/publish-queue.ts 的 PublishResult 逐字对齐
export type ScheduledPublishResult = {
  platform: string
  ok: boolean
  url?: string
  message: string
}

// 与 packages/desktop/src/main/publish-queue.ts 的 ScheduledJob 逐字对齐
export type ScheduledPublishJob = {
  id: string
  /** 兼容老 UI：等于 platforms[0] */
  platform: string
  /** P31 多平台：这条任务串行发布的平台列表 */
  platforms: string[]
  /** P31：每发完一个平台落一条，崩溃后也能看到进度 */
  results: ScheduledPublishResult[]
  type: 'video' | 'image'
  title: string
  content: string
  tags: string[]
  mediaPaths: string[]
  scheduledAt: string
  status: 'pending' | 'running' | 'done' | 'failed'
  attempts: number
  createdAt: string
  startedAt?: string
  finishedAt?: string
  url?: string
  message?: string
  late?: boolean
}

export type ScheduledPublishInput = {
  /** 旧字段：只发一个平台时仍可用，内部归一成 platforms: [platform] */
  platform?: PlatformId | string
  /** 新字段：一条任务最多 3 个平台，去重后串行发布 */
  platforms?: (PlatformId | string)[]
  type?: 'video' | 'image'
  title: string
  content?: string
  tags?: string | string[]
  mediaPaths: string | string[]
  // datetime-local 输入（2026-11-09T09:30）或 ISO 字符串
  scheduledAt: string
}

export type Model = {
  id: string
  name: string
  pricingMode: string
  pricePerRequest: number
  pricePerInputToken: number
  pricePerOutputToken: number
}

/** 套餐授权（兑换码核销后的结果，字段与服务端 UserPackageGrant 对齐） */
export type PackageGrant = {
  id: string
  packageId: string
  source?: string
  validDays?: number
  grantedAt?: string
  expiresAt: string
  preset?: { id?: string; name?: string; description?: string } | null
}

export type PackagePreset = {
  id: string
  name?: string
  description?: string
  validDays?: number
  owned?: boolean
}

export type PackageMine = {
  active?: PackageGrant[]
  expired?: PackageGrant[]
  presets?: PackagePreset[]
  effectivePackages?: string[]
}

export type PackageRedeemResult = {
  packageId: string
  validDays: number
  expiresAt: string
  grantId: string
  preset?: { id?: string; name?: string } | null
}

// P0-2 对话页持久化：与服务端 /chat/sessions 契约逐字对齐。
export type ChatSessionSummary = {
  id: string
  title: string
  model?: string
  updatedAt: string
  messageCount: number
  preview: string
}

export type ChatSession = {
  id: string
  title: string
  model?: string
  createdAt: string
  updatedAt: string
}

export type ChatMessageItem = {
  id: string
  role: string
  content: string
  tokensIn?: number
  tokensOut?: number
  isError?: boolean
  createdAt: string
}

export type ChatSessionDetail = {
  session: ChatSession
  messages: ChatMessageItem[]
}

export type ChatAppendMessage = {
  role: 'user' | 'assistant'
  content: string
  tokensIn?: number
  tokensOut?: number
  isError?: boolean
}

declare global {
  interface Window { fcm: FcmApi }
}
