import { useCallback, useEffect, useRef, useState } from 'react'
import type { DurationOption, EmployeeOrder, MarketEmployee, PayOrderResult } from '../types'

// 订单状态中文映射（服务端 EmployeeOrder.status）
const ORDER_STATUS: Record<string, string> = {
  pending: '待支付',
  paid: '已支付',
  closed: '已关闭',
  refunded: '已退款',
  amount_mismatch: '金额不符'
}

// 服务端微信支付未配置时的中文提示片段；主进程已把 502 转成「微信支付尚未配置，请联系管理员人工开通」
const WECHAT_MISSING = '微信支付尚未配置'

// 支付窗口：服务端订单 30 分钟 TTL，前端按同一时长停止轮询
const PAY_WINDOW_MS = 30 * 60 * 1000
const POLL_INTERVAL_MS = 3000

// 服务端时长接口异常时的兜底选项（与服务端 DURATION_OPTIONS 一致）
const FALLBACK_DURATIONS: DurationOption[] = [
  { label: '1天', days: 1 },
  { label: '周', days: 7 },
  { label: '月', days: 30 },
  { label: '季度', days: 90 },
  { label: '年', days: 365 }
]

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** ISO 时间 -> yyyy-MM-dd */
function fmtDate(value?: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** ISO 时间 -> yyyy-MM-dd HH:mm */
function fmtDateTime(value?: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return `${fmtDate(value)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 购买面板：mode=new 是首次下单，mode=resume 是从「我的订单」里继续支付已有订单 */
type BuyTarget = {
  slug: string
  name: string
  price: number
  priceDisplay: string
  mode: 'new' | 'resume'
  order?: EmployeeOrder
}

export default function Market({ onGoOffice }: { onGoOffice: () => void }) {
  const [items, setItems] = useState<MarketEmployee[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [keyword, setKeyword] = useState('')
  const [category, setCategory] = useState('全部')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busySlug, setBusySlug] = useState('')

  const [durations, setDurations] = useState<DurationOption[]>([])
  const [durationsError, setDurationsError] = useState('')

  const [orders, setOrders] = useState<EmployeeOrder[]>([])
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [ordersError, setOrdersError] = useState('')

  // 购买模态
  const [buy, setBuy] = useState<BuyTarget | null>(null)
  const [selectedDays, setSelectedDays] = useState(1)
  const [paying, setPaying] = useState(false)
  const [payInfo, setPayInfo] = useState<PayOrderResult | null>(null)
  const [payError, setPayError] = useState('')
  const [payDone, setPayDone] = useState(false)
  const [payOrderNo, setPayOrderNo] = useState('')
  const pollRef = useRef<number | null>(null)

  const stopPoll = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  // 组件卸载时一定停掉轮询，避免离开页面后还在打接口
  useEffect(() => () => stopPoll(), [stopPoll])

  const loadMarket = useCallback(async (kw: string, cat: string) => {
    setLoading(true)
    setError('')
    try {
      const r = await window.fcm.market.list({ keyword: kw, category: cat === '全部' ? '' : cat })
      if (!r.ok || !r.data) {
        setError(r.error || '加载员工商城失败，请稍后重试')
        return
      }
      const list = r.data.items || []
      setItems(list)
      const serverCats = (r.data.categories || []).filter(Boolean)
      const derived = list.map((item) => item.category).filter(Boolean)
      const merged = Array.from(new Set([...serverCats, ...derived]))
      if (merged.length) setCategories((prev) => Array.from(new Set([...prev, ...merged])))
    } catch (e: any) {
      setError(e?.message || '加载员工商城失败，请稍后重试')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true)
    setOrdersError('')
    try {
      const r = await window.fcm.market.myOrders()
      if (!r.ok || !r.data) {
        setOrdersError(r.error || '加载我的订单失败，请稍后重试')
        return
      }
      setOrders(r.data.items || [])
      if (r.data.durationOptions?.length) setDurations(r.data.durationOptions)
    } catch (e: any) {
      setOrdersError(e?.message || '加载我的订单失败，请稍后重试')
    } finally {
      setOrdersLoading(false)
    }
  }, [])

  const loadDurations = useCallback(async () => {
    setDurationsError('')
    try {
      const r = await window.fcm.market.durationOptions()
      if (!r.ok || !r.data) {
        setDurationsError(r.error || '加载购买时长失败，已使用默认时长')
        return
      }
      setDurations(r.data.items || [])
    } catch (e: any) {
      setDurationsError(e?.message || '加载购买时长失败，已使用默认时长')
    }
  }, [])

  useEffect(() => {
    void loadMarket('', '全部')
    void loadOrders()
    void loadDurations()
  }, [loadMarket, loadOrders, loadDurations])

  function selectCategory(next: string) {
    setCategory(next)
    void loadMarket(keyword, next)
  }

  function resetFilters() {
    setKeyword('')
    setCategory('全部')
    void loadMarket('', '全部')
  }

  function refreshAll() {
    void loadMarket(keyword, category)
    void loadOrders()
  }

  /** 添加员工（预装 / 免费 / 已购买），成功后刷新卡片与订单 */
  async function installEmployee(emp: MarketEmployee) {
    setBusySlug(emp.slug)
    setError('')
    setNotice('')
    try {
      const r = await window.fcm.market.install({ slug: emp.slug })
      if (!r.ok) {
        setError(r.error || `添加「${emp.name}」失败，请稍后重试`)
        return
      }
      setNotice(`已添加「${emp.name}」，可在员工办公区使用`)
      await Promise.all([loadMarket(keyword, category), loadOrders()])
    } catch (e: any) {
      setError(e?.message || `添加「${emp.name}」失败，请稍后重试`)
    } finally {
      setBusySlug('')
    }
  }

  /** 订单表里按 slug 添加员工（卡片可能已被筛选掉） */
  async function installBySlug(slug: string) {
    const emp = items.find((item) => item.slug === slug)
    if (emp) {
      await installEmployee(emp)
      return
    }
    setBusySlug(slug)
    setError('')
    setNotice('')
    try {
      const r = await window.fcm.market.install({ slug })
      if (!r.ok) {
        setError(r.error || '添加员工失败，请稍后重试')
        return
      }
      setNotice('已添加员工，可在员工办公区使用')
      await Promise.all([loadMarket(keyword, category), loadOrders()])
    } catch (e: any) {
      setError(e?.message || '添加员工失败，请稍后重试')
    } finally {
      setBusySlug('')
    }
  }

  function resetPayState() {
    stopPoll()
    setPayInfo(null)
    setPayError('')
    setPayDone(false)
    setPayOrderNo('')
  }

  function openBuy(emp: MarketEmployee) {
    resetPayState()
    setBuy({ slug: emp.slug, name: emp.name, price: emp.price, priceDisplay: emp.priceDisplay, mode: 'new' })
    const first = durations[0] || FALLBACK_DURATIONS[0]
    setSelectedDays(first.days)
  }

  function closeModal() {
    stopPoll()
    setBuy(null)
    setPaying(false)
    resetPayState()
  }

  /** 支付成功后的收尾：自动安装 + 刷新列表与订单 */
  async function afterPaid(slug: string) {
    try {
      const r = await window.fcm.market.install({ slug })
      if (r.ok) {
        setNotice('支付成功，员工已自动添加，可在员工办公区使用')
        setPayError('')
      } else {
        setPayError(`支付成功，但自动添加失败：${r.error || '请到员工办公区手动添加'}`)
      }
    } catch (e: any) {
      setPayError(`支付成功，但自动添加失败：${e?.message || '请到员工办公区手动添加'}`)
    }
    await Promise.all([loadMarket(keyword, category), loadOrders()])
  }

  /** 每 3 秒查一次订单状态，直到 paid / closed / refunded 或超过 30 分钟 */
  function startPolling(orderNo: string, slug: string) {
    stopPoll()
    const deadline = Date.now() + PAY_WINDOW_MS
    pollRef.current = window.setInterval(() => {
      void (async () => {
        if (Date.now() > deadline) {
          stopPoll()
          setPayError('已超过 30 分钟支付窗口，订单会自动关闭，请重新下单')
          void loadOrders()
          return
        }
        try {
          const r = await window.fcm.market.orderStatus(orderNo)
          if (!r.ok || !r.data) return
          const order = r.data
          if (order.status === 'paid') {
            stopPoll()
            setPayDone(true)
            setPayError('')
            void afterPaid(slug)
          } else if (order.status === 'closed' || order.status === 'refunded') {
            stopPoll()
            setPayError(order.status === 'closed' ? '订单已关闭，请重新下单' : '订单已退款，请重新下单')
            void loadOrders()
          } else if (order.expired) {
            stopPoll()
            setPayError('订单已超过 30 分钟支付窗口，请重新下单')
            void loadOrders()
          }
        } catch {
          // 网络抖动不打断轮询，下一轮继续查
        }
      })()
    }, POLL_INTERVAL_MS)
  }

  /**
   * 发起支付：成功则展示二维码并开始轮询；502 微信未配置时主进程已给出中文 error，
   * 这里原样展示（渲染层再补一句「管理员确认收款后会自动开通」）。
   */
  async function payOne(orderNo: string, slug: string): Promise<boolean> {
    setPayError('')
    try {
      const r = await window.fcm.market.payOrder(orderNo)
      if (!r.ok || !r.data) {
        setPayError(r.error || '发起支付失败，请稍后重试')
        return false
      }
      setPayInfo(r.data)
      startPolling(orderNo, slug)
      return true
    } catch (e: any) {
      setPayError(e?.message || '发起支付失败，请稍后重试')
      return false
    }
  }

  async function createAndPay() {
    if (!buy) return
    setPaying(true)
    setPayError('')
    try {
      const created = await window.fcm.market.createOrder({ slug: buy.slug, durationDays: selectedDays })
      if (!created.ok || !created.data) {
        setPayError(created.error || '创建订单失败，请稍后重试')
        return
      }
      const orderNo = created.data.order.orderNo
      setPayOrderNo(orderNo)
      const ok = await payOne(orderNo, buy.slug)
      if (!ok) void loadOrders()
    } catch (e: any) {
      setPayError(e?.message || '创建订单失败，请稍后重试')
    } finally {
      setPaying(false)
    }
  }

  /** 从订单表「去支付」继续支付已有订单 */
  async function resumePay(order: EmployeeOrder) {
    const emp = items.find((item) => item.slug === order.employeeSlug)
    resetPayState()
    setBuy({
      slug: order.employeeSlug,
      name: emp?.name || order.employeeSlug,
      price: order.pricePerDay,
      priceDisplay: emp?.priceDisplay || `${order.pricePerDay} 积分/天`,
      mode: 'resume',
      order
    })
    setSelectedDays(order.durationDays)
    setPaying(true)
    const ok = await payOne(order.orderNo, order.employeeSlug)
    setPaying(false)
    if (!ok) void loadOrders()
  }

  /** 卡片状态徽标：已安装 / 已购买至 yyyy-MM-dd / 已过期 / 未购买 */
  function badgeOf(emp: MarketEmployee): { label: string; cls: string } {
    if (emp.installed) return { label: '已安装', cls: 'is-installed' }
    if (emp.userPurchaseStatus === 'active' && emp.userExpiresAt) {
      return { label: `已购买至 ${fmtDate(emp.userExpiresAt)}`, cls: 'is-bought' }
    }
    if (emp.userPurchaseStatus === 'active') return { label: '已购买', cls: 'is-bought' }
    if (emp.userPurchaseStatus === 'expired') return { label: '已过期', cls: 'is-expired' }
    if (emp.isBundled) return { label: '预装免费', cls: 'is-bought' }
    return { label: '未购买', cls: 'is-none' }
  }

  function priceText(emp: MarketEmployee): string {
    if (emp.isBundled) return '预装免费'
    if (emp.price > 0) return emp.priceDisplay || `${emp.price} 积分/天`
    return '免费'
  }

  function nameOfSlug(slug: string): string {
    return items.find((item) => item.slug === slug)?.name || slug
  }

  const durationList = durations.length ? durations : FALLBACK_DURATIONS
  const totalAmount = buy?.mode === 'resume' && buy.order ? buy.order.totalAmount : (buy?.price || 0) * selectedDays

  return (
    <div className="page market-page">
      <div className="page-head">
        <h2>🛒 员工商城</h2>
        <p>按天购买员工，支付成功后自动添加到「员工办公区」；预装员工可直接添加。</p>
      </div>

      {notice && <div className="notice ok">{notice}</div>}
      {error && <div className="notice err">{error}</div>}

      <div className="market-toolbar">
        <div className="market-search">
          <input
            value={keyword}
            placeholder="搜索员工名称 / 岗位 / 简介"
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void loadMarket(keyword, category)
            }}
          />
          <button className="ghost" onClick={() => void loadMarket(keyword, category)}>搜索</button>
          {(keyword || category !== '全部') && (
            <button className="ghost" onClick={resetFilters}>重置</button>
          )}
        </div>
        <div className="market-cats">
          <button
            className={category === '全部' ? 'market-cat on' : 'market-cat'}
            onClick={() => selectCategory('全部')}
          >
            全部
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              className={category === cat ? 'market-cat on' : 'market-cat'}
              onClick={() => selectCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      <div className="market-count muted small">
        {loading ? '正在加载商城…' : `共 ${items.length} 位员工`}
      </div>

      {items.length === 0 && !loading ? (
        <div className="empty-state">没有找到匹配的员工，换个关键词或分类试试。</div>
      ) : (
        <div className="market-grid">
          {items.map((emp) => {
            const badge = badgeOf(emp)
            const installed = !!emp.installed
            const canInstall = !installed && (emp.isBundled || emp.price <= 0 || emp.userPurchaseStatus === 'active')
            return (
              <div className="market-card" key={emp.slug}>
                <div className="market-card-head">
                  <div className="market-avatar">{emp.avatarEmoji || '🤖'}</div>
                  <div className="market-card-title">
                    <b>{emp.name}</b>
                    <span className="muted small">{emp.category || '未分类'}</span>
                  </div>
                  <span className={`market-badge ${badge.cls}`}>{badge.label}</span>
                </div>
                <p className="market-desc" title={emp.description || ''}>
                  {emp.description || '这位员工还没有填写简介。'}
                </p>
                <div className="market-price">{priceText(emp)}</div>
                {emp.requiredPackage && <div className="muted small">需要套餐：{emp.requiredPackage}</div>}
                <div className="market-actions">
                  {installed ? (
                    <button className="ghost" onClick={onGoOffice}>去办公区</button>
                  ) : canInstall ? (
                    <button
                      className="primary market-buy-btn"
                      disabled={busySlug === emp.slug}
                      onClick={() => void installEmployee(emp)}
                    >
                      {busySlug === emp.slug ? '添加中…' : '添加'}
                    </button>
                  ) : (
                    <button
                      className="primary market-buy-btn"
                      disabled={busySlug === emp.slug}
                      onClick={() => openBuy(emp)}
                    >
                      购买
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <section className="market-orders">
        <div className="market-orders-head">
          <h3>我的订单</h3>
          <button className="ghost small" disabled={ordersLoading} onClick={() => void loadOrders()}>
            {ordersLoading ? '刷新中…' : '刷新'}
          </button>
        </div>
        {ordersError && <div className="notice err">{ordersError}</div>}
        {orders.length === 0 ? (
          <div className="empty-state">还没有订单。购买收费员工后，订单会显示在这里。</div>
        ) : (
          <table className="table market-table">
            <thead>
              <tr>
                <th>订单号</th>
                <th>员工</th>
                <th>天数</th>
                <th>金额</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id || order.orderNo}>
                  <td className="mono">{order.orderNo}</td>
                  <td>{nameOfSlug(order.employeeSlug)}</td>
                  <td>{order.durationDays} 天</td>
                  <td>{order.totalAmount} 积分</td>
                  <td>
                    <span className={`pill market-status status-${order.status}`}>
                      {ORDER_STATUS[order.status] || order.status}
                    </span>
                  </td>
                  <td className="muted">{fmtDateTime(order.createdAt)}</td>
                  <td>
                    {order.status === 'pending' && !order.expired && (
                      <button className="ghost small" onClick={() => void resumePay(order)}>去支付</button>
                    )}
                    {order.status === 'pending' && order.expired && <span className="muted">已超时</span>}
                    {order.status === 'paid' && (
                      <button
                        className="ghost small"
                        disabled={busySlug === order.employeeSlug}
                        onClick={() => void installBySlug(order.employeeSlug)}
                      >
                        添加员工
                      </button>
                    )}
                    {order.status !== 'pending' && order.status !== 'paid' && <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {buy && (
        <div className="market-modal-mask" onClick={closeModal}>
          <div className="market-modal" onClick={(e) => e.stopPropagation()}>
            <div className="market-modal-head">
              <h3>{payDone ? '支付成功' : `购买「${buy.name}」`}</h3>
              <button className="ghost small" onClick={closeModal}>关闭</button>
            </div>

            {payDone ? (
              <div className="market-modal-body">
                <div className="notice ok">支付成功，员工已自动添加。</div>
                <p className="muted small">订单号：{payOrderNo || '—'}。也可以稍后在「我的订单」里查看。</p>
                <div className="market-modal-actions">
                  <button
                    className="ghost"
                    onClick={() => {
                      closeModal()
                      onGoOffice()
                    }}
                  >
                    去员工办公区
                  </button>
                  <button className="primary market-buy-btn" onClick={closeModal}>继续逛逛</button>
                </div>
              </div>
            ) : payInfo ? (
              <div className="market-modal-body">
                <div className="market-qr-wrap">
                  <img
                    className="market-qr"
                    width={220}
                    height={220}
                    alt="微信支付二维码"
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(payInfo.codeUrl)}`}
                  />
                </div>
                <p className="market-sum">
                  应付 <b>{payInfo.amount} 积分</b>，请用微信扫一扫完成支付。
                </p>
                <p className="muted small">
                  二维码有效至 {payInfo.expiresAt ? fmtDateTime(payInfo.expiresAt) : '30 分钟后'}；
                  支付成功后会自动添加员工，本窗口会自动刷新。
                </p>
                {payInfo.mock && <div className="notice muted">当前是开发/测试环境的模拟支付，不会真实扣款。</div>}
                <div className="market-pay-wait">正在等待支付结果…（每 3 秒自动查询一次）</div>
                {payError && (
                  <div className="notice err">
                    <div>{payError}</div>
                    {payError.includes(WECHAT_MISSING) && (
                      <div className="muted small">管理员确认收款后会自动开通，可稍后在下方订单里查看。</div>
                    )}
                  </div>
                )}
                <a className="link" href={payInfo.codeUrl} target="_blank" rel="noreferrer">
                  二维码打不开？点此打开支付链接
                </a>
              </div>
            ) : (
              <div className="market-modal-body">
                <div className="market-form-row">
                  <span>员工</span>
                  <b>{buy.name}</b>
                </div>
                <div className="market-form-row">
                  <span>单价</span>
                  <b>{buy.priceDisplay || `${buy.price} 积分/天`}{buy.price > 0 ? `（${buy.price} 积分/天）` : ''}</b>
                </div>
                {buy.mode === 'new' ? (
                  <div className="market-form-row">
                    <span>购买时长</span>
                    <select
                      value={selectedDays}
                      onChange={(e) => setSelectedDays(Number(e.target.value))}
                      className="market-duration"
                    >
                      {durationList.map((opt) => (
                        <option key={opt.days} value={opt.days}>
                          {opt.label}（{opt.days} 天）
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="market-form-row">
                    <span>订单</span>
                    <b className="mono">{buy.order?.orderNo || payOrderNo || '—'}（{selectedDays} 天）</b>
                  </div>
                )}
                <div className="market-form-row market-total">
                  <span>合计</span>
                  <b>{totalAmount} 积分</b>
                </div>
                <p className="muted small">
                  请在下单后 30 分钟内完成支付，超时订单会自动关闭；支付成功后员工会自动添加到员工办公区。
                </p>
                {durationsError && <div className="notice muted">{durationsError}</div>}
                {payError && (
                  <div className="notice err">
                    <div>{payError}</div>
                    {payError.includes(WECHAT_MISSING) && (
                      <div className="muted small">管理员确认收款后会自动开通，可稍后在下方订单里查看。</div>
                    )}
                  </div>
                )}
                <button
                  className="primary"
                  disabled={paying}
                  onClick={() => {
                    if (buy.mode === 'resume' && buy.order) void resumePay(buy.order)
                    else void createAndPay()
                  }}
                >
                  {paying ? '处理中…' : buy.mode === 'new' ? '创建订单并支付' : '去支付'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
