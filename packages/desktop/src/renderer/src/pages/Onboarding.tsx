import { useState } from 'react'

type Props = { config: any; onDone: () => void }

const STEPS = ['欢迎', '服务端', '完成']

export default function Onboarding({ config, onDone }: Props) {
  const [step, setStep] = useState(0)
  const [apiBase, setApiBase] = useState((config?.apiBase as string) || 'https://ai.fcmediaagent.com/api')
  const [probe, setProbe] = useState<{ ok?: boolean; msg?: string }>({})
  const [busy, setBusy] = useState(false)

  async function finish() {
    setBusy(true)
    try {
      if (apiBase) await window.fcm.settings.setApiBase(apiBase)
      await window.fcm.settings.markOnboarded()
      onDone()
    } finally { setBusy(false) }
  }

  return (
    <div className="onboard">
      <div className="onboard-card">
        <div className="onboard-steps">
          {STEPS.map((s, i) => (
            <span key={s} className={i === step ? 'on' : i < step ? 'done' : ''}>{i + 1}. {s}</span>
          ))}
        </div>

        {step === 0 && (
          <div>
            <h1>中科元晟 AI 员工</h1>
            <p className="muted">一支随时在线的 AI 员工团队。装完即用，按需付费。</p>
            <ul className="onboard-list">
              <li>17 位 AI 员工，按业务选人，装完即用</li>
              <li>对话 / 定时任务 / 任务看板，产物可验收</li>
              <li>支持企业微信、公众号、个人微信等渠道接入</li>
              <li>按次或按积分计费，用量明细可查</li>
            </ul>
          </div>
        )}

        {step === 1 && (
          <div>
            <h2>连接服务端</h2>
            <p className="muted">默认已填好官方地址；自建部署时改成你自己的。</p>
            <input value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="https://api.example.com/api" />
            <div className="row" style={{ marginTop: 12 }}>
              <button className="ghost" onClick={async () => {
                setProbe({})
                try {
                  const c = await window.fcm.site.config()
                  setProbe({ ok: true, msg: '连接成功：' + (c?.siteName || '未知站点') })
                } catch (e: any) { setProbe({ ok: false, msg: '连接失败：' + (e?.message || e) }) }
              }}>测试连接</button>
              {probe.msg && <span className={probe.ok ? 'ok' : 'err'}>{probe.msg}</span>}
            </div>
            <p className="muted small">提示：地址需包含 /api 前缀，默认为 https://ai.fcmediaagent.com/api</p>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2>准备就绪</h2>
            <p className="muted">下一步用手机号登录，首次登录会自动创建账号并赠送本月免费额度。</p>
            <ul className="onboard-list">
              <li>服务端：{apiBase}</li>
              <li>随时可在「设置」里检查更新</li>
            </ul>
          </div>
        )}

        <div className="onboard-actions">
          <button className="ghost" disabled={step === 0 || busy} onClick={() => setStep(step - 1)}>上一步</button>
          {step < 2
            ? <button onClick={() => setStep(step + 1)}>下一步</button>
            : <button disabled={busy} onClick={finish}>开始使用</button>}
        </div>
      </div>
    </div>
  )
}
