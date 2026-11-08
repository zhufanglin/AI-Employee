export type FcmApi = {
  info: () => Promise<{ version: string; platform: string; electron: string; apiBase: string }>
  settings: { get: () => Promise<{ apiBase: string; user: any; hasToken: boolean }>; setApiBase: (v: string) => Promise<boolean> }
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
    send: (p: { requestId: string; body: any }) => Promise<{ usage: any; content: string }>
    onChunk: (cb: (p: { requestId: string; delta: string }) => void) => () => void
    onDone: (cb: (p: { requestId: string; usage: any; content: string }) => void) => () => void
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
    status: (p?: { platform?: string }) => Promise<PlatformStatus[]>
    login: (p: { platform: string }) => Promise<PlatformStatus>
    logout: (p: { platform: string }) => Promise<{ ok: boolean }>
    publish: (p: PlatformPublishInput) => Promise<PlatformPublishResult>
    openDebug: (p: { platform: string }) => Promise<{ ok: boolean }>
    pickMedia: (p: { type?: 'video' | 'image' }) => Promise<{ paths: string[] }>
    stats: (p: { platform: string; maxChars?: number }) => Promise<PlatformStatsSnapshot>
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
    remove: (p: { cronId: string }) => Promise<CronOpResult<{ deleted: boolean }>>
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

export type PlatformPublishResult = {
  platform: string
  ok: boolean
  message: string
  url?: string
  screenshots: string[]
  steps: { step: string; ok: boolean; detail?: string }[]
}

export type Model = {
  id: string
  name: string
  pricingMode: string
  pricePerRequest: number
  pricePerInputToken: number
  pricePerOutputToken: number
}

declare global {
  interface Window { fcm: FcmApi }
}
