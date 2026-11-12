import { useEffect, useState } from 'react'
import type { LegalDocMeta, LegalDocKey } from '../types'

type Props = { version: string; docs: LegalDocMeta[]; onAccepted: () => void }

const FALLBACK: LegalDocMeta[] = [
  { key: 'terms', title: '用户协议', updatedAt: '' },
  { key: 'privacy', title: '隐私政策', updatedAt: '' },
  { key: 'aigc', title: 'AI 生成内容标识说明', updatedAt: '' }
]

/**
 * P45 合规基线：首次启动 / 条款版本更新后的同意闸门。
 *
 * 原版客户端没有任何协议入口，这在合规上是硬伤（应用市场与支付审核都会查）：
 * - 三条对外文本由服务端渲染（/api/legal/{terms,privacy,aigc}），这里只做入口与同意记录；
 * - 同意的版本号写进本机 settings.json（legalAcceptedVersion），条款正文改版后服务端版本号变，会再弹一次；
 * - 不同意就退出：不做「静默同意」。
 */
export default function LegalGate({ version, docs, onAccepted }: Props) {
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const list = docs && docs.length > 0 ? docs : FALLBACK
  const [opened, setOpened] = useState<Record<string, boolean>>({})

  async function open(key: string) {
    try {
      await window.fcm.legal.open(key as LegalDocKey)
      setOpened((s) => ({ ...s, [key]: true }))
    } catch {
      /* 打不开浏览器时不影响同意流程：文本入口在「设置」里还有一份 */
    }
  }

  async function accept() {
    setBusy(true)
    try {
      await window.fcm.legal.accept(version)
      onAccepted()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="onboard">
      <div className="onboard-card">
        <h1>使用前请阅读并同意</h1>
        <p className="muted">
          中科元晟 AI 员工由中科元晟智科人工智能科技有限公司提供。为了让你清楚知道我们会处理哪些信息、
          生成内容如何标识，请先阅读以下三份文本。
        </p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, margin: '18px 0 6px' }}>
          {list.map((d) => (
            <button key={d.key} className="ghost" onClick={() => open(d.key)}>
              {d.title}
              {opened[d.key] ? ' ✓' : ' ↗'}
            </button>
          ))}
        </div>
        <p className="muted small">
          将在系统浏览器中打开（也可在「设置 → 关于与合规」里随时查看）。当前条款版本：{version}
        </p>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, margin: '20px 0 0', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            style={{ width: 'auto', marginTop: 3 }}
          />
          <span className="muted">
            我已阅读并同意《用户协议》《隐私政策》《AI 生成内容标识说明》；我知道 AI 生成内容需要按法规标识，
            且我对自己发布的内容负责。
          </span>
        </label>

        <div className="onboard-actions">
          <button className="ghost" onClick={() => window.fcm.window.close()}>退出</button>
          <button disabled={!checked || busy} onClick={accept}>
            {busy ? '保存中…' : '同意并继续'}
          </button>
        </div>
      </div>
    </div>
  )
}
