import { useEffect, useState } from 'react'
import Login from './pages/Login'
import Onboarding from './pages/Onboarding'
import Shell from './pages/Shell'

export default function App() {
  const [booted, setBooted] = useState(false)
  const [user, setUser] = useState<any>(null)
  const [config, setConfig] = useState<any>(null)
  const [onboarded, setOnboarded] = useState(true)
  const [apiBase, setApiBase] = useState('')

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
      } finally {
        setBooted(true)
      }
    })()
  }, [])

  if (!booted) return <div className="boot">启动中…</div>
  if (!onboarded) return <Onboarding config={{ ...config, apiBase }} onDone={() => setOnboarded(true)} />
  if (!user) return <Login config={config} onLogin={(u) => setUser(u)} />
  return <Shell user={user} config={config} onLogout={async () => { await window.fcm.auth.logout(); setUser(null) }} />
}
