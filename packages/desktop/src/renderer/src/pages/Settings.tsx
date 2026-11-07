import { useEffect, useState } from 'react'

export default function Settings({ config }: { config: any }) {
  const [info, setInfo] = useState<any>(null)
  const [apiBase, setApiBase] = useState('')
  const [upd, setUpd] = useState<any>(null)

  useEffect(() => {
    window.fcm.info().then((i) => { setInfo(i); setApiBase(i.apiBase) })
    window.fcm.update.status().then(setUpd)
    const off = window.fcm.update.onStatus(setUpd)
    return off
  }, [])

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
    </div>
  )
}
