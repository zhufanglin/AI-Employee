import { useEffect, useState } from 'react'
import Login from './pages/Login'
import Onboarding from './pages/Onboarding'
import Shell from './pages/Shell'
import LegalGate from './pages/LegalGate'
import type { LegalMetaResult } from './types'

export default function App() {
  const [booted, setBooted] = useState(false)
  const [user, setUser] = useState<any>(null)
  const [config, setConfig] = useState<any>(null)
  const [onboarded, setOnboarded] = useState(true)
  const [apiBase, setApiBase] = useState('')
  // P45 合规：legal === null 表示已同意（或本机记录与服务端版本一致）；否则是待同意闸门
  const [legal, setLegal] = useState<{ version: string; docs: any[] } | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const [s, c] = await Promise.all([window.fcm.settings.get(), window.fcm.site.config()])
        setConfig(c)
        setApiBase(s.apiBase)
        setOnboarded(!!s.onboarded || !!s.hasToken)
        if (s.hasToken) {
          try { setUser(await window.fcm.auth.me()) } catch { await window.fcm.auth.logout() }
        }
        // 合规闸门：服务端拿不到版本时用兜底版本，保证离线也能走完（文本入口仍指向线上）
        try {
          const meta: LegalMetaResult = await window.fcm.legal.meta()
          if (meta?.version && meta.version !== s.legalAcceptedVersion) {
            setLegal({ version: meta.version, docs: meta.docs || [] })
          }
        } catch {
          /* 拿不到也不阻塞启动：条款入口在设置页仍可用 */
        }
      } finally {
        setBooted(true)
      }
    })()
  }, [])

  if (!booted) return <div className="boot">启动中…</div>
  if (legal) return <LegalGate version={legal.version} docs={legal.docs as any} onAccepted={() => setLegal(null)} />
  if (!onboarded) return <Onboarding config={{ ...config, apiBase }} onDone={() => setOnboarded(true)} />
  if (!user) return <Login config={config} onLogin={(u) => setUser(u)} />
  return <Shell user={user} config={config} onLogout={async () => { await window.fcm.auth.logout(); setUser(null) }} />
}
