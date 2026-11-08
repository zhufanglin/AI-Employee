import { useEffect, useState } from 'react'

interface CronItem {
  cronId: string
  employeeSlug: string
  employeeName: string
  cronExpr: string
  timezone: string
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
}

interface CronResult<T> {
  ok: boolean
  data?: T
  error?: string
}

interface CronApi {
  list: () => Promise<CronResult<{ items: CronItem[]; total: number }>>
  create: (input: { employeeSlug: string; cronExpr: string; timezone?: string }) => Promise<CronResult<{ cronId: string; nextRunAt: string | null }>>
  remove: (input: { cronId: string }) => Promise<CronResult<{ deleted: boolean }>>
}

const EXAMPLES = [
  { label: '每天 9 点', expr: '0 9 * * *' },
  { label: '每周一 10 点', expr: '0 10 * * 1' },
  { label: '每小时', expr: '0 * * * *' }
]

function cronApi(): CronApi {
  // preload 尚未合并 cron 类型时先用 any，避免类型检查阻塞页面集成。
  const api = (window as any).fcm?.cron as CronApi | undefined
  if (!api) throw new Error('定时任务功能未就绪，请重启客户端')
  return api
}

function fmtTime(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

function employeeLabel(item: CronItem): string {
  if (item.employeeName && item.employeeSlug) return item.employeeName + '（' + item.employeeSlug + '）'
  return item.employeeName || item.employeeSlug || '—'
}

export default function Scheduled() {
  const [items, setItems] = useState<CronItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [employeeSlug, setEmployeeSlug] = useState('')
  const [cronExpr, setCronExpr] = useState('0 9 * * *')
  const [timezone, setTimezone] = useState('Asia/Shanghai')

  async function refresh(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const result = await cronApi().list()
      if (!result.ok) {
        setError(result.error || '读取定时任务失败')
        return
      }
      setItems(result.data?.items || [])
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // 只在首次进入页面时读取一次列表。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function create(): Promise<void> {
    setError('')
    setNotice('')
    setBusy('create')
    try {
      const result = await cronApi().create({
        employeeSlug: employeeSlug.trim(),
        cronExpr: cronExpr.trim(),
        timezone: timezone.trim() || 'Asia/Shanghai'
      })
      if (!result.ok) {
        // 服务端中文错误原文直接展示，便于用户判断是员工未安装还是表达式不合法。
        setError(result.error || '创建定时任务失败')
        return
      }
      setNotice('已创建定时任务：' + (result.data?.cronId || '') + '，下次运行 ' + fmtTime(result.data?.nextRunAt))
      await refresh()
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy('')
    }
  }

  async function remove(item: CronItem): Promise<void> {
    setError('')
    setNotice('')
    if (!window.confirm('确定删除「' + item.cronExpr + '」这条定时任务吗？')) return
    setBusy('delete:' + item.cronId)
    try {
      const result = await cronApi().remove({ cronId: item.cronId })
      if (!result.ok) {
        setError(result.error || '删除定时任务失败')
        return
      }
      setNotice('已删除定时任务：' + item.cronId)
      await refresh()
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>定时任务</h2>
        <p>按 cron 表达式定时运行已安装的员工，到点自动触发。</p>
        <button className="ghost small" disabled={loading || busy !== ''} onClick={() => void refresh()}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice ok">{notice}</p>}

      <section className="card">
        <h3>任务列表</h3>
        {loading ? (
          <p className="muted small">读取中…</p>
        ) : items.length === 0 ? (
          <div className="empty-state">
            <p>还没有定时任务</p>
            <p className="muted small">在下方填写员工 slug 和 cron 表达式创建第一条。</p>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>员工</th>
                <th>表达式</th>
                <th>时区</th>
                <th>下次运行</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.cronId}>
                  <td>{employeeLabel(item)}</td>
                  <td className="mono">{item.cronExpr}</td>
                  <td>{item.timezone || '—'}</td>
                  <td>{fmtTime(item.nextRunAt)}</td>
                  <td>
                    <span className={item.enabled ? 'pill ok' : 'pill'}>{item.enabled ? '启用' : '停用'}</span>
                  </td>
                  <td>
                    <button
                      className="ghost small"
                      disabled={busy !== ''}
                      onClick={() => void remove(item)}
                    >
                      {busy === 'delete:' + item.cronId ? '删除中…' : '删除'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card platform-form">
        <h3>新建定时任务</h3>
        <div className="platform-form-row">
          <label>
            员工 slug
            <input
              value={employeeSlug}
              onChange={(e) => setEmployeeSlug(e.target.value)}
              placeholder="例如 boss-lead-radar"
              autoComplete="off"
            />
          </label>
          <label>
            时区
            <input
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="Asia/Shanghai"
              autoComplete="off"
            />
          </label>
        </div>
        <label>
          cron 表达式
          <input
            value={cronExpr}
            onChange={(e) => setCronExpr(e.target.value)}
            placeholder="0 9 * * *"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="example-row" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <span className="muted small">常用：</span>
          {EXAMPLES.map((example) => (
            <button
              key={example.expr}
              type="button"
              className="ghost small"
              onClick={() => setCronExpr(example.expr)}
            >
              {example.label}
            </button>
          ))}
        </div>
        <p className="hint">5 段标准 cron：分 时 日 月 周，例如 0 9 * * * 表示每天 09:00。</p>
        <button
          className="primary"
          disabled={busy !== '' || !employeeSlug.trim() || !cronExpr.trim()}
          onClick={() => void create()}
        >
          {busy === 'create' ? '创建中…' : '创建定时任务'}
        </button>
      </section>
    </div>
  )
}
