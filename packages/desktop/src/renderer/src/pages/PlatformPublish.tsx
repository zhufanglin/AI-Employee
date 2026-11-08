import { useEffect, useState } from 'react'
import type { PlatformPublishResult, PlatformStatus } from '../types'

const PLATFORMS: { id: string; name: string; tip: string; types: string }[] = [
  { id: 'douyin', name: '抖音', tip: '创作者中心 · 视频 / 图文', types: '视频、图文' },
  { id: 'xiaohongshu', name: '小红书', tip: '创作服务平台 · 视频 / 图文笔记', types: '视频、图文' },
  { id: 'shipinhao', name: '视频号', tip: '视频号助手 · 视频 / 图文', types: '视频、图文' }
]

export default function PlatformPublish() {
  const [statuses, setStatuses] = useState<PlatformStatus[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<PlatformPublishResult | null>(null)

  const [platform, setPlatform] = useState('douyin')
  const [type, setType] = useState<'video' | 'image'>('video')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState('')
  const [mediaPaths, setMediaPaths] = useState<string[]>([])

  async function refresh() {
    setLoading(true)
    setError('')
    try {
      const items = await window.fcm.platform.status({})
      setStatuses(items || [])
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])

  const statusOf = (id: string) => statuses.find((s) => s.platform === id)

  async function login(id: string) {
    setBusy('login:' + id)
    setError('')
    try {
      const st = await window.fcm.platform.login({ platform: id })
      setStatuses((prev) => {
        const next = prev.filter((s) => s.platform !== st.platform)
        next.push(st)
        return next
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
      await refresh()
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

  async function publish() {
    if (!content.trim()) { setError('正文不能为空'); return }
    if (!mediaPaths.length) { setError('请先选择素材文件'); return }
    setBusy('publish')
    setError('')
    setResult(null)
    try {
      const r = await window.fcm.platform.publish({
        platform,
        type,
        title: title.trim(),
        content: content.trim(),
        tags: tags.split(/[,，\s]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean),
        mediaPaths
      })
      setResult(r)
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy('')
    }
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
        <button className="ghost" onClick={() => void refresh()} disabled={loading}>{loading ? '检查中…' : '刷新登录状态'}</button>
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
              <div className="platform-card-actions">
                <button className="ghost" disabled={busy === 'login:' + p.id} onClick={() => void login(p.id)}>
                  {busy === 'login:' + p.id ? '请在弹窗中扫码…' : '扫码登录'}
                </button>
                <button className="ghost" disabled={busy === 'debug:' + p.id} onClick={() => void openDebug(p.id)}>打开后台</button>
                <button className="ghost" disabled={!st?.loggedIn || busy === 'logout:' + p.id} onClick={() => void logout(p.id)}>退出</button>
              </div>
            </div>
          )
        })}
      </div>

      <section className="card platform-form">
        <h3>新建发布</h3>
        <div className="platform-form-row">
          <label>平台
            <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              {PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.name}（{p.types}）</option>)}
            </select>
          </label>
          <label>类型
            <select value={type} onChange={(e) => setType(e.target.value as 'video' | 'image')}>
              <option value="video">视频</option>
              <option value="image">图文</option>
            </select>
          </label>
        </div>
        <label>标题<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="可留空；抖音 30 字内，小红书 20 字内" /></label>
        <label>正文<textarea rows={6} value={content} onChange={(e) => setContent(e.target.value)} placeholder="想发的内容。可以让员工先写好文案，再贴到这里。" /></label>
        <label>话题标签<input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="逗号分隔，不用带 #，例如：职场,AI工具" /></label>
        <div className="platform-media">
          <button className="ghost" onClick={() => void pick()}>选择{type === 'video' ? '视频' : '图片（可多选）'}</button>
          <span className="muted small">{mediaPaths.length ? mediaPaths.map((p) => p.split(/[\\/]/).pop()).join('、') : '未选择素材'}</span>
        </div>
        <button className="primary" disabled={busy === 'publish'} onClick={() => void publish()}>{busy === 'publish' ? '发布中，请勿关闭客户端…' : '开始发布'}</button>
      </section>

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
