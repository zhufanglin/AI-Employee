import { contextBridge, ipcRenderer } from 'electron'

const api = {
  info: () => ipcRenderer.invoke('app:info'),
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    setApiBase: (v: string) => ipcRenderer.invoke('settings:set-api-base', v),
    markOnboarded: () => ipcRenderer.invoke('settings:mark-onboarded')
  },
  update: {
    status: () => ipcRenderer.invoke('update:status'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: (fn: (s: any) => void) => {
      const h = (_e: any, s: any) => fn(s)
      ipcRenderer.on('update:status', h)
      return () => ipcRenderer.removeListener('update:status', h)
    }
  },
  auth: {
    smsSend: (phone: string) => ipcRenderer.invoke('auth:sms-send', phone),
    smsLogin: (p: { phone: string; code: string }) => ipcRenderer.invoke('auth:sms-login', p),
    passwordLogin: (p: { username: string; password: string }) => ipcRenderer.invoke('auth:password-login', p),
    logout: () => ipcRenderer.invoke('auth:logout'),
    me: () => ipcRenderer.invoke('auth:me')
  },
  site: { config: () => ipcRenderer.invoke('site:config') },
  models: () => ipcRenderer.invoke('compute:models'),
  credits: {
    balance: () => ipcRenderer.invoke('credits:balance'),
    usageRecords: (q?: string) => ipcRenderer.invoke('credits:usage-records', q || '')
  },
  employees: {
    catalog: (q?: string) => ipcRenderer.invoke('employees:catalog', q || ''),
    mine: () => ipcRenderer.invoke('employees:mine'),
    install: (slug: string) => ipcRenderer.invoke('employees:install', slug),
    uninstall: (slug: string) => ipcRenderer.invoke('employees:uninstall', slug),
    run: (p: { slug: string; input: any; title?: string }) => ipcRenderer.invoke('employees:run', p)
  },
  employeeTasks: {
    list: (q?: string) => ipcRenderer.invoke('employee-tasks:list', q || ''),
    approve: (p: { id: string; reason?: string }) => ipcRenderer.invoke('employee-tasks:approve', p),
    reject: (p: { id: string; reason?: string }) => ipcRenderer.invoke('employee-tasks:reject', p)
  },
  employeeExecution: {
    heartbeat: () => ipcRenderer.invoke('employee-execution:heartbeat'),
    nodes: () => ipcRenderer.invoke('employee-execution:nodes'),
    status: () => ipcRenderer.invoke('employee-execution:status'),
    tick: () => ipcRenderer.invoke('employee-execution:tick'),
    start: () => ipcRenderer.invoke('employee-execution:start'),
    stop: () => ipcRenderer.invoke('employee-execution:stop')
  },
  media: {
    upload: (p: { fileName: string; mime: string; base64: string }) => ipcRenderer.invoke('media:upload', p),
    image: (p: { prompt: string; size: number }) => ipcRenderer.invoke('media:image', p),
    video: (p: { image: string; prompt: string; seconds: number; aspectRatio: string }) => ipcRenderer.invoke('media:video', p),
    task: (id: string) => ipcRenderer.invoke('media:task', id),
    cancel: (id: string) => ipcRenderer.invoke('media:cancel', id),
    compose: {
      create: (body: any) => ipcRenderer.invoke('media:compose-create', body),
      list: (q?: string) => ipcRenderer.invoke('media:compose-list', q || ''),
      remove: (id: string) => ipcRenderer.invoke('media:compose-remove', id),
      transfer: (id: string) => ipcRenderer.invoke('media:compose-transfer', id)
    },
    clone: {
      create: (body: any) => ipcRenderer.invoke('media:clone-create', body),
      list: (q?: string) => ipcRenderer.invoke('media:clone-list', q || ''),
      remove: (id: string) => ipcRenderer.invoke('media:clone-remove', id)
    },
    audio: {
      list: () => ipcRenderer.invoke('media:audio-list'),
      upload: (body: any) => ipcRenderer.invoke('media:audio-upload', body),
      remove: (id: string) => ipcRenderer.invoke('media:audio-remove', id)
    }
  },
  channels: {
    personalWeChat: {
      status: () => ipcRenderer.invoke('channel:personal-wechat-status'),
      contacts: () => ipcRenderer.invoke('channel:personal-wechat-contacts'),
      messages: (p: { chatName: string; wxId?: string }) => ipcRenderer.invoke('channel:personal-wechat-messages', p),
      send: (p: { name: string; msg: string; humanize?: boolean }) => ipcRenderer.invoke('channel:personal-wechat-send', p),
      sendFile: (p: { name: string; filePath?: string; fileUrl?: string; humanize?: boolean }) => ipcRenderer.invoke('channel:personal-wechat-send-file', p),
      listen: (p: { wxid?: string; nickname?: string }) => ipcRenderer.invoke('channel:personal-wechat-listen', p)
    }
  },
  chat: {
    send: (p: { requestId: string; body: any }) => ipcRenderer.invoke('chat:send', p),
    onChunk: (cb: (p: { requestId: string; delta: string }) => void) => {
      const h = (_e: any, p: any) => cb(p)
      ipcRenderer.on('chat:chunk', h)
      return () => ipcRenderer.removeListener('chat:chunk', h)
    },
    onDone: (cb: (p: { requestId: string; usage: any; content: string }) => void) => {
      const h = (_e: any, p: any) => cb(p)
      ipcRenderer.on('chat:done', h)
      return () => ipcRenderer.removeListener('chat:done', h)
    },
    onError: (cb: (p: { requestId: string; message: string; status: number }) => void) => {
      const h = (_e: any, p: any) => cb(p)
      ipcRenderer.on('chat:error', h)
      return () => ipcRenderer.removeListener('chat:error', h)
    }
  },
  gateway: {
    status: () => ipcRenderer.invoke('gateway:status'),
    start: () => ipcRenderer.invoke('gateway:start'),
    stop: () => ipcRenderer.invoke('gateway:stop'),
    restart: () => ipcRenderer.invoke('gateway:restart'),
    logs: () => ipcRenderer.invoke('gateway:logs'),
    controlUrl: () => ipcRenderer.invoke('gateway:control-url')
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close')
  }
}

contextBridge.exposeInMainWorld('fcm', api)
export type FcmApi = typeof api
