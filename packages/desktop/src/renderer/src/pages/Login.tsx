import { useState } from 'react'

export default function Login({ config, onLogin }: { config: any; onLogin: (u: any) => void }) {
  const [mode, setMode] = useState<'sms' | 'password'>('sms')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [devCode, setDevCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function sendCode() {
    setError(''); setBusy(true)
    try {
      const r = await window.fcm.auth.smsSend(phone)
      if (r.devCode) { setDevCode(r.devCode); setCode(r.devCode) }
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(''); setBusy(true)
    try {
      const r = mode === 'sms'
        ? await window.fcm.auth.smsLogin({ phone, code })
        : await window.fcm.auth.passwordLogin({ username, password })
      onLogin(r.user)
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand">
          <div className="logo">元</div>
          <div>
            <h1>{config?.siteName || '中科元晟 AI 员工'}</h1>
            <p>{config?.defaultModelDisplayName || 'AI 员工工作台'}</p>
          </div>
        </div>

        <div className="tabs">
          <button className={mode === 'sms' ? 'on' : ''} onClick={() => setMode('sms')}>手机号登录</button>
          <button className={mode === 'password' ? 'on' : ''} onClick={() => setMode('password')}>账号密码</button>
        </div>

        <form onSubmit={submit}>
          {mode === 'sms' ? (
            <>
              <label>手机号</label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="请输入手机号" autoFocus />
              <label>验证码</label>
              <div className="row">
                <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6 位验证码" />
                <button type="button" className="ghost" disabled={busy || phone.length < 11} onClick={sendCode}>获取验证码</button>
              </div>
              {devCode && <div className="hint">开发模式验证码：<b>{devCode}</b></div>}
            </>
          ) : (
            <>
              <label>账号</label>
              <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="手机号或邮箱" autoFocus />
              <label>密码</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="密码" />
            </>
          )}

          {error && <div className="error">{error}</div>}
          <button className="primary" disabled={busy} type="submit">{busy ? '登录中…' : '登录'}</button>
        </form>

        <p className="foot">首次使用将自动创建账号 · 每月赠送 {config?.freeMonthlyQuota ?? 10} 次免费额度</p>
      </div>
    </div>
  )
}
