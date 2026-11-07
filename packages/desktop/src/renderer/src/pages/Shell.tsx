import { useEffect, useState } from 'react'
import Chat from './Chat'
import Credits from './Credits'
import Settings from './Settings'
import Gateway from './Gateway'
import EmployeeOffice from './EmployeeOffice'
import MediaStudio from './MediaStudio'
import MediaCreation from './MediaCreation'
import { Model } from '../types'

type Tab = 'chat' | 'employees' | 'digital' | 'voice' | 'image' | 'video' | 'credits' | 'gateway' | 'settings'

export default function Shell({ user, config, onLogout }: { user: any; config: any; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('chat')
  // 「高级/实验」折叠区：文生图 / 图生视频是原版没有的一级入口（见 docs/handoff/界面偏差登记.md D-01），
  // 按用户决定收敛为折叠区，默认收起，避免看起来像复刻的产品主界面。
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [models, setModels] = useState<Model[]>([])
  const [balance, setBalance] = useState<number>(user.credits ?? 0)

  useEffect(() => {
    window.fcm.models().then(setModels).catch((e) => console.error('models failed', e))
    window.fcm.credits.balance().then((b) => setBalance(b.balance)).catch(() => {})
  }, [])

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand small">
          <div className="logo">元</div>
          <div>
            <h1>{config?.siteName || 'AI 员工'}</h1>
            <p>v{config?.version || '0.1.0'}</p>
          </div>
        </div>

        <nav>
          <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>💬 对话</button>
          <button className={tab === 'employees' ? 'on' : ''} onClick={() => setTab('employees')}>🧑‍💻 员工办公区</button>
          <button className={tab === 'digital' ? 'on' : ''} onClick={() => setTab('digital')}>🎬 数字人</button>
          <button className={tab === 'voice' ? 'on' : ''} onClick={() => setTab('voice')}>🎙️ 音色克隆</button>
          <div className="nav-group">
            <button
              className="nav-group-head"
              title="原版客户端没有这两个入口；这里保留能力，供内部/实验使用"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              <span className="caret">{showAdvanced || tab === 'image' || tab === 'video' ? '▾' : '▸'}</span> 🧪 高级 / 实验
            </button>
            {(showAdvanced || tab === 'image' || tab === 'video') && (
              <>
                <button className={tab === 'image' ? 'on sub' : 'sub'} onClick={() => setTab('image')}>🖼️ 文生图</button>
                <button className={tab === 'video' ? 'on sub' : 'sub'} onClick={() => setTab('video')}>🎞️ 图生视频</button>
              </>
            )}
          </div>
          <button className={tab === 'credits' ? 'on' : ''} onClick={() => setTab('credits')}>📊 积分与用量</button>
          <button className={tab === 'gateway' ? 'on' : ''} onClick={() => setTab('gateway')}>🔌 渠道网关</button>
          <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>⚙️ 设置</button>
        </nav>

        <div className="sidebar-foot">
          <div className="user">
            <div className="avatar">{(user.nickname || 'U').slice(0, 1)}</div>
            <div>
              <b>{user.nickname || user.phone || '用户'}</b>
              <span>积分 {balance}</span>
            </div>
          </div>
          <button className="ghost wide" onClick={onLogout}>退出登录</button>
        </div>
      </aside>

      <main className="content">
        {tab === 'chat' && <Chat models={models} onBalance={(n) => setBalance(n)} />}
        {tab === 'employees' && <EmployeeOffice />}
        {tab === 'digital' && <MediaStudio mode="digital" />}
        {tab === 'voice' && <MediaStudio mode="voice" />}
        <div hidden={tab !== 'image'}><MediaCreation mode="image" onBalance={setBalance} /></div>
        <div hidden={tab !== 'video'}><MediaCreation mode="video" onBalance={setBalance} /></div>
        {tab === 'credits' && <Credits />}
        {tab === 'gateway' && <Gateway />}
        {tab === 'settings' && <Settings config={config} />}
      </main>
    </div>
  )
}
