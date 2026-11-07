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
  window: { minimize: () => void; maximize: () => void; close: () => void }
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
