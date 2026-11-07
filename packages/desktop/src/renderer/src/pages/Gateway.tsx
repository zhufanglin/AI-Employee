import { useEffect, useState } from 'react'

export default function Gateway() {
  const [st, setSt] = useState<any>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [showToken, setShowToken] = useState(false)

  async function refresh() {
    try {
      setSt(await window.fcm.gateway.status())
      setLogs(await window.fcm.gateway.logs())
    } catch (e) { console.error(e) }
  }

  useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t) }, [])

  async function act(fn: () => Promise<any>) {
    setBusy(true)
    try { await fn(); await refresh() } catch (e: any) { alert(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="page">
      <header className="page-head">
        <h2>渠道网关</h2>
        <p>openclaw 本地网关：为 Telegram / 飞书 / 企业微信等渠道提供统一入口，模型请求走本应用的服务端代理</p>
      </header>

      <div className="cards">
        <div className="card">
          <span>运行状态</span>
          <b className={st?.running ? 'ok' : 'off'}>{st?.running ? (st.healthy ? '运行中' : '启动中…') : '已停止'}</b>
          {st?.pid && <i>PID {st.pid}</i>}
        </div>
        <div className="card"><span>监听端口</span><b>{st?.port ?? '-'}</b><i>127.0.0.1</i></div>
        <div className="card">
          <span>访问令牌</span>
          <b className="mono">{showToken ? st?.token : '••••••••••'}</b>
          <button className="link" onClick={() => setShowToken((v) => !v)}>{showToken ? '隐藏' : '显示'}</button>
        </div>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        {!st?.running && <button className="primary" style={{ width: 'auto' }} disabled={busy} onClick={() => act(() => window.fcm.gateway.start())}>启动网关</button>}
        {st?.running && <button className="ghost" disabled={busy} onClick={() => act(() => window.fcm.gateway.stop())}>停止</button>}
        {st?.running && <button className="ghost" disabled={busy} onClick={() => act(() => window.fcm.gateway.restart())}>重启</button>}
        <button className="ghost" onClick={async () => { const u = await window.fcm.gateway.controlUrl(); window.open(u) }}>打开控制台</button>
      </div>

      {st?.lastError && <div className="error">{st.lastError}</div>}

      <h3 className="sub">运行日志</h3>
      <pre className="logs">{(logs.slice(-80).join('\n')) || '暂无日志'}</pre>
      <p className="muted mono">数据目录：{st?.home}</p>
    </div>
  )
}
