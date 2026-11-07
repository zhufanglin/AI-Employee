import { useEffect, useRef, useState } from 'react'

const fcm = (window as any).fcm
type Task = { taskId: string; status: string; createdAt?: string; resultUrl?: string | null; estimatedAmount?: number; settledAmount?: number | null; resultMeta?: any }

export default function MediaCreation({ mode, onBalance }: { mode: 'image' | 'video'; onBalance: (balance: number) => void }) {
  const [prompt, setPrompt] = useState(mode === 'video' ? 'Time-lapse photography' : '')
  const [size, setSize] = useState(7)
  const [seconds, setSeconds] = useState(5)
  const [ratio, setRatio] = useState('9:16')
  const [image, setImage] = useState('')
  const [task, setTask] = useState<Task | null>(null)
  const [started, setStarted] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [apiOrigin, setApiOrigin] = useState('')
  const active = useRef(true)

  useEffect(() => { active.current = true; fcm.settings.get().then((s: any) => { if (active.current) setApiOrigin(new URL(s.apiBase).origin) }).catch(() => {}); return () => { active.current = false } }, [])
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    if (!task?.taskId || !['QUEUED', 'RUNNING'].includes(task.status.toUpperCase())) return
    let cancelled = false
    const refresh = async () => {
      try {
        const result = await fcm.media.task(task.taskId)
        if (cancelled) return
        setTask((previous) => previous?.taskId === task.taskId ? { ...previous, ...result } : previous)
        if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(String(result.status).toUpperCase())) fcm.credits.balance().then((b: any) => onBalance(b.balance)).catch(() => {})
      } catch (e: any) { if (!cancelled) setError('状态查询失败：' + String(e?.message || e)) }
    }
    const timer = setInterval(refresh, 8000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [task?.taskId, task?.status, onBalance])

  const upload = async (file?: File) => {
    if (!file) return
    if (!file.type.startsWith('image/')) { setError('请选择图片文件'); return }
    if (file.size > 60 * 1024 * 1024) { setError('图片不能超过 60 MB'); return }
    setBusy(true); setError(''); setImage('')
    try {
      const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      const result = await fcm.media.upload({ fileName: file.name, mime: file.type, base64: btoa(binary) })
      if (!result?.fileName) throw new Error('上传未返回文件名')
      if (active.current) setImage(result.fileName)
    } catch (e: any) { if (active.current) setError(String(e?.message || e)) } finally { if (active.current) setBusy(false) }
  }
  const submit = async () => {
    if (mode === 'image' && !prompt.trim()) { setError('请输入提示词'); return }
    if (mode === 'video' && !image) { setError('请先上传首帧图片'); return }
    if (mode === 'video' && (!Number.isFinite(seconds) || seconds <= 0)) { setError('请输入有效的视频时长'); return }
    setBusy(true); setError(''); setTask(null)
    try {
      const result = mode === 'image' ? await fcm.media.image({ prompt: prompt.trim(), size }) : await fcm.media.video({ image, prompt: prompt.trim(), seconds, aspectRatio: ratio })
      if (!result?.taskId) throw new Error('提交未返回任务编号，请先核对任务记录再重试')
      if (active.current) { setStarted(Date.now()); setTask(result) }
      fcm.credits.balance().then((b: any) => onBalance(b.balance)).catch(() => {})
    } catch (e: any) { if (active.current) setError(String(e?.message || e)) } finally { if (active.current) setBusy(false) }
  }
  const cancel = async () => {
    if (!task?.taskId) return
    setBusy(true); setError('')
    try {
      const result = await fcm.media.cancel(task.taskId)
      if (active.current) setTask((previous) => previous?.taskId === task.taskId ? { ...previous, ...result, status: String(result?.status || 'CANCELLED').toUpperCase() } : previous)
      fcm.credits.balance().then((b: any) => onBalance(b.balance)).catch(() => {})
    } catch (e: any) { if (active.current) setError('取消失败：' + String(e?.message || e)) } finally { if (active.current) setBusy(false) }
  }
  const status = task?.status?.toUpperCase()
  let resultUrl = ''
  try {
    if (task?.resultUrl && (apiOrigin || /^https?:\/\//i.test(task.resultUrl))) {
      const url = new URL(task.resultUrl, apiOrigin || undefined)
      if (url.protocol === 'https:' || url.protocol === 'http:') resultUrl = url.href
    }
  } catch { /* Keep invalid or incomplete result links out of the view. */ }
  const failure = task?.resultMeta?.errorMessage || task?.resultMeta?.failedReason?.message || '生成失败，请查看任务详情或联系客服'
  return <div className="page"><header className="page-head"><h2>{mode === 'image' ? '文生图' : '图生视频'}</h2><p>通常需要约 3–4 分钟，任务提交后可在此查看进度。</p></header>
    {error && <div className="notice err" role="alert">{error}</div>}
    <section className="page-card">
      {mode === 'video' && <label className="field"><span>首帧图片</span><input type="file" accept="image/*" disabled={busy} onChange={e => void upload(e.target.files?.[0])} />{image && <span>图片已上传</span>}</label>}
      <label className="field"><span>提示词</span><textarea value={prompt} onChange={e => setPrompt(e.target.value)} /></label>
      {mode === 'image' ? <label className="field"><span>尺寸档位</span><select value={size} onChange={e => setSize(Number(e.target.value))}>{Array.from({ length: 8 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select></label> : <><label className="field"><span>时长（秒）</span><input type="number" min="1" value={seconds} onChange={e => setSeconds(Number(e.target.value))} /></label><label className="field"><span>画面比例</span><select value={ratio} onChange={e => setRatio(e.target.value)}>{['9:16', '16:9', '1:1', '4:3', '3:4'].map(v => <option key={v}>{v}</option>)}</select></label></>}
      <p className="muted">提交时预扣积分，实际以任务结算为准。</p><button className="primary" disabled={busy || status === 'QUEUED' || status === 'RUNNING'} onClick={() => void submit()}>{busy ? '处理中…' : '开始生成'}</button>
    </section>
    {task && <section className="page-card" aria-live="polite"><h3>生成任务</h3><p>{status === 'QUEUED' ? '排队中' : status === 'RUNNING' ? '生成中' : status === 'SUCCESS' ? '已完成' : status === 'FAILED' ? '生成失败' : status === 'CANCELLED' ? '已取消（积分已退回）' : task.status}{['QUEUED', 'RUNNING'].includes(status || '') && `（已等待 ${Math.floor((now - started) / 60000)} 分钟）`}</p><p className="muted">任务编号：{task.taskId} · {task.settledAmount != null ? `结算 ${task.settledAmount}` : `预扣 ${task.estimatedAmount ?? '—'}`} 积分</p>
      {status === 'FAILED' && <p className="err">{String(failure)}。退款状态请查看积分流水。</p>}
      {['QUEUED', 'RUNNING'].includes(status || '') && <div className="row"><button className="ghost" disabled={busy} onClick={() => void cancel()}>{busy ? '处理中…' : '取消任务（全额退回积分）'}</button></div>}
      {['FAILED', 'CANCELLED', 'SUCCESS'].includes(status || '') && <div className="row"><button className="ghost" disabled={busy} onClick={() => void submit()}>{busy ? '处理中…' : '按当前参数重新生成'}</button></div>}
      {status === 'SUCCESS' && resultUrl && <>{mode === 'image' ? <img src={resultUrl} alt="生成结果" style={{ maxWidth: '100%', maxHeight: 520 }} /> : <video controls src={resultUrl} style={{ maxWidth: '100%', maxHeight: 520 }} />}<div className="row"><a href={resultUrl} download target="_blank" rel="noreferrer">下载 / 打开结果</a><button className="ghost" onClick={() => navigator.clipboard.writeText(resultUrl).catch(() => setError('复制失败，请手动复制链接'))}>复制链接</button></div></>}
    </section>}
  </div>
}