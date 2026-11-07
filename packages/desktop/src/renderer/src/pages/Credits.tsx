import { useEffect, useState } from 'react'

export default function Credits() {
  const [balance, setBalance] = useState<any>(null)
  const [records, setRecords] = useState<any[]>([])
  const [stats, setStats] = useState<any>(null)

  useEffect(() => {
    window.fcm.credits.balance().then(setBalance).catch(() => {})
    window.fcm.credits.usageRecords('?limit=20').then((r) => setRecords(r.items || [])).catch(() => {})
  }, [])

  return (
    <div className="page">
      <header className="page-head"><h2>积分与用量</h2><p>免费额度优先，用尽后按模型定价扣积分</p></header>
      <div className="cards">
        <div className="card"><span>当前积分</span><b>{balance?.balance ?? '-'}</b></div>
        <div className="card"><span>累计消费</span><b>{balance?.totalConsumed ?? '-'}</b></div>
        <div className="card"><span>累计充值</span><b>{balance?.totalRecharged ?? '-'}</b></div>
      </div>
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
