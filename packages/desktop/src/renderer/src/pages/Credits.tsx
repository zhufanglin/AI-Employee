import { useEffect, useState } from 'react'
import type { PackageMine } from '../types'

/** 套餐档位的中文名兜底：服务端没带 preset 时不至于显示英文 id */
const PACKAGE_NAMES: Record<string, string> = {
  traffic: '流量操盘版',
  'private-domain': '私域运营版',
  flagship: '旗舰版'
}
const packageName = (id?: string, preset?: { name?: string } | null) =>
  (preset && preset.name) || (id ? PACKAGE_NAMES[id] || id : '-')

export default function Credits() {
  const [balance, setBalance] = useState<any>(null)
  const [records, setRecords] = useState<any[]>([])
  const [mine, setMine] = useState<PackageMine | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const reload = () => {
    window.fcm.credits.balance().then(setBalance).catch(() => {})
    window.fcm.credits.usageRecords('?limit=20').then((r) => setRecords(r.items || [])).catch(() => {})
    window.fcm.packages
      .mine()
      .then((r) => { if (r && r.ok) setMine(r.data || null) })
      .catch(() => {})
  }

  useEffect(reload, [])

  const redeem = async () => {
    const value = code.trim()
    if (!value) {
      setMsg({ kind: 'err', text: '请输入兑换码' })
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      const r = await window.fcm.packages.redeem(value)
      if (r && r.ok) {
        const name = packageName(r.data?.packageId, r.data?.preset)
        const days = r.data?.validDays ? ' ' + r.data.validDays + ' 天' : ''
        setMsg({ kind: 'ok', text: '兑换成功：已开通' + name + days + '，现在就可以使用对应员工了' })
        setCode('')
        reload()
      } else {
        setMsg({ kind: 'err', text: (r && r.error) || '兑换失败，请稍后重试' })
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: String((e && e.message) || e) })
    } finally {
      setBusy(false)
    }
  }

  const active = (mine && mine.active) || []
  const presets = (mine && mine.presets) || []

  return (
    <div className="page">
      <header className="page-head"><h2>积分与用量</h2><p>免费额度优先，用尽后按模型定价扣积分</p></header>
      <div className="cards">
        <div className="card"><span>当前积分</span><b>{balance?.balance ?? '-'}</b></div>
        <div className="card"><span>累计消费</span><b>{balance?.totalConsumed ?? '-'}</b></div>
        <div className="card"><span>累计充值</span><b>{balance?.totalRecharged ?? '-'}</b></div>
      </div>

      {/* 兑换码（P43）：原版客户端有兑换码激活入口，我们此前只在服务端留了接口 */}
      <h3 className="sub">兑换码激活</h3>
      <div className="card" style={{ maxWidth: 520 }}>
        <p className="muted" style={{ marginTop: 0 }}>把运营发给你的兑换码粘贴进来，激活后对应套餐的员工即可使用。</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void redeem() }}
            placeholder="输入兑换码"
            style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #374151', background: '#111827', color: '#e5e7eb' }}
          />
          <button className="btn" disabled={busy} onClick={() => void redeem()}>{busy ? '激活中…' : '激活'}</button>
        </div>
        {msg && <p style={{ marginBottom: 0, color: msg.kind === 'ok' ? '#34d399' : '#f87171' }}>{msg.text}</p>}
      </div>

      <h3 className="sub">我的套餐</h3>
      <table className="table">
        <thead><tr><th>套餐</th><th>来源</th><th>有效期至</th></tr></thead>
        <tbody>
          {active.length === 0 && <tr><td colSpan={3} className="muted">还没有有效套餐，激活兑换码后显示在这里</td></tr>}
          {active.map((g) => (
            <tr key={g.id}>
              <td>{packageName(g.packageId, g.preset)}</td>
              <td>{g.source === 'redemption' ? '兑换码' : g.source === 'admin' ? '后台开通' : g.source || '-'}</td>
              <td>{g.expiresAt ? new Date(g.expiresAt).toLocaleString() : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {presets.length > 0 && (
        <p className="muted">当前可用的套餐档位：{presets.map((p) => packageName(p.id, p)).join('、')}</p>
      )}

      <h3 className="sub">最近用量</h3>
      <table className="table">
        <thead><tr><th>时间</th><th>模型</th><th>输入</th><th>输出</th><th>积分</th></tr></thead>
        <tbody>
          {records.length === 0 && <tr><td colSpan={5} className="muted">暂无记录</td></tr>}
          {records.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.createdAt).toLocaleString()}</td>
              <td>{r.modelName || r.modelId}</td>
              <td>{r.inputTokens}</td>
              <td>{r.outputTokens}</td>
              <td>{r.creditsCharged}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
