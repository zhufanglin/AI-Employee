import { app } from 'electron'
import { spawn, ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { installWorkspaceAssets } from './workspace-assets'

export type GatewayStatus = {
  running: boolean
  pid?: number
  port: number
  token: string
  home: string
  healthy: boolean
  lastError?: string
  startedAt?: number
}

type Ctx = {
  getApiBase: () => string
  getProxyToken: () => Promise<string>
  getModels: () => Promise<{ id: string; name: string }[]>
  getInstalledEmployees: () => Promise<string[]>
}

const PORT = Number(process.env.FCM_GATEWAY_PORT || 18789)

export class GatewayManager {
  private child: ChildProcess | null = null
  private status: GatewayStatus
  private logs: string[] = []
  private ctx: Ctx
  private healthTimer: NodeJS.Timeout | null = null
  private stopping = false

  constructor(ctx: Ctx) {
    this.ctx = ctx
    const home = join(app.getPath('userData'), 'openclaw')
    this.status = { running: false, port: PORT, token: this.loadToken(home), home, healthy: false }
  }

  private loadToken(home: string): string {
    try {
      const f = join(home, 'gateway-token.txt')
      if (existsSync(f)) {
        const t = readFileSync(f, 'utf8').trim()
        if (t) return t
      }
    } catch {}
    const t = 'rrclaw-' + randomBytes(16).toString('hex')
    try {
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, 'gateway-token.txt'), t, 'utf8')
    } catch {}
    return t
  }

  getHome() { return this.status.home }

  private openclawDir(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'openclaw')
      : join(app.getAppPath(), 'resources', 'openclaw')
  }

  private log(line: string) {
    const stamped = '[' + new Date().toISOString() + '] ' + line
    this.logs.push(stamped)
    if (this.logs.length > 500) this.logs.shift()
    try {
      mkdirSync(join(this.status.home, 'logs'), { recursive: true })
      appendFileSync(join(this.status.home, 'logs', 'gateway.log'), stamped + '\n')
    } catch {}
  }

  async statusNow(): Promise<GatewayStatus> {
    this.status.healthy = this.child ? await this.probe() : false
    if (!this.child) this.status.running = false
    return { ...this.status }
  }

  private async probe(): Promise<boolean> {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 1500)
      const res = await fetch('http://127.0.0.1:' + this.status.port + '/health', {
        signal: ctrl.signal,
        headers: { authorization: 'Bearer ' + this.status.token }
      })
      clearTimeout(t)
      return res.ok
    } catch {
      return false
    }
  }

  /** 生成本应用的 openclaw.json：模型全部走我们自己的代理端点 */
  private async writeConfig() {
    const [token, models] = await Promise.all([this.ctx.getProxyToken(), this.ctx.getModels()])
    const baseUrl = this.ctx.getApiBase().replace(/\/$/, '') + '/volcengine-proxy/v3'
    const cfg = {
      gateway: { auth: { mode: 'token', token: this.status.token }, mode: 'local', controlUi: { allowedOrigins: ['file://', 'http://localhost:' + this.status.port] } },
      session: { idleMinutes: 10080 },
      models: {
        providers: {
          fcm: {
            baseUrl,
            api: 'openai-completions',
            // 直接写代理令牌字面量：openclaw 只识别已知 *_API_KEY 环境变量标记，
            // 自定义名字会被当作字面量发出（导致上游 401）。每次启动都会重新写入。
            apiKey: token,
            models: models.map((m) => ({ id: m.id, name: m.name }))
          }
        }
      },
      agents: { defaults: { model: { primary: 'fcm/' + (models[0]?.id || 'doubao-seed-2.0-pro') } } }
    }
    mkdirSync(this.status.home, { recursive: true })
    writeFileSync(join(this.status.home, 'openclaw.json'), JSON.stringify(cfg, null, 2), 'utf8')
    this.log('[config] openclaw.json written, provider baseUrl=' + baseUrl + ', apiKey=' + token.slice(0, 16) + '…')
    return token
  }

  async start() {
    if (this.child) return this.statusNow()
    this.stopping = false
    const enabledSkills = await this.ctx.getInstalledEmployees()
    const assets = installWorkspaceAssets(this.status.home, enabledSkills)
    this.log('[workspace] installed ' + assets.installed.length + '/' + assets.total + ' employee skills; user files preserved')
    const dir = this.openclawDir()
    const entry = join(dir, 'openclaw.mjs')
    if (!existsSync(entry)) throw new Error('openclaw.mjs 不存在：' + entry)
    const proxyToken = await this.writeConfig()

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ELECTRON_RUN_AS_NODE: '1',
      OPENCLAW_HOME: this.status.home,
      OPENCLAW_STATE_DIR: join(this.status.home, 'state'),
      OPENCLAW_CONFIG_DIR: this.status.home,
      OPENCLAW_CONFIG_PATH: join(this.status.home, 'openclaw.json'),
      OPENCLAW_GATEWAY_PORT: String(this.status.port),
      OPENCLAW_GATEWAY_TOKEN: this.status.token,
      OPENCLAW_NO_RESPAWN: '1',
      OPENCLAW_NO_ONBOARD: '1',
      OPENCLAW_SKIP_ONBOARDING: '1',
      OPENCLAW_DISABLE_BONJOUR: '1',
      FCM_PROXY_TOKEN: proxyToken,
      FCM_API_BASE: this.ctx.getApiBase()
    }

    this.log('[start] ' + entry + ' gateway --port ' + this.status.port)
    const child = spawn(process.execPath, [entry, 'gateway', '--port', String(this.status.port), '--token', this.status.token, '--allow-unconfigured'], {
      cwd: dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    this.status = { ...this.status, running: true, pid: child.pid, startedAt: Date.now(), lastError: undefined }

    child.stdout?.on('data', (b) => String(b).split(/\r?\n/).filter(Boolean).forEach((l) => this.log('[out] ' + l)))
    child.stderr?.on('data', (b) => String(b).split(/\r?\n/).filter(Boolean).forEach((l) => this.log('[err] ' + l)))
    child.on('exit', (code) => {
      this.log('[exit] code=' + code)
      this.child = null
      this.status = { ...this.status, running: false, healthy: false, pid: undefined }
      if (!this.stopping) this.status.lastError = '网关进程退出，code=' + code
    })

    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = setInterval(() => { this.statusNow().catch(() => {}) }, 5000)
    return this.statusNow()
  }

  async stop() {
    this.stopping = true
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null }
    const c = this.child
    this.child = null
    if (c) {
      try { c.kill() } catch {}
      await new Promise((r) => setTimeout(r, 800))
    }
    this.status = { ...this.status, running: false, healthy: false, pid: undefined }
    return { ...this.status }
  }

  async restart() {
    await this.stop()
    return this.start()
  }

  recentLogs(n = 120) { return this.logs.slice(-n) }
}
