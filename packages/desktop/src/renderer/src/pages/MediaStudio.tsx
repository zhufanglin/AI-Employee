import { useCallback, useEffect, useState } from 'react'

const fcm = (window as any).fcm

const STATUS_LABEL: Record<string, string> = {
  polling: '克隆中',
  cloning_audio: '克隆音频中',
  composing: '合成中',
  completed: '已完成',
  failed: '失败',
  pending: '排队中'
}

function elapsed(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const min = Math.floor(ms / 60000)
  if (min < 1) return '不到 1 分钟'
  if (min < 60) return min + ' 分钟'
  return Math.floor(min / 60) + ' 小时 ' + (min % 60) + ' 分'
}

const TYPE_LABEL: Record<string, string> = {
  lipsync: '数字人对口型',
  realman_mix: '真人口播混剪',
  mixcut: '智能混剪',
  news: '新闻混剪'
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

async function uploadPick(file: File, fallbackMime: string) {
  const base64 = await fileToBase64(file)
  const res = await fcm.media.upload({ fileName: file.name, mime: file.type || fallbackMime, base64 })
  return String(res?.fileName || res?.url || '')
}

function errText(e: any) {
  return String(e?.message || e || '操作失败')
}

export default function MediaStudio({ mode }: { mode: 'digital' | 'voice' }) {
  const [tasks, setTasks] = useState<any[]>([])
  const [clones, setClones] = useState<any[]>([])
  const [audios, setAudios] = useState<any[]>([])
  const [imageValue, setImageValue] = useState('')
  const [audioValue, setAudioValue] = useState('')
  const [seconds, setSeconds] = useState('5')
  const [resolution, setResolution] = useState('720')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const reload = useCallback(async () => {
    try {
      if (mode === 'digital') setTasks((await fcm.media.compose.list('?limit=50')) || [])
      else {
        setClones((await fcm.media.clone.list()) || [])
        setAudios((await fcm.media.audio.list()) || [])
      }
    } catch (e) {
      setError(errText(e))
    }
  }, [mode])

  useEffect(() => { reload() }, [reload])
  useEffect(() => {
    const timer = setInterval(reload, 8000)
    return () => clearInterval(timer)
  }, [reload])

  const pickImage = async (file?: File | null) => {
    if (!file) return
    setBusy('上传人像素材...'); setError(''); setNotice('')
    try {
      setImageValue(await uploadPick(file, 'image/png'))
      setNotice('人像素材已上传')
    } catch (e) { setError(errText(e)) } finally { setBusy('') }
  }

  const pickAudio = async (file?: File | null) => {
    if (!file) return
    setBusy('上传音频...'); setError(''); setNotice('')
    try {
      const value = await uploadPick(file, 'audio/wav')
      setAudioValue(value)
      await fcm.media.audio.upload({ audioUrl: value }).catch(() => null)
      setNotice('音频已上传')
      if (mode === 'voice') await reload()
    } catch (e) { setError(errText(e)) } finally { setBusy('') }
  }

  const submitCompose = async () => {
    if (!imageValue || !audioValue) { setError('请先上传人像图片和音频'); return }
    setBusy('提交合成任务...'); setError(''); setNotice('')
    try {
      const task = await fcm.media.compose.create({
        composeType: 'lipsync',
        videoUrl: imageValue,
        sourceAudioUrl: audioValue,
        seconds: Number(seconds) || undefined,
        resolution: Number(resolution) || undefined
      })
      setNotice('合成视频请求已提交，正在克隆音频...')
      setTasks((prev) => [task, ...prev])
    } catch (e) { setError(errText(e)) } finally { setBusy('') }
  }

  const submitClone = async () => {
    if (!audioValue) { setError('请先上传音频样本（建议 10 秒以上）'); return }
    setBusy('提交克隆任务...'); setError(''); setNotice('')
    try {
      const row = await fcm.media.clone.create({ type: 'voice', sourceUrl: audioValue })
      setNotice('音色克隆任务已提交')
      setClones((prev) => [row, ...prev])
    } catch (e) { setError(errText(e)) } finally { setBusy('') }
  }

  const transfer = async (id: string) => {
    setBusy('转存到对象存储...'); setError(''); setNotice('')
    try {
      const row = await fcm.media.compose.transfer(id)
      setNotice('已转存：' + (row?.resultUrl || ''))
      await reload()
    } catch (e) { setError(errText(e)) } finally { setBusy('') }
  }

  const removeTask = async (id: string) => {
    try { await fcm.media.compose.remove(id); await reload() } catch (e) { setError(errText(e)) }
  }

  const removeClone = async (id: string) => {
    try { await fcm.media.clone.remove(id); await reload() } catch (e) { setError(errText(e)) }
  }

  const removeAudio = async (id: string) => {
    try { await fcm.media.audio.remove(id); await reload() } catch (e) { setError(errText(e)) }
  }

  return (
    <div className="page">
      <header className="page-head">
        <h2>{mode === 'digital' ? '数字人' : '音色克隆'}</h2>
        <p>{mode === 'digital'
          ? '上传人像图片与口播音频，服务端调用对口型模型生成视频，按输入秒数扣积分'
          : '上传 10 秒以上音频样本建立克隆音色，按次扣积分'}</p>
      </header>

      {error && <div className="notice err">{error}</div>}
      {notice && <div className="notice ok">{notice}</div>}
      {busy && <div className="notice muted">{busy}</div>}

      {mode === 'digital' ? (
        <section className="page-card">
          <h3>制作口播数字人视频</h3>
          <label className="field">
            <span>人像图片</span>
            <input type="file" accept="image/*" onChange={(e) => pickImage(e.target.files?.[0])} />
          </label>
          <label className="field">
            <span>口播音频</span>
            <input type="file" accept="audio/*" onChange={(e) => pickAudio(e.target.files?.[0])} />
          </label>
          <label className="field"><span>时长（秒）</span><input value={seconds} onChange={(e) => setSeconds(e.target.value)} /></label>
          <label className="field"><span>分辨率</span>
            <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
              <option value="720">720p</option>
              <option value="1080">1080p</option>
              <option value="1280">1280p</option>
            </select>
          </label>
          <div className="row">
            <button className="primary" disabled={!!busy} onClick={submitCompose}>提交合成</button>
            <button className="ghost" onClick={reload}>刷新状态</button>
          </div>
          {imageValue && <div className="muted small">人像：{imageValue}</div>}
          {audioValue && <div className="muted small">音频：{audioValue}</div>}
        </section>
      ) : (
        <section className="page-card">
          <h3>创建克隆音色</h3>
          <label className="field">
            <span>音频样本</span>
            <input type="file" accept="audio/*" onChange={(e) => pickAudio(e.target.files?.[0])} />
          </label>
          <div className="row">
            <button className="primary" disabled onClick={submitClone}>提交克隆</button>
            <button className="ghost" onClick={reload}>刷新状态</button>
          </div>
          <p className="muted small">音色合成暂未开放：上游不返回可核对的音频时长，为避免多扣积分，体验版先关闭提交。需要开通请联系管理员。</p>
          {audioValue && <div className="muted small">样本：{audioValue}</div>}
        </section>
      )}

      {mode === 'digital' ? (
        <>
          <h3 className="sub">我的数字人视频</h3>
          <table className="table">
            <thead><tr><th>时间</th><th>类型</th><th>状态</th><th>时长</th><th>结果</th><th>操作</th></tr></thead>
            <tbody>
              {tasks.length === 0 && <tr><td colSpan={6} className="muted">暂无任务</td></tr>}
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td>{new Date(t.createdAt).toLocaleString()}</td>
                  <td>{TYPE_LABEL[t.composeType] || t.composeType}</td>
                  <td>{STATUS_LABEL[t.status] || t.status}{['cloning_audio','composing','pending','polling'].includes(t.status) && t.createdAt ? <span className="muted small">（已等待 {elapsed(t.createdAt)}）</span> : null}</td>
                  <td>{t.musetalkTaskId || t.smartClipTaskId || '-'}</td>
                  <td>{t.resultUrl ? <a href={t.resultUrl} target="_blank" rel="noreferrer">查看成片</a> : '-'}</td>
                  <td>
                    {t.status === 'completed' && <button className="ghost small" onClick={() => transfer(t.id)}>转存</button>}
                    <button className="ghost small" onClick={() => removeTask(t.id)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <>
          <h3 className="sub">克隆记录</h3>
          <table className="table">
            <thead><tr><th>时间</th><th>类型</th><th>状态</th><th>结果</th><th>操作</th></tr></thead>
            <tbody>
              {clones.length === 0 && <tr><td colSpan={5} className="muted">暂无克隆记录</td></tr>}
              {clones.map((c) => (
                <tr key={c.id}>
                  <td>{new Date(c.createdAt).toLocaleString()}</td>
                  <td>{c.type}</td>
                  <td>{STATUS_LABEL[c.status] || c.status}</td>
                  <td>{c.resultUrl ? <a href={c.resultUrl} target="_blank" rel="noreferrer">试听</a> : '-'}</td>
                  <td><button className="ghost small" onClick={() => removeClone(c.id)}>删除</button></td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 className="sub">音频素材</h3>
          <table className="table">
            <thead><tr><th>时间</th><th>地址</th><th>操作</th></tr></thead>
            <tbody>
              {audios.length === 0 && <tr><td colSpan={3} className="muted">暂无音频素材</td></tr>}
              {audios.map((a) => (
                <tr key={a.id}>
                  <td>{new Date(a.createdAt).toLocaleString()}</td>
                  <td className="muted small">{a.audioUrl}</td>
                  <td><button className="ghost small" onClick={() => removeAudio(a.id)}>删除</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
