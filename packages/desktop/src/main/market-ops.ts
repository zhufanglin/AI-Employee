/**
 * P44-B1 员工商城主进程实现。
 *
 * 服务端契约（已上线，勿改服务端）：
 *   GET  /employees/marketplace        公开（可带 JWT）-> { items, total, categories? }
 *        item 含 id/slug/name/description/category/price/priceDisplay/isBundled/requiredPackage，
 *        登录后附加 purchased / userPurchaseStatus / userExpiresAt / installed / installedExpiresAt。
 *        注意：服务端搜索参数名是 q（不是 keyword），分类参数是 category；这里对外仍收 keyword。
 *   GET  /employee-orders/duration-options  公开 -> { items: [{ label, days }] }
 *   POST /employee-orders              JWT body { slug, durationDays } -> { order, employee, amount, payHint }
 *   GET  /employee-orders/mine         JWT -> { items, total, durationOptions }
 *   GET  /employee-orders/:orderNo     JWT -> 订单详情（含 expired；orderNo 或主键 id 都能查）
 *   POST /employee-orders/:orderNo/pay JWT -> { orderNo, amount, codeUrl, expiresAt, mock }
 *        微信未配置时 HTTP 502 body { code: 'WECHAT_PAY_NOT_CONFIGURED', message: '微信支付尚未配置完成，请联系管理员' }
 *   POST /employees/:slug/install      JWT body { workspacePath? } -> { install, employee }
 *
 * 与 cron-ops.ts 约定一致：所有 IPC 统一返回 { ok: true, data } | { ok: false, error }，
 * 异常在这里兜住并转成中文，渲染进程不用关心 HTTP 状态码和响应体结构。
 */

import type { IpcMain } from 'electron'

export interface MarketOpsDeps {
  api: (path: string, init?: any) => Promise<any>
}

/** 商城员工卡片：字段与服务端 marketplace 的真实返回对齐（未登录时购买/安装字段缺省） */
export interface MarketEmployee {
  id: string
  slug: string
  name: string
  description: string
  category: string
  price: number
  priceDisplay: string
  isBundled: boolean
  requiredPackage: string | null
  purchased?: boolean
  userPurchaseStatus?: 'active' | 'expired' | 'none'
  userExpiresAt?: string | null
  installed?: boolean
  installedExpiresAt?: string | null
  title?: string
  avatarEmoji?: string
}

/** 购买时长选项（1天 / 周 / 月 / 季度 / 年） */
export interface DurationOption {
  label: string
  days: number
}

/**
 * 员工订单：字段与服务端 EmployeeOrder 表 + status() 的返回对齐。
 * status 当前可能是 pending / paid / closed / refunded / amount_mismatch。
 */
export interface EmployeeOrder {
  id: string
  orderNo: string
  employeeSlug: string
  durationDays: number
  pricePerDay: number
  totalAmount: number
  payMethod: string
  status: string
  expiredAt: string
  employeeExpiresAt?: string | null
  paidAt?: string | null
  wechatTransactionId?: string | null
  createdAt: string
  updatedAt?: string
  /** pending 且已超过 30 分钟支付窗口时服务端置 true */
  expired?: boolean
}

/** POST /employee-orders 的返回 */
export interface CreateOrderResult {
  order: EmployeeOrder
  employee: { slug: string; name: string; price: number; priceDisplay?: string }
  amount: number
  payHint: string
}

/** POST /employee-orders/:orderNo/pay 的返回（mock 为真时是开发环境的假支付） */
export interface PayOrderResult {
  orderNo: string
  amount: number
  codeUrl: string
  expiresAt: string
  mock?: boolean
}

export type MarketOpResult<T = any> = { ok: true; data: T } | { ok: false; error: string }

const MARKET_LIST = '/employees/marketplace'
const DURATION_OPTIONS = '/employee-orders/duration-options'
const EMPLOYEE_ORDERS = '/employee-orders'
const WECHAT_NOT_CONFIGURED_TEXT = '微信支付尚未配置，请联系管理员人工开通'

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value instanceof Error) return value.message.trim()
  if (value && typeof value === 'object' && typeof (value as any).message === 'string') {
    return (value as any).message.trim()
  }
  return ''
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

function fail(message: string): MarketOpResult<never> {
  return { ok: false, error: message }
}

function optionalText(value: unknown): string | null {
  const s = text(value)
  return s || null
}

/** 502 微信未配置：api() 已经把 body.error.message 抛成 Error，这里同时兼容带 code 的对象 */
function isWechatNotConfigured(error: unknown): boolean {
  const code = String((error as any)?.code || (error as any)?.body?.code || (error as any)?.error?.code || '')
  if (code === 'WECHAT_PAY_NOT_CONFIGURED') return true
  const message = text(error) || text((error as any)?.error)
  return message.includes('微信支付尚未配置')
}

/** 把异常转成中文：优先服务端 message / code，网络失败等原始信息原样带上 */
function errorMessage(error: unknown, fallback: string): string {
  if (isWechatNotConfigured(error)) return WECHAT_NOT_CONFIGURED_TEXT
  const message = text(error) || text((error as any)?.error)
  return message || fallback
}

function normalizeEmployee(raw: any): MarketEmployee {
  const status = text(raw?.userPurchaseStatus)
  return {
    id: text(raw?.id),
    slug: text(raw?.slug),
    name: text(raw?.name),
    description: text(raw?.description),
    category: text(raw?.category),
    price: num(raw?.price),
    priceDisplay: text(raw?.priceDisplay),
    isBundled: bool(raw?.isBundled),
    requiredPackage: optionalText(raw?.requiredPackage),
    purchased: bool(raw?.purchased),
    userPurchaseStatus: status === 'active' || status === 'expired' || status === 'none' ? status : 'none',
    userExpiresAt: optionalText(raw?.userExpiresAt),
    installed: bool(raw?.installed),
    installedExpiresAt: optionalText(raw?.installedExpiresAt),
    title: text(raw?.title) || undefined,
    avatarEmoji: text(raw?.avatarEmoji) || undefined
  }
}

function normalizeOrder(raw: any): EmployeeOrder {
  return {
    id: text(raw?.id),
    orderNo: text(raw?.orderNo),
    employeeSlug: text(raw?.employeeSlug),
    durationDays: num(raw?.durationDays),
    pricePerDay: num(raw?.pricePerDay),
    totalAmount: num(raw?.totalAmount),
    payMethod: text(raw?.payMethod) || 'wechat',
    status: text(raw?.status) || 'pending',
    expiredAt: text(raw?.expiredAt),
    employeeExpiresAt: optionalText(raw?.employeeExpiresAt),
    paidAt: optionalText(raw?.paidAt),
    wechatTransactionId: optionalText(raw?.wechatTransactionId),
    createdAt: text(raw?.createdAt),
    updatedAt: text(raw?.updatedAt) || undefined,
    expired: bool(raw?.expired)
  }
}

function normalizeDuration(raw: any): DurationOption | null {
  const days = num(raw?.days)
  if (days <= 0) return null
  return { label: text(raw?.label) || days + '天', days }
}

/** 商城列表：keyword 走服务端 q，category 原样透传 */
async function listMarket(deps: MarketOpsDeps, input: any): Promise<MarketOpResult<any>> {
  const params = new URLSearchParams()
  const keyword = text(input?.keyword) || text(input?.q)
  if (keyword) params.set('q', keyword)
  const category = text(input?.category)
  if (category) params.set('category', category)
  const query = params.toString()

  const body = await deps.api(MARKET_LIST + (query ? '?' + query : ''))
  const rawItems = Array.isArray(body?.items) ? body.items : []
  const items = rawItems.map(normalizeEmployee).filter((item: MarketEmployee) => !!item.slug)
  // categories 服务端也会返回；没有时按当前结果去重兜底
  const categories = Array.isArray(body?.categories)
    ? body.categories.map((c: unknown) => text(c)).filter(Boolean)
    : Array.from(new Set(items.map((item: MarketEmployee) => item.category).filter(Boolean)))
  const total = Number.isFinite(Number(body?.total)) ? Number(body.total) : items.length
  return { ok: true, data: { items, total, categories } }
}

async function durationOptions(deps: MarketOpsDeps): Promise<MarketOpResult<{ items: DurationOption[] }>> {
  const body = await deps.api(DURATION_OPTIONS)
  const rawItems = Array.isArray(body?.items) ? body.items : []
  const items = rawItems.map(normalizeDuration).filter(Boolean) as DurationOption[]
  if (!items.length) return fail('服务端没有返回可用的购买时长，请稍后重试')
  return { ok: true, data: { items } }
}

async function createOrder(deps: MarketOpsDeps, input: any): Promise<MarketOpResult<CreateOrderResult>> {
  const slug = text(input?.slug)
  if (!slug) return fail('员工 slug 必填')
  const durationDays = num(input?.durationDays)
  if (!Number.isInteger(durationDays) || durationDays <= 0) return fail('购买天数必须是正整数')

  const body = await deps.api(EMPLOYEE_ORDERS, {
    method: 'POST',
    body: JSON.stringify({ slug, durationDays })
  })
  if (!body?.order || !text(body.order.orderNo)) {
    return fail('下单接口没有返回订单号，请稍后在「我的订单」里确认是否已创建')
  }
  const order = normalizeOrder(body.order)
  return {
    ok: true,
    data: {
      order,
      employee: {
        slug: text(body?.employee?.slug) || slug,
        name: text(body?.employee?.name),
        price: num(body?.employee?.price),
        priceDisplay: text(body?.employee?.priceDisplay)
      },
      amount: num(body?.amount, order.totalAmount),
      payHint: text(body?.payHint)
    }
  }
}

async function myOrders(deps: MarketOpsDeps): Promise<MarketOpResult<any>> {
  const body = await deps.api(EMPLOYEE_ORDERS + '/mine')
  const rawItems = Array.isArray(body?.items) ? body.items : []
  const items = rawItems.map(normalizeOrder)
  const options = (Array.isArray(body?.durationOptions) ? body.durationOptions : [])
    .map(normalizeDuration)
    .filter(Boolean) as DurationOption[]
  const total = Number.isFinite(Number(body?.total)) ? Number(body.total) : items.length
  return { ok: true, data: { items, total, durationOptions: options } }
}

async function orderStatus(deps: MarketOpsDeps, input: any): Promise<MarketOpResult<EmployeeOrder>> {
  const ref = text(input?.orderNo) || text(input?.id)
  if (!ref) return fail('订单号必填')
  const body = await deps.api(EMPLOYEE_ORDERS + '/' + encodeURIComponent(ref))
  if (!body || typeof body !== 'object' || !text(body.orderNo)) {
    return fail('订单不存在或无权查看')
  }
  return { ok: true, data: normalizeOrder(body) }
}

/** 发起微信支付：未配置时把 502 转成运营能看懂的中文提示 */
async function payOrder(deps: MarketOpsDeps, input: any): Promise<MarketOpResult<PayOrderResult>> {
  const ref = text(input?.orderNo) || text(input?.id)
  if (!ref) return fail('订单号必填')
  let body: any
  try {
    body = await deps.api(EMPLOYEE_ORDERS + '/' + encodeURIComponent(ref) + '/pay', { method: 'POST' })
  } catch (e) {
    return fail(errorMessage(e, '发起支付失败，请稍后重试'))
  }
  const codeUrl = text(body?.codeUrl)
  if (!codeUrl) {
    // 微信支付未配置时服务端一定 502；万一返回 200 却没二维码，也不能让用户干等
    if (text(body?.code) === 'WECHAT_PAY_NOT_CONFIGURED') return fail(WECHAT_NOT_CONFIGURED_TEXT)
    return fail('支付接口没有返回二维码地址，请稍后在「我的订单」里重试')
  }
  return {
    ok: true,
    data: {
      orderNo: text(body?.orderNo) || ref,
      amount: num(body?.amount),
      codeUrl,
      expiresAt: text(body?.expiresAt),
      mock: bool(body?.mock)
    }
  }
}

async function install(deps: MarketOpsDeps, input: any): Promise<MarketOpResult<any>> {
  const slug = text(input?.slug)
  if (!slug) return fail('员工 slug 必填')
  const payload: Record<string, unknown> = {}
  const workspacePath = text(input?.workspacePath)
  if (workspacePath) payload.workspacePath = workspacePath
  const body = await deps.api('/employees/' + encodeURIComponent(slug) + '/install', {
    method: 'POST',
    body: JSON.stringify(payload)
  })
  return { ok: true, data: body ?? null }
}

/**
 * 注册员工商城 IPC：
 *   market:list / market:duration-options / market:create-order / market:my-orders /
 *   market:order-status / market:pay-order / market:install
 * 所有异常都在 guard 里兜住，渲染进程永远拿到 { ok, data?, error? }（中文文案）。
 */
export function registerMarketOps(ipc: IpcMain, deps: MarketOpsDeps): void {
  const guard = async (task: () => Promise<MarketOpResult<any>>): Promise<MarketOpResult<any>> => {
    try {
      if (typeof deps?.api !== 'function') return fail('商城服务未就绪，请重启客户端')
      return await task()
    } catch (e) {
      return fail(errorMessage(e, '商城操作失败，请稍后重试'))
    }
  }

  ipc.handle('market:list', (_event, input) => guard(() => listMarket(deps, input)))
  ipc.handle('market:duration-options', () => guard(() => durationOptions(deps)))
  ipc.handle('market:create-order', (_event, input) => guard(() => createOrder(deps, input)))
  ipc.handle('market:my-orders', () => guard(() => myOrders(deps)))
  ipc.handle('market:order-status', (_event, input) => guard(() => orderStatus(deps, input)))
  ipc.handle('market:pay-order', (_event, input) => guard(() => payOrder(deps, input)))
  ipc.handle('market:install', (_event, input) => guard(() => install(deps, input)))
}
