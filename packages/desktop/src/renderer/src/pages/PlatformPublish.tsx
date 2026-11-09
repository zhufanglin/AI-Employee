import { useEffect, useState } from 'react'
import type {
  PlatformCommentsSnapshot,
  PlatformMetrics,
  PlatformPublishResult,
  PlatformReplyResult,
  PlatformStatsSnapshot,
  PlatformStatus
} from '../types'

const PLATFORMS: { id: string; name: string; tip: string; types: string }[] = [
  { id: 'douyin', name: '抖音', tip: '创作者中心 · 视频 / 图文', types: '视频、图文' },
  { id: 'xiaohongshu', name: '小红书', tip: '创作服务平台 · 视频 / 图文笔记', types: '视频、图文' },
  { id: 'shipinhao', name: '视频号', tip: '视频号助手 · 视频 / 图文', types: '视频、图文' }
]

/** 给可能挂住的调用加个上限：主进程会话卡住时也要把按钮恢复可用 */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    p.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * 登录态检查要开隐藏窗口+等页面渲染，一次十几秒。
 * 页面切走再回来不该又等一遍 —— 渲染层用模块级缓存先顶上，主进程 platform.status 也有 5 分钟缓存。
 */
const RENDERER_CACHE_MS = 5 * 60 * 1000
let statusMemo: { at: number; items: PlatformStatus[] } | null = null
function rememberStatus(items: PlatformStatus[]) {
  statusMemo = { at: Date.now(), items }
  return items
}

export default function PlatformPublish() {
  const [statuses, setStatuses] = useState<PlatformStatus[]>(statusMemo?.items || [])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<PlatformPublishResult | null>(null)
  // P25 作品数据快照：把平台「数据」页的可见文案读回来，给用户看、也能贴给员工分析
  const [stats, setStats] = useState<PlatformStatsSnapshot | null>(null)
  // P30：把快照文本解析成结构化指标（播放/点赞/朋友、作品条目），失败不影响原始快照展示
  const [metrics, setMetrics] = useState<PlatformMetrics | null>(null)
  const [metricsError, setMetricsError] = useState('')
  // P32 评论回复：先读评论列表，再挑一条回
  const [comments, setComments] = useState<PlatformCommentsSnapshot | null>(null)
  const [replyDraft, setReplyDraft] = useState<Record<number, string>>({})
  const [replyResult, setReplyResult] = useState<PlatformReplyResult | null>(null)
  // P33 一键分发：同一份内容按顺序发到多个平台，逐个落结果
  const [targets, setTargets] = useState<string[]>(['douyin'])
  const [multiResults, setMultiResults] = useState<PlatformPublishResult[]>([])
  const [progress, setProgress] = useState('')

  // P33：不再单选平台，改成多选（targets 就是发布目标列表）
  const [type, setType] = useState<'video' | 'image'>('video')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState('')
  const [mediaPaths, setMediaPaths] = useState<string[]>([])

  async function refresh(force = false) {
    if (!force && statusMemo && Date.now() - statusMemo.at < RENDERER_CACHE_MS) {
      setStatuses(statusMemo.items)
      return
    }
    setLoading(true)
    setError('')
    try {
      const items = await window.fcm.platform.status(force ? { force: true } : {})
      setStatuses(rememberStatus(items || []))
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // 先让主进程把三个隐藏窗口热起来（不阻塞）：扫码登录弹窗就不用白屏等好几秒
    void window.fcm.platform.warm?.().catch(() => null)
    void refresh()
  }, [])

  const statusOf = (id: string) => statuses.find((s) => s.platform === id)

  async function login(id: string) {
    setBusy('login:' + id)
    setError('')
    try {
      const st = await withTimeout(
        window.fcm.platform.login({ platform: id }),
        210000,
        '登录等待超时（窗口可能已关闭），请重新点击「扫码登录」'
      )
      setStatuses((prev) => {
        const next = prev.filter((s) => s.platform !== st.platform)
        next.push(st)
        return rememberStatus(next)
      })
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy('')
    }
  }

  async function logout(id: string) {
    setBusy('logout:' + id)
    setError('')
    try {
      await window.fcm.platform.logout({ platform: id })
      await refresh(true)
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy('')
    }
  }

  async function loadStats(id: string) {
    setBusy('stats:' + id)
    setError('')
    setStats(null)
    setMetrics(null)
    setMetricsError('')
    try {
      const snap = await withTimeout(
        window.fcm.platform.stats({ platform: id, maxChars: 4000 }),
        180000,
        '读取数据超时（窗口可能已关闭），请重试'
      )
      setStats(snap)
      if (snap?.text) void parseMetrics(id, snap.text)
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy('')
    }
  }

  /** P30：文本 → 结构化指标；解析失败只提示，不影响上面的原始快照 */
  async function parseMetrics(id: string, text: string) {
    try {
      const r = await window.fcm.platform.parseMetrics({ platform: id, text })
      if (r && r.ok) setMetrics(r.data)
      else setMetricsError(String((r as any)?.error || '解析失败'))
    } catch (e: any) {
      setMetricsError(String(e?.message || e))
    }
  }

  /** P32：读评论列表 */
  async function loadComments(id: string) {
    setBusy('comments:' + id)
    setError('')
    setComments(null)
    setReplyResult(null)
    setReplyDraft({})
    try {
      const snap = await withTimeout(
        window.fcm.platform.comments({ platform: id, maxItems: 30 }),
        180000,
        '读取评论超时（窗口可能已关闭），请重试'
      )
      setComments(snap)
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy('')
    }
  }

  /** P32：回复第 index 条评论 */
  async function sendReply(id: string, index: number) {
    const text = (replyDraft[index] || '').trim()
    if (!text) { setError('回复内容不能为空'); return }
    setBusy('reply:' + index)
    setError('')
    setReplyResult(null)
    try {
      const r = await withTimeout(
        window.fcm.platform.replyComment({ platform: id, index, text }),
        180000,
        '回复超时（窗口可能已关闭），请重试'
      )
      setReplyResult(r)
      if (r?.ok) setReplyDraft((prev) => ({ ...prev, [index]: '' }))
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy('')
    }
  }

  async function openDebug(id: string) {
    setBusy('debug:' + id)
    setError('')
    try {
      await window.fcm.platform.openDebug({ platform: id })
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy('')
    }
  }

  async function pick() {
    setError('')
    try {
      const r = await window.fcm.platform.pickMedia({ type })
      if (r?.paths?.length) setMediaPaths(r.paths)
    } catch (e: any) {
      setError(String(e?.message || e))
    }
  }

  function toggleTarget(id: string) {
    setTargets((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]))
  }

  async function publish() {
    if (!content.trim()) { setError('正文不能为空'); return }
    if (!mediaPaths.length) { setError('请先选择素材文件'); return }
    if (!targets.length) { setError('请至少选择一个要发布的平台'); return }
    setBusy('publish')
    setError('')
    setResult(null)
    setMultiResults([])
    const payload = {
      type,
      title: title.trim(),
      content: content.trim(),
      tags: tags.split(/[,，\s]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean),
      mediaPaths
    }
    const acc: PlatformPublishResult[] = []
    for (const id of targets) {
      setProgress('（' + (acc.length + 1) + '/' + targets.length + '）正在发布到 ' + nameOf(id) + '…')
      try {
        const r = await window.fcm.platform.publish({ ...payload, platform: id })
        acc.push(r)
      } catch (e: any) {
        acc.push({
          platform: id,
          ok: false,
          message: String(e?.message || e),
          screenshots: [],
          steps: []
        })
      }
      setMultiResults([...acc])
    }
    setProgress('')
    if (acc.length === 1) setResult(acc[0])
    else {
      const bad = acc.filter((r) => !r.ok)
      if (bad.length) setError(bad.length + '/' + acc.length + ' 个平台没发成功：' + bad.map((r) => nameOf(r.platform)).join('、'))
    }
    setBusy('')
  }

  function nameOf(id: string) {
    return PLATFORMS.find((p) => p.id === id)?.name || id
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>📤 平台发布</h2>
          <p className="muted small">
            在你自己的电脑上打开创作后台自动发布（抖音 / 小红书 / 视频号）。首次使用需点「扫码登录」，登录态保存在本机。
          </p>
        </div>
        <button className="ghost" onClick={() => void refresh(true)} disabled={loading}>{loading ? '检查中…（约 10 秒）' : '刷新登录状态'}</button>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="platform-cards">
        {PLATFORMS.map((p) => {
          const st = statusOf(p.id)
          return (
            <div className={'platform-card' + (st?.loggedIn ? ' on' : '')} key={p.id}>
              <div className="platform-card-head">
                <b>{p.name}</b>
                <span className={st?.loggedIn ? 'pill ok' : 'pill'}>{st ? (st.loggedIn ? (st.nickname || '已登录') : '未登录') : '未检查'}</span>
              </div>
              <p className="muted small">{p.tip}</p>
              {st?.error && <p className="hint">{st.error}</p>}
              {st?.checkedAt && <p className="hint">检查时间：{new Date(st.checkedAt).toLocaleTimeString()}</p>}
              <div className="platform-card-actions">
                <button className="ghost" disabled={busy === 'login:' + p.id} onClick={() => void login(p.id)}>
                  {busy === 'login:' + p.id ? '请在弹窗中扫码…' : '扫码登录'}
                </button>
                <button className="ghost" disabled={busy === 'stats:' + p.id} onClick={() => void loadStats(p.id)}>
                  {busy === 'stats:' + p.id ? '读取数据中…' : '数据快照'}
                </button>
                <button className="ghost" disabled={busy === 'comments:' + p.id} onClick={() => void loadComments(p.id)}>
                  {busy === 'comments:' + p.id ? '读评论中…' : '读评论'}
                </button>
                <button className="ghost" disabled={busy === 'debug:' + p.id} onClick={() => void openDebug(p.id)}>打开后台</button>
                <button className="ghost" disabled={!st?.loggedIn || busy === 'logout:' + p.id} onClick={() => void logout(p.id)}>退出</button>
              </div>
            </div>
          )
        })}
      </div>

      {stats && (
        <section className="card">
          <h3>作品数据 · {stats.name || stats.platform}</h3>
          <p className={stats.ok ? 'ok-text' : 'error'}>{stats.message}</p>
          {stats.pageTitle && <p className="hint">页面标题：{stats.pageTitle}</p>}
          {metricsError && <p className="hint">（结构化解析没成功：{metricsError}，下面仍可看原始文本）</p>}
          {metrics && (
            <div className="platform-metrics">
              {metrics.metrics.length > 0 && (
                <div className="platform-metrics-grid">
                  {metrics.metrics.map((m) => (
                    <div className="platform-metric" key={m.label + ':' + m.raw}>
                      <span className="platform-metric-label">{m.label}</span>
                      <b className="platform-metric-value">{m.value === null ? '—' : m.value.toLocaleString()}</b>
                      <span className="platform-metric-raw">{m.raw}</span>
                    </div>
                  ))}
                </div>
              )}
              {metrics.works.length > 0 && (
                <table className="platform-works">
                  <thead>
                    <tr><th>作品</th><th>播放</th><th>点赞</th><th>评论</th><th>发布时间</th></tr>
                  </thead>
                  <tbody>
                    {metrics.works.map((w, i) => (
                      <tr key={w.raw + ':' + i}>
                        <td title={w.raw}>{w.title}</td>
                        <td>{w.playCount === null ? '—' : w.playCount.toLocaleString()}</td>
                        <td>{w.likeCount === null ? '—' : w.likeCount.toLocaleString()}</td>
                        <td>{w.commentCount === null ? '—' : w.commentCount.toLocaleString()}</td>
                        <td>{w.publishedAt || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {metrics.notes.length > 0 && (
                <ul className="hint platform-metrics-notes">
                  {metrics.notes.map((n) => <li key={n}>{n}</li>)}
                </ul>
              )}
            </div>
          )}
          {stats.text && (
            <details className="platform-stats-raw">
              <summary>原始页面文本（{stats.text.length} 字）</summary>
              <pre className="platform-stats-text">{stats.text}</pre>
            </details>
          )}
          {!!stats.screenshots?.length && <p className="hint">截图：{stats.screenshots.join('　')}</p>}
        </section>
      )}

      {comments && (
        <section className="card platform-comments">
          <h3>评论回复 · {comments.name || comments.platform}</h3>
          <p className={comments.ok ? 'ok-text' : 'error'}>{comments.message}</p>
          {!comments.loggedIn && <p className="hint">登录后才有权限读写评论，请先点上面的「扫码登录」。</p>}
          {comments.items.length > 0 && (
            <ul className="platform-comment-list">
              {comments.items.map((it) => (
                <li key={it.index} className="platform-comment-item">
                  <div className="platform-comment-text">
                    <span className="pill">#{it.index}</span>
                    <span title={it.text}>{it.text}</span>
                  </div>
                  <div className="platform-comment-reply">
                    <input
                      value={replyDraft[it.index] || ''}
                      placeholder={'回复这条（最多 500 字）'}
                      onChange={(e) => setReplyDraft((prev) => ({ ...prev, [it.index]: e.target.value }))}
                    />
                    <button
                      className="ghost"
                      disabled={busy === 'reply:' + it.index}
                      onClick={() => void sendReply(comments.platform, it.index)}
                    >
                      {busy === 'reply:' + it.index ? '发送中…' : '回复'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {replyResult && (
            <div className="platform-reply-result">
              <p className={replyResult.ok ? 'ok-text' : 'error'}>{replyResult.message}</p>
              <ol className="platform-steps">
                {replyResult.steps?.map((s, i) => (
                  <li key={i} className={s.ok ? '' : 'fail'}>
                    <span>{s.step}</span>
                    <span>{s.ok ? '✓' : '✗'}{s.detail ? ' ' + s.detail : ''}</span>
                  </li>
                ))}
              </ol>
              {!!replyResult.screenshots?.length && <p className="hint">过程截图：{replyResult.screenshots.join('　')}</p>}
            </div>
          )}
          <p className="hint">
            回复是按「第几条」定位的（#0 是最上面那条），所以抓完评论请尽快回复；页面结构变化时可能读不到评论，可点「打开后台」手动处理。
          </p>
        </section>
      )}

      <section className="card platform-form">
        <h3>新建发布</h3>
        <div className="platform-form-row">
          <label>类型
            <select value={type} onChange={(e) => setType(e.target.value as 'video' | 'image')}>
              <option value="video">视频</option>
              <option value="image">图文</option>
            </select>
          </label>
          <div className="platform-targets">
            <span className="muted small">发布到</span>
            {PLATFORMS.map((p) => {
              const st = statusOf(p.id)
              return (
                <label key={p.id} className={'platform-target' + (targets.includes(p.id) ? ' on' : '')}>
                  <input type="checkbox" checked={targets.includes(p.id)} onChange={() => toggleTarget(p.id)} />
                  {p.name}
                  {st && !st.loggedIn && <span className="hint">（未登录）</span>}
                </label>
              )
            })}
            <button className="ghost tiny" onClick={() => setTargets(PLATFORMS.map((p) => p.id))}>全选</button>
          </div>
        </div>
        <p className="hint">
          选多个平台会按顺序一个个发（同一个窗口串行，避免互相抢焦点）；标题会按各平台字数上限自动截断。
        </p>
        <label>标题<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="可留空；抖音 30 字内，小红书 20 字内" /></label>
        <label>正文<textarea rows={6} value={content} onChange={(e) => setContent(e.target.value)} placeholder="想发的内容。可以让员工先写好文案，再贴到这里。" /></label>
        <label>话题标签<input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="逗号分隔，不用带 #，例如：职场,AI工具" /></label>
        <div className="platform-media">
          <button className="ghost" onClick={() => void pick()}>选择{type === 'video' ? '视频' : '图片（可多选）'}</button>
          <span className="muted small">{mediaPaths.length ? mediaPaths.map((p) => p.split(/[\\/]/).pop()).join('、') : '未选择素材'}</span>
        </div>
        <button className="primary" disabled={busy === 'publish'} onClick={() => void publish()}>
          {busy === 'publish' ? '发布中，请勿关闭客户端…' + progress : targets.length > 1 ? '一键分发到 ' + targets.length + ' 个平台' : '开始发布'}
        </button>
      </section>

      {multiResults.length > 1 && (
        <section className="card">
          <h3>分发结果 · {multiResults.filter((r) => r.ok).length}/{multiResults.length} 个平台成功</h3>
          <table className="platform-result-table">
            <thead>
              <tr><th>平台</th><th>结果</th><th>说明</th></tr>
            </thead>
            <tbody>
              {multiResults.map((r) => (
                <tr key={r.platform}>
                  <td>{nameOf(r.platform)}</td>
                  <td className={r.ok ? 'ok-text' : 'error'}>{r.ok ? '✓ 已发布' : '✗ 失败'}</td>
                  <td>
                    {r.message}
                    {r.url && <><br /><a href={r.url} target="_blank" rel="noreferrer">{r.url}</a></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">失败平台的过程截图在「平台日志」目录，可在设置里打开；也可以单独再发一次。</p>
        </section>
      )}

      {result && (
        <section className="card">
          <h3>发布结果 · {PLATFORMS.find((p) => p.id === result.platform)?.name || result.platform}</h3>
          <p className={result.ok ? 'ok-text' : 'error'}>{result.message}</p>
          {result.url && <p className="muted small">作品链接：<a href={result.url} target="_blank" rel="noreferrer">{result.url}</a></p>}
          <ol className="platform-steps">
            {result.steps?.map((s, i) => (
              <li key={i} className={s.ok ? '' : 'fail'}>
                <span>{s.step}</span>
                <span>{s.ok ? '✓' : '✗'}{s.detail ? ' ' + s.detail : ''}</span>
              </li>
            ))}
          </ol>
          {!!result.screenshots?.length && (
            <p className="hint">过程截图：{result.screenshots.join('　')}</p>
          )}
        </section>
      )}
    </div>
  )
}
