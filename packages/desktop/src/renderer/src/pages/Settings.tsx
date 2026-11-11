import { useEffect, useState } from 'react'
import type { AsarUpdateStatus, LogFileItem } from '../types'

function formatBytes(n: number | undefined): string {
  if (!n && n !== 0) return '—'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

function formatTime(value: string | number | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('zh-CN', { hour12: false })
}

type Notice = { kind: 'ok' | 'err' | 'muted'; text: string } | null

export default function Settings({ config }: { config: any }) {
  const [info, setInfo] = useState<any>(null)
  const [apiBase, setApiBase] = useState('')
  const [upd, setUpd] = useState<any>(null)

  // asar 热更新（P43 P1-6）
  const [asar, setAsar] = useState<AsarUpdateStatus | null>(null)
  const [asarBusy, setAsarBusy] = useState<'check' | 'download' | 'install' | null>(null)
  const [asarNotice, setAsarNotice] = useState<Notice>(null)

  // 客户端日志（P43 P1-7）
  const [logDir, setLogDir] = useState('')
  const [logFiles, setLogFiles] = useState<LogFileItem[]>([])
  const [logFile, setLogFile] = useState('main.log')
  const [logLines, setLogLines] = useState<string[]>([])
  const [logLoading, setLogLoading] = useState(false)
  const [logNotice, setLogNotice] = useState<Notice>(null)

  useEffect(() => {
    window.fcm.info().then((i) => { setInfo(i); setApiBase(i.apiBase) })
    window.fcm.update.status().then(setUpd)
    const off = window.fcm.update.onStatus(setUpd)
    return off
  }, [])

  const loadAsarStatus = async () => {
    const res = await window.fcm.asarUpdate.status()
    if (res.ok && res.data) setAsar(res.data)
    else if (!res.ok) setAsarNotice({ kind: 'err', text: res.error || '读取更新状态失败' })
    return res
  }

  const loadLogs = async (name?: string) => {
    setLogLoading(true)
    try {
      const dirRes = await window.fcm.logs.getDir()
      if (dirRes.ok && dirRes.data) setLogDir(dirRes.data.dir)

      const listRes = await window.fcm.logs.listFiles()
      if (listRes.ok && listRes.data) setLogFiles(listRes.data.items)
      else if (!listRes.ok) setLogNotice({ kind: 'err', text: listRes.error || '读取日志目录失败' })

      const target = name || logFile
      const recent = await window.fcm.logs.getRecent({ lines: 200, file: target })
      if (recent.ok && recent.data) {
        setLogFile(recent.data.file)
        setLogLines(recent.data.lines)
        setLogNotice(recent.data.lines.length ? null : { kind: 'muted', text: '日志文件还是空的，产生日志后刷新即可。' })
      } else if (!recent.ok) {
        setLogLines([])
        setLogNotice({ kind: 'err', text: recent.error || '读取日志失败' })
      }
    } finally {
      setLogLoading(false)
    }
  }

  useEffect(() => {
    void loadAsarStatus()
    void loadLogs()
    // 只在进入设置页时加载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onCheck = async () => {
    setAsarBusy('check')
    setAsarNotice(null)
    try {
      const res = await window.fcm.asarUpdate.check()
      if (res.ok && res.data) {
        setAsar(res.data)
        setAsarNotice({ kind: res.data.updateAvailable ? 'ok' : 'muted', text: res.data.message })
      } else {
        setAsarNotice({ kind: 'err', text: res.error || '检查更新失败' })
      }
    } finally {
      setAsarBusy(null)
    }
  }

  const onDownload = async () => {
    if (!asar?.pending) return
    setAsarBusy('download')
    setAsarNotice({ kind: 'muted', text: '正在下载，约 ' + formatBytes(asar.pending.size) + '，请勿关闭客户端…' })
    try {
      const res = await window.fcm.asarUpdate.download()
      if (res.ok && res.data) {
        setAsar(res.data)
        setAsarNotice({ kind: 'ok', text: res.data.message })
      } else {
        setAsarNotice({ kind: 'err', text: res.error || '下载更新失败' })
      }
    } finally {
      setAsarBusy(null)
    }
  }

  const onInstall = async () => {
    if (!asar?.pending) return
    const confirmed = window.confirm('安装 ' + asar.pending.version + ' 后客户端会自动重启，确定现在安装吗？')
    if (!confirmed) return
    setAsarBusy('install')
    setAsarNotice({ kind: 'muted', text: '正在安装并重启，请稍候…' })
    const res = await window.fcm.asarUpdate.install()
    if (!res.ok) {
      setAsarBusy(null)
      setAsarNotice({ kind: 'err', text: res.error || '安装更新失败' })
    }
    // 成功时进程会 app.relaunch() + app.exit(0)，这里不再更新状态
  }

  const pending = asar?.pending
  const canDownload = !!pending && !pending.downloaded && !pending.incompatible
  const canInstall = !!pending && pending.downloaded && !pending.incompatible

  return (
    <div className="page">
      <header className="page-head"><h2>设置</h2><p>客户端信息与服务端地址</p></header>
      <div className="field">
        <label>服务端地址</label>
        <div className="row">
          <input value={apiBase} onChange={(e) => setApiBase(e.target.value)} />
          <button className="ghost" onClick={async () => { await window.fcm.settings.setApiBase(apiBase); location.reload() }}>保存并重启</button>
        </div>
      </div>
      <div className="kv">
        <div><span>客户端版本</span><b>{info?.version}</b></div>
        <div><span>更新状态</span><b>{upd?.message || upd?.status || '—'}</b></div>
        <div><span>Electron</span><b>{info?.electron}</b></div>
        <div><span>平台</span><b>{info?.platform}</b></div>
        <div><span>站点名</span><b>{config?.siteName}</b></div>
      </div>
      <div className="row" style={{ marginTop: 18, gap: 10 }}>
        <button className="ghost" onClick={() => window.fcm.update.check().then(setUpd)}>检查更新</button>
        {upd?.status === 'available' && <button onClick={() => window.fcm.update.download().then(setUpd)}>下载新版本</button>}
        {upd?.status === 'downloaded' && <button onClick={() => window.fcm.update.install()}>重启并安装</button>}
        {upd?.status === 'downloading' && <span className="muted">{upd.percent}%</span>}
      </div>

      <section className="settings-card">
        <div className="settings-card-head">
          <h3>客户端更新（快速）</h3>
          <p>只替换程序资源，不用重新安装，通常几秒到几十秒完成。</p>
        </div>
        <div className="kv">
          <div><span>当前版本</span><b>{asar?.currentVersion || info?.version || '—'}</b></div>
          <div><span>上次检查</span><b>{formatTime(asar?.lastCheckAt)}</b></div>
          <div><span>可用新版本</span><b>{pending ? pending.version : '—'}</b></div>
          <div><span>更新包大小</span><b>{pending ? formatBytes(pending.size) : '—'}</b></div>
          {pending && <div><span>已下载</span><b>{pending.downloaded ? '是' : '否'}</b></div>}
        </div>
        {pending?.incompatible && (
          <div className="notice err">这个版本要求更高的客户端基线（{pending.minVersion}），请使用完整安装包升级。</div>
        )}
        {asarNotice && <div className={'notice ' + asarNotice.kind}>{asarNotice.text}</div>}
        <div className="row" style={{ marginTop: 12, gap: 10 }}>
          <button className="ghost" disabled={!!asarBusy} onClick={onCheck}>
            {asarBusy === 'check' ? '检查中…' : '检查更新'}
          </button>
          {canDownload && <button disabled={!!asarBusy} onClick={onDownload}>{asarBusy === 'download' ? '下载中…' : '下载更新'}</button>}
          {canInstall && <button className="primary" disabled={!!asarBusy} onClick={onInstall}>{asarBusy === 'install' ? '安装中…' : '立即安装（会重启客户端）'}</button>}
        </div>
      </section>

      <section className="settings-card">
        <div className="settings-card-head">
          <h3>客户端日志</h3>
          <p>遇到问题时可把最近日志发给技术支持。</p>
        </div>
        <div className="log-toolbar">
          <span className="mono muted" title={logDir}>{logDir || '日志目录加载中…'}</span>
          <div className="row" style={{ gap: 8 }}>
            <select value={logFile} onChange={(e) => { setLogFile(e.target.value); void loadLogs(e.target.value) }}>
              {logFiles.length === 0 && <option value="main.log">main.log</option>}
              {logFiles.map((f) => <option key={f.name} value={f.name}>{f.name}（{formatBytes(f.size)}）</option>)}
            </select>
            <button className="ghost" disabled={logLoading} onClick={() => void loadLogs()}>{logLoading ? '刷新中…' : '刷新'}</button>
          </div>
        </div>
        {logNotice && <div className={'notice ' + logNotice.kind}>{logNotice.text}</div>}
        <pre className="logs log-view">{logLines.length ? logLines.join('\n') : '暂无日志'}</pre>
      </section>
    </div>
  )
}
