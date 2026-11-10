import { useEffect, useState } from 'react'
import Chat from './Chat'
import Credits from './Credits'
import Settings from './Settings'
import Gateway from './Gateway'
import EmployeeOffice from './EmployeeOffice'
import Memory from './Memory'
import Strategy from './Strategy'
import PlatformPublish from './PlatformPublish'
import Workspace from './Workspace'
import Scheduled from './Scheduled'
import MediaStudio from './MediaStudio'
import MediaCreation from './MediaCreation'
import { Model } from '../types'

type Tab =
  | 'chat'
  | 'employees'
  | 'digital'
  | 'voice'
  | 'image'
  | 'video'
  | 'memory'
  | 'strategy'
  | 'platform'
  | 'files'
  | 'scheduled'
  | 'credits'
  | 'gateway'
  | 'settings'

export default function Shell({ user, config, onLogout }: { user: any; config: any; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('chat')
  // 「高级/实验」折叠区：文生图 / 图生视频是原版没有的一级入口（见 docs/handoff/界面偏差登记.md D-01），
  // 按用户决定收敛为折叠区，默认收起，避免看起来像复刻的产品主界面。
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [models, setModels] = useState<Model[]>([])
  const [balance, setBalance] = useState<number>(user.credits ?? 0)
  // 版本号直接取主进程的真实版本，避免界面上写死旧版本造成误解。
  const [version, setVersion] = useState<string>('')

  useEffect(() => {
    window.fcm.info().then((i) => setVersion(i.version)).catch(() => {})
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
            <p>v{version || config?.version || ''}</p>
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
          <button className={tab === 'memory' ? 'on' : ''} onClick={() => setTab('memory')}>🧠 记忆</button>
          <button className={tab === 'strategy' ? 'on' : ''} onClick={() => setTab('strategy')}>🧭 战略与人设</button>
          <button className={tab === 'platform' ? 'on' : ''} onClick={() => setTab('platform')}>📤 平台发布</button>
          <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>📁 文件</button>
          <button className={tab === 'scheduled' ? 'on' : ''} onClick={() => setTab('scheduled')}>⏰ 定时任务</button>
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
        {tab === 'memory' && <Memory />}
        {tab === 'strategy' && <Strategy />}
        {tab === 'platform' && <PlatformPublish />}
        {tab === 'files' && <Workspace />}
        {tab === 'scheduled' && <Scheduled />}
        {tab === 'credits' && <Credits />}
        {tab === 'gateway' && <Gateway />}
        {tab === 'settings' && <Settings config={config} />}
      </main>
    </div>
  )
}
