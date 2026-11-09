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

// ---- 定时发布（P26）：本地队列，到点由主进程 client 触发平台发布 ----
interface QueueJob {
  id: string
  /** 兼容老队列：等于 platforms[0] */
  platform: string
  /** P31 多平台 */
  platforms?: string[]
  results?: { platform: string; ok: boolean; url?: string; message: string }[]
  type: 'video' | 'image'
  title: string
  content: string
  tags: string[]
  mediaPaths: string[]
  scheduledAt: string
  status: 'pending' | 'running' | 'done' | 'failed'
  attempts: number
  url?: string
  message?: string
  late?: boolean
}

interface QueueApi {
  list: () => Promise<CronResult<{ items: QueueJob[] }>>
  add: (input: any) => Promise<CronResult<QueueJob>>
  remove: (id: string) => Promise<CronResult<{ removed: boolean }>>
  retry: (id: string) => Promise<CronResult<QueueJob>>
}

const PLATFORMS = [
  { id: 'douyin', label: '抖音' },
  { id: 'xiaohongshu', label: '小红书' },
  { id: 'shipinhao', label: '视频号' }
]

const JOB_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '等待发布', cls: 'pill' },
  running: { label: '发布中', cls: 'pill status-awaiting_approval' },
  done: { label: '已发布', cls: 'pill ok' },
  failed: { label: '失败', cls: 'pill status-failed' }
}

function queueApi(): QueueApi {
  const api = (window as any).fcm?.queue as QueueApi | undefined
  if (!api) throw new Error('定时发布功能未就绪，请重启客户端')
  return api
}

function platformName(id: string): string {
  return PLATFORMS.find((item) => item.id === id)?.label || id
}

/** Date -> datetime-local 需要的本地时间字符串（不能用 toISOString，那是 UTC） */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    date.getFullYear() +
    '-' + pad(date.getMonth() + 1) +
    '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) +
    ':' + pad(date.getMinutes())
  )
}

function defaultScheduleInput(): string {
  return toLocalInput(new Date(Date.now() + 60 * 60 * 1000))
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

  // 定时发布表单
  const [jobs, setJobs] = useState<QueueJob[]>([])
  const [jobsLoading, setJobsLoading] = useState(true)
  // 新建任务默认勾选抖音；可勾 1~3 个平台，到点按勾选顺序串行发布。
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>(['douyin'])
  const [mediaType, setMediaType] = useState<'video' | 'image'>('video')
  const [pubTitle, setPubTitle] = useState('')
  const [pubContent, setPubContent] = useState('')
  const [pubTags, setPubTags] = useState('')
  const [mediaPaths, setMediaPaths] = useState<string[]>([])
  const [scheduledAt, setScheduledAt] = useState(defaultScheduleInput())

  function togglePlatform(id: string): void {
    setSelectedPlatforms((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }

  function toggleAllPlatforms(): void {
    setSelectedPlatforms((prev) => (prev.length === PLATFORMS.length ? [] : PLATFORMS.map((item) => item.id)))
  }

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

  async function refreshQueue(): Promise<void> {
    setJobsLoading(true)
    try {
      const result = await queueApi().list()
      if (!result.ok) {
        setError(result.error || '读取定时发布队列失败')
        return
      }
      setJobs(result.data?.items || [])
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setJobsLoading(false)
    }
  }

  useEffect(() => {
    void refreshQueue()
    // 主进程发布成功/失败后会推 queue:event，这里跟着刷新列表。
    let off: (() => void) | undefined
    try {
      off = (window as any).fcm?.queue?.onEvent(() => {
        void refreshQueue()
      })
    } catch {
      /* 老版本 preload 没有 onEvent，忽略 */
    }
    return () => {
      if (off) off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function pickMedia(): Promise<void> {
    setError('')
    try {
      const picked = await (window as any).fcm.platform.pickMedia({ type: mediaType })
      const paths: string[] = picked?.paths || []
      if (paths.length === 0) return
      setMediaPaths(paths)
    } catch (e: any) {
      setError(String(e?.message || e))
    }
  }

  async function addJob(): Promise<void> {
    setError('')
    setNotice('')
    setBusy('add-job')
    try {
      const result = await queueApi().add({
        platforms: selectedPlatforms,
        type: mediaType,
        title: pubTitle.trim(),
        content: pubContent,
        tags: pubTags,
        mediaPaths,
        scheduledAt
      })
      if (!result.ok) {
        setError(result.error || '加入定时队列失败')
        return
      }
      const savedPlatforms = result.data!.platforms && result.data!.platforms.length > 0 ? result.data!.platforms : [result.data!.platform]
      setNotice('已排程：' + savedPlatforms.map(platformName).join('/') + '「' + result.data!.title + '」将于 ' + fmtTime(result.data!.scheduledAt) + ' 自动发布')
      setPubTitle('')
      setPubContent('')
      setPubTags('')
      setMediaPaths([])
      setScheduledAt(defaultScheduleInput())
      await refreshQueue()
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy('')
    }
  }

  async function removeJob(job: QueueJob): Promise<void> {
    setError('')
    setNotice('')
    if (!window.confirm('确定从队列里删掉「' + job.title + '」吗？')) return
    setBusy('job-del:' + job.id)
    try {
      const result = await queueApi().remove(job.id)
      if (!result.ok) {
        setError(result.error || '删除定时发布失败')
        return
      }
      setNotice('已删除定时发布：' + job.title)
      await refreshQueue()
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy('')
    }
  }

  async function retryJob(job: QueueJob): Promise<void> {
    setError('')
    setNotice('')
    setBusy('job-retry:' + job.id)
    try {
      const result = await queueApi().retry(job.id)
      if (!result.ok) {
        setError(result.error || '重试失败')
        return
      }
      setNotice('已重新排入队列，稍后自动重试：' + job.title)
      await refreshQueue()
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy('')
    }
  }

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

      <div className="page-head" style={{ marginTop: 28 }}>
        <h2>定时发布</h2>
        <p>
          到点由本机自动把作品发到抖音 / 小红书 / 视频号（复用客户端里已扫码登录的会话）。
          客户端关着的时候到点的任务，下次打开会立刻补发。
        </p>
        <button className="ghost small" disabled={jobsLoading} onClick={() => void refreshQueue()}>
          {jobsLoading ? '刷新中…' : '刷新队列'}
        </button>
      </div>

      <section className="card">
        <h3>发布队列</h3>
        {jobsLoading ? (
          <p className="muted small">读取中…</p>
        ) : jobs.length === 0 ? (
          <div className="empty-state">
            <p>队列里还没有定时发布</p>
            <p className="muted small">在下方选平台、填标题、选素材和时间，到点自动发布。</p>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>计划时间</th>
                <th>平台</th>
                <th>标题</th>
                <th>状态</th>
                <th>结果</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const meta = JOB_STATUS[job.status] || JOB_STATUS.pending
                return (
                  <tr key={job.id}>
                    <td>
                      {fmtTime(job.scheduledAt)}
                      {job.late ? <span className="muted small"> 迟到补发</span> : null}
                    </td>
                    <td>
                      {(job.platforms && job.platforms.length > 0 ? job.platforms : [job.platform]).map(platformName).join('/')}
                    </td>
                    <td title={job.title}>{job.title.length > 18 ? job.title.slice(0, 18) + '…' : job.title}</td>
                    <td>
                      <span className={meta.cls}>{meta.label}</span>
                      {job.attempts > 1 ? <span className="muted small"> 第 {job.attempts} 次</span> : null}
                    </td>
                    <td>
                      {job.results && job.results.length > 0 ? (
                        job.results.map((result) => (
                          <div key={result.platform} className={result.ok ? 'muted small' : 'error small'}>
                            {result.ok ? '✓' : '✗'} {platformName(result.platform)}{' '}
                            {result.ok ? (
                              result.url ? (
                                <a href={result.url} target="_blank" rel="noreferrer">
                                  已发布
                                </a>
                              ) : (
                                '已发布'
                              )
                            ) : (
                              result.message
                            )}
                          </div>
                        ))
                      ) : job.url ? (
                        <a href={job.url} target="_blank" rel="noreferrer">
                          打开作品
                        </a>
                      ) : (
                        <span className={job.status === 'failed' ? 'error small' : 'muted small'}>
                          {job.message || '—'}
                        </span>
                      )}
                    </td>
                    <td>
                      {job.status === 'failed' ? (
                        <button className="ghost small" disabled={busy !== ''} onClick={() => void retryJob(job)}>
                          {busy === 'job-retry:' + job.id ? '重试中…' : '重试'}
                        </button>
                      ) : null}
                      <button
                        className="ghost small"
                        disabled={busy !== '' || job.status === 'running'}
                        onClick={() => void removeJob(job)}
                      >
                        {busy === 'job-del:' + job.id ? '删除中…' : '删除'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card platform-form">
        <h3>新建定时发布</h3>
        <div className="platform-form-row">
          <div>
            <span className="muted small">平台（可多选，到点按勾选顺序串行发布）</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
              {PLATFORMS.map((item) => (
                <label
                  key={item.id}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, margin: 0, color: 'inherit', fontSize: 13 }}
                >
                  <input
                    type="checkbox"
                    checked={selectedPlatforms.includes(item.id)}
                    onChange={() => togglePlatform(item.id)}
                  />
                  {item.label}
                </label>
              ))}
              <button type="button" className="ghost small" onClick={toggleAllPlatforms}>
                {selectedPlatforms.length === PLATFORMS.length ? '取消全选' : '全选'}
              </button>
            </div>
          </div>
          <label>
            素材类型
            <select value={mediaType} onChange={(e) => setMediaType(e.target.value as 'video' | 'image')}>
              <option value="video">视频</option>
              <option value="image">图文</option>
            </select>
          </label>
        </div>
        <label>
          标题
          <input
            value={pubTitle}
            onChange={(e) => setPubTitle(e.target.value)}
            placeholder={selectedPlatforms.includes('xiaohongshu') ? '小红书标题建议 20 字以内' : '作品标题'}
            autoComplete="off"
          />
        </label>
        <label>
          正文 / 文案
          <textarea
            value={pubContent}
            onChange={(e) => setPubContent(e.target.value)}
            rows={4}
            placeholder="作品描述、话题、@ 都可以写在这里"
          />
        </label>
        <div className="platform-form-row">
          <label>
            话题标签
            <input
              value={pubTags}
              onChange={(e) => setPubTags(e.target.value)}
              placeholder="AI, 效率工具"
              autoComplete="off"
            />
          </label>
          <label>
            发布时间
            <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
          </label>
        </div>
        <label>
          素材文件
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="ghost small" onClick={() => void pickMedia()}>
              选择{mediaType === 'image' ? '图片' : '视频'}
            </button>
            <span className="muted small">
              {mediaPaths.length === 0 ? '还没有选择素材' : mediaPaths.map((item) => item.split(/[\\/]/).pop()).join('、')}
            </span>
          </div>
        </label>
        <p className="hint">
          到点后客户端会用已登录的账号逐个平台串行上传发布（不会同时开多个窗口），勾的平台越多耗时越长。
          每步截图存在 platform-logs 目录便于排查。
          {mediaType === 'image' ? ' 图文支持一次选多张图片。' : ''}
          {selectedPlatforms.length === 0 ? ' 请至少勾选一个平台。' : ''}
        </p>
        <button
          className="primary"
          disabled={busy !== '' || !pubTitle.trim() || mediaPaths.length === 0 || !scheduledAt || selectedPlatforms.length === 0}
          onClick={() => void addJob()}
        >
          {busy === 'add-job' ? '提交中…' : '加入定时队列'}
        </button>
      </section>
    </div>
  )
}
