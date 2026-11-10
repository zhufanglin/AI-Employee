import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  PersonaItem,
  PersonaSaveInput,
  StrategyDocView,
  StrategyIterationItem
} from '../types'

type TabId = 'strategy' | 'persona'

type PersonaDraft = {
  id: string
  name: string
  positioning: string
  plan: string
  accountId: string
  followers: string
  homepage: string
  effectiveAt: string
}

// 原版战略文档是 10 节长文（见 P42 逆向 §2.2）；这里只负责插入小节标题，正文完全自由编辑。
const SECTION_TITLES = [
  '1. 企业愿景与使命',
  '2. 产品体系',
  '3. 服务客户人群',
  '4. 竞争与优势',
  '5. 获客渠道',
  '6. 内容策略',
  '7. 销售与转化',
  '8. 私域运营',
  '9. 团队与资源',
  '10. 本季度目标'
]

function todayInput(): string {
  const date = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

function dateInput(value?: string): string {
  const text = String(value || '').trim()
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : ''
}

function emptyPersona(): PersonaDraft {
  return {
    id: '',
    name: '',
    positioning: '',
    plan: '',
    accountId: '',
    followers: '',
    homepage: '',
    effectiveAt: todayInput()
  }
}

function toDraft(item: PersonaItem): PersonaDraft {
  return {
    id: item.id,
    name: item.name || '',
    positioning: item.positioning || '',
    plan: item.plan || '',
    accountId: item.accountId || '',
    followers: item.followers || '',
    homepage: item.homepage || '',
    effectiveAt: dateInput(item.effectiveAt)
  }
}

function toSaveInput(draft: PersonaDraft): PersonaSaveInput {
  return {
    name: draft.name.trim(),
    positioning: draft.positioning,
    plan: draft.plan,
    accountId: draft.accountId,
    followers: draft.followers,
    homepage: draft.homepage,
    effectiveAt: draft.effectiveAt
  }
}

function fmtTime(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

/** 去掉 Electron IPC 包装，只留后端 message；401 追加重新登录提示。 */
function friendlyError(e: any): string {
  const raw = String(e?.message || e || '操作失败')
  const msg = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim()
  if (/401|unauthor|登录已过期|未登录|token/i.test(raw)) return (msg || '登录已过期') + '（登录已过期，请重新登录）'
  return msg || '操作失败'
}

export default function Strategy() {
  const [tab, setTab] = useState<TabId>('strategy')

  const [doc, setDoc] = useState<StrategyDocView | null>(null)
  const [content, setContent] = useState('')
  const [iterations, setIterations] = useState<StrategyIterationItem[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [insertOpen, setInsertOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const [personas, setPersonas] = useState<PersonaItem[]>([])
  const [drafts, setDrafts] = useState<Record<string, PersonaDraft>>({})
  const [newPersona, setNewPersona] = useState<PersonaDraft>(emptyPersona)
  const [personaLoading, setPersonaLoading] = useState(true)
  const [busyId, setBusyId] = useState('')

  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const loadStrategy = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [docResult, iterResult] = await Promise.all([
        window.fcm.strategy.get(),
        window.fcm.strategy.iterations()
      ])
      if (!docResult.ok) {
        setError(docResult.error || '读取战略失败')
        return
      }
      const next = docResult.data || null
      setDoc(next)
      setContent(next?.content || '')
      if (iterResult.ok) setIterations(iterResult.data?.items || [])
    } catch (e: any) {
      setError(friendlyError(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadPersonas = useCallback(async () => {
    setPersonaLoading(true)
    setError('')
    try {
      const result = await window.fcm.strategy.listPersonas()
      if (!result.ok) {
        setError(result.error || '读取账号人设失败')
        return
      }
      const items = result.data?.items || []
      setPersonas(items)
      const nextDrafts: Record<string, PersonaDraft> = {}
      for (const item of items) nextDrafts[item.id] = toDraft(item)
      setDrafts(nextDrafts)
    } catch (e: any) {
      setError(friendlyError(e))
    } finally {
      setPersonaLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStrategy()
    void loadPersonas()
  }, [loadStrategy, loadPersonas])

  async function saveStrategy(): Promise<void> {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const result = await window.fcm.strategy.save({
        content,
        versionType: '微调',
        trigger: '桌面端手动编辑',
        summary: '手动保存战略文档'
      })
      if (!result.ok) {
        setError(result.error || '保存战略失败')
        return
      }
      const version = result.data?.version || 'V1.1'
      const updatedAt = result.data?.updatedAt || new Date().toISOString()
      setDoc((prev) => ({ version, updatedAt, updatedBy: prev?.updatedBy, content }))
      setNotice('已保存为 ' + version)
      const iterResult = await window.fcm.strategy.iterations()
      if (iterResult.ok) setIterations(iterResult.data?.items || [])
    } catch (e: any) {
      setError(friendlyError(e))
    } finally {
      setSaving(false)
    }
  }

  function insertSection(title: string): void {
    const heading = '## ' + title + '\n'
    const ta = textareaRef.current
    if (!ta) {
      setContent((prev) => prev + (prev && !prev.endsWith('\n') ? '\n' : '') + heading)
      setInsertOpen(false)
      return
    }
    const start = ta.selectionStart ?? content.length
    const end = ta.selectionEnd ?? content.length
    const before = content.slice(0, start)
    const after = content.slice(end)
    const prefix = before && !before.endsWith('\n') ? '\n' : ''
    const next = before + prefix + heading + after
    setContent(next)
    setInsertOpen(false)
    requestAnimationFrame(() => {
      ta.focus()
      const pos = (before + prefix + heading).length
      ta.setSelectionRange(pos, pos)
    })
  }

  function updateDraft(item: PersonaItem, patch: Partial<PersonaDraft>): void {
    setDrafts((prev) => ({
      ...prev,
      [item.id]: { ...(prev[item.id] || toDraft(item)), ...patch }
    }))
  }

  function updateNewDraft(patch: Partial<PersonaDraft>): void {
    setNewPersona((prev) => ({ ...prev, ...patch }))
  }

  async function saveRow(item: PersonaItem): Promise<void> {
    const draft = drafts[item.id] || toDraft(item)
    if (!draft.name.trim()) {
      setError('人设名称必填')
      return
    }
    setError('')
    setNotice('')
    setBusyId(item.id)
    try {
      const result = await window.fcm.strategy.savePersona(toSaveInput(draft))
      if (!result.ok) {
        setError(result.error || '保存账号人设失败')
        return
      }
      setNotice('已保存人设：' + (result.data?.item?.name || draft.name.trim()))
      await loadPersonas()
    } catch (e: any) {
      setError(friendlyError(e))
    } finally {
      setBusyId('')
    }
  }

  async function addPersona(): Promise<void> {
    if (!newPersona.name.trim()) {
      setError('人设名称必填')
      return
    }
    setError('')
    setNotice('')
    setBusyId('new')
    try {
      const result = await window.fcm.strategy.savePersona(toSaveInput(newPersona))
      if (!result.ok) {
        setError(result.error || '保存账号人设失败')
        return
      }
      setNotice('已新增人设：' + (result.data?.item?.name || newPersona.name.trim()))
      setNewPersona(emptyPersona())
      await loadPersonas()
    } catch (e: any) {
      setError(friendlyError(e))
    } finally {
      setBusyId('')
    }
  }

  async function removePersona(item: PersonaItem): Promise<void> {
    if (!window.confirm('确定删除账号人设「' + (item.name || '未命名') + '」吗？删除后不可恢复。')) return
    setError('')
    setNotice('')
    setBusyId('del:' + item.id)
    try {
      const result = await window.fcm.strategy.removePersona({ id: item.id })
      if (!result.ok) {
        setError(result.error || '删除账号人设失败')
        return
      }
      setNotice('已删除人设：' + (item.name || '未命名'))
      await loadPersonas()
    } catch (e: any) {
      setError(friendlyError(e))
    } finally {
      setBusyId('')
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>战略与人设</h2>
        <p>员工接活时会自动读取战略与人设：内容/流量类岗位读人设，销售类岗位只读战略。</p>
      </div>

      <div className="tabs" style={{ maxWidth: 360, margin: '0 0 16px' }}>
        <button className={tab === 'strategy' ? 'on' : ''} onClick={() => setTab('strategy')}>公司战略</button>
        <button className={tab === 'persona' ? 'on' : ''} onClick={() => setTab('persona')}>账号人设</button>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice ok">{notice}</p>}

      {tab === 'strategy' && (
        <>
          <section className="card">
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div>
                  <b>当前版本 {doc?.version || 'V1.0'}</b>
                  <span className="muted small" style={{ marginLeft: 10 }}>· 更新于 {fmtTime(doc?.updatedAt)}</span>
                </div>
                {doc?.updatedBy && <p className="muted small" style={{ margin: '2px 0 0' }}>更新人：{doc.updatedBy}</p>}
                <div style={{ position: 'relative', marginTop: 10 }}>
                  <button type="button" className="ghost" onClick={() => setInsertOpen((v) => !v)}>
                    插入板块 {insertOpen ? '▴' : '▾'}
                  </button>
                  {insertOpen && (
                    <div
                      style={{
                        position: 'absolute',
                        zIndex: 20,
                        top: 'calc(100% + 6px)',
                        left: 0,
                        minWidth: 260,
                        background: 'var(--bg-2)',
                        border: '1px solid var(--line)',
                        borderRadius: 10,
                        padding: 6,
                        boxShadow: '0 12px 30px rgba(0, 0, 0, .45)',
                        maxHeight: 360,
                        overflowY: 'auto'
                      }}
                    >
                      {SECTION_TITLES.map((title) => (
                        <button
                          key={title}
                          type="button"
                          className="ghost small"
                          style={{ display: 'block', width: '100%', textAlign: 'left', margin: '2px 0', whiteSpace: 'normal' }}
                          onClick={() => insertSection(title)}
                        >
                          ## {title}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <button className="primary office-button" disabled={saving || loading} onClick={() => void saveStrategy()}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>

            {loading ? (
              <div className="empty-state">加载中…</div>
            ) : (
              <textarea
                ref={textareaRef}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={24}
                spellCheck={false}
                placeholder={'在这里写整篇公司战略，点击右上角「插入板块」可快速插入 10 个小节标题。\n\n## 1. 企业愿景与使命\n…'}
                style={{
                  marginTop: 14,
                  minHeight: 480,
                  resize: 'vertical',
                  fontFamily: 'ui-monospace, Consolas, monospace',
                  fontSize: 13,
                  lineHeight: 1.7
                }}
              />
            )}
            <p className="hint">
              战略正文是一整篇 markdown，保存后服务端会生成新的版本号并追加一条迭代记录。员工按各自岗位读取需要的板块。
            </p>
          </section>

          <section className="card" style={{ marginTop: 16 }}>
            <details>
              <summary style={{ cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
                最近迭代记录（{iterations.length}）
              </summary>
              {iterations.length === 0 ? (
                <div className="empty-state">还没有迭代记录，保存一次战略就会生成。</div>
              ) : (
                <div style={{ overflowX: 'auto', marginTop: 12 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>版本</th>
                        <th>类型</th>
                        <th>摘要</th>
                      </tr>
                    </thead>
                    <tbody>
                      {iterations.map((item, index) => (
                        <tr key={(item.versionNo || '') + '-' + (item.iteratedAt || '') + '-' + index}>
                          <td>{fmtTime(item.iteratedAt)}</td>
                          <td className="mono">{item.versionNo || '—'}</td>
                          <td>
                            <span className="pill">{item.versionType || '微调'}</span>
                          </td>
                          <td title={item.trigger ? '触发原因：' + item.trigger : undefined}>
                            {item.summary || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </details>
          </section>
        </>
      )}

      {tab === 'persona' && (
        <>
          <section className="card">
            <div className="office-section-head" style={{ marginBottom: 12 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 15 }}>
                  账号人设 <small className="muted" style={{ fontWeight: 400 }}>共 {personas.length} 个</small>
                </h3>
                <p className="muted small" style={{ margin: '4px 0 0' }}>一个账号一行；按名称 upsert，同名保存会覆盖原记录。</p>
              </div>
              <button className="ghost small" disabled={personaLoading || busyId !== ''} onClick={() => void loadPersonas()}>
                {personaLoading ? '刷新中…' : '刷新'}
              </button>
            </div>

            {personaLoading ? (
              <div className="empty-state">加载中…</div>
            ) : personas.length === 0 ? (
              <div className="empty-state">还没有账号人设，在下方「新增人设」里添加第一个账号。</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table" style={{ minWidth: 1180 }}>
                  <thead>
                    <tr>
                      <th style={{ minWidth: 140 }}>名称</th>
                      <th style={{ minWidth: 200 }}>定位</th>
                      <th style={{ minWidth: 260 }}>人设规划</th>
                      <th style={{ minWidth: 130 }}>所属账号</th>
                      <th style={{ minWidth: 100 }}>粉丝量</th>
                      <th style={{ minWidth: 180 }}>主页链接</th>
                      <th style={{ minWidth: 140 }}>日期</th>
                      <th style={{ minWidth: 130 }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {personas.map((item) => {
                      const draft = drafts[item.id] || toDraft(item)
                      return (
                        <tr key={item.id}>
                          <td>
                            <input
                              value={draft.name}
                              onChange={(e) => updateDraft(item, { name: e.target.value })}
                              placeholder="人设 / 账号名"
                              autoComplete="off"
                            />
                          </td>
                          <td>
                            <textarea
                              value={draft.positioning}
                              onChange={(e) => updateDraft(item, { positioning: e.target.value })}
                              rows={2}
                              placeholder="一句话定位"
                            />
                          </td>
                          <td>
                            <textarea
                              value={draft.plan}
                              onChange={(e) => updateDraft(item, { plan: e.target.value })}
                              rows={3}
                              placeholder="人设详细规划（目标、语气、内容占比等）"
                            />
                          </td>
                          <td>
                            <input
                              value={draft.accountId}
                              onChange={(e) => updateDraft(item, { accountId: e.target.value })}
                              placeholder="账号 ID"
                              autoComplete="off"
                            />
                          </td>
                          <td>
                            <input
                              value={draft.followers}
                              onChange={(e) => updateDraft(item, { followers: e.target.value })}
                              placeholder="如 1.2万"
                              autoComplete="off"
                            />
                          </td>
                          <td>
                            <input
                              value={draft.homepage}
                              onChange={(e) => updateDraft(item, { homepage: e.target.value })}
                              placeholder="https://…"
                              autoComplete="off"
                            />
                          </td>
                          <td>
                            <input
                              type="date"
                              value={draft.effectiveAt}
                              onChange={(e) => updateDraft(item, { effectiveAt: e.target.value })}
                            />
                          </td>
                          <td>
                            <button className="ghost small" disabled={busyId !== ''} onClick={() => void saveRow(item)}>
                              {busyId === item.id ? '保存中…' : '保存'}
                            </button>
                            <button
                              className="ghost small"
                              disabled={busyId !== ''}
                              onClick={() => void removePersona(item)}
                            >
                              {busyId === 'del:' + item.id ? '删除中…' : '删除'}
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card platform-form" style={{ marginTop: 16 }}>
            <h3>新增人设</h3>
            <div className="platform-form-row">
              <label>
                名称（必填）
                <input
                  value={newPersona.name}
                  onChange={(e) => updateNewDraft({ name: e.target.value })}
                  placeholder="例如：造造天幕老张"
                  autoComplete="off"
                />
              </label>
              <label>
                所属账号
                <input
                  value={newPersona.accountId}
                  onChange={(e) => updateNewDraft({ accountId: e.target.value })}
                  placeholder="账号 ID / 手机号"
                  autoComplete="off"
                />
              </label>
            </div>
            <label>
              定位
              <input
                value={newPersona.positioning}
                onChange={(e) => updateNewDraft({ positioning: e.target.value })}
                placeholder="一句话说清这个账号是谁、给谁看"
                autoComplete="off"
              />
            </label>
            <label>
              人设规划
              <textarea
                value={newPersona.plan}
                onChange={(e) => updateNewDraft({ plan: e.target.value })}
                rows={4}
                placeholder="人设详细规划：目标人群、内容方向、表达风格、涨粉/获客目标、内容占比等"
              />
            </label>
            <div className="platform-form-row">
              <label>
                粉丝量
                <input
                  value={newPersona.followers}
                  onChange={(e) => updateNewDraft({ followers: e.target.value })}
                  placeholder="如 1.2万"
                  autoComplete="off"
                />
              </label>
              <label>
                日期
                <input
                  type="date"
                  value={newPersona.effectiveAt}
                  onChange={(e) => updateNewDraft({ effectiveAt: e.target.value })}
                />
              </label>
            </div>
            <label>
              主页链接
              <input
                value={newPersona.homepage}
                onChange={(e) => updateNewDraft({ homepage: e.target.value })}
                placeholder="https://www.douyin.com/user/…"
                autoComplete="off"
              />
            </label>
            <p className="hint">人设只提供给内容/流量/数据类岗位；销售/客服类岗位不会读取人设。</p>
            <button
              className="primary office-button"
              disabled={busyId !== '' || !newPersona.name.trim()}
              onClick={() => void addPersona()}
            >
              {busyId === 'new' ? '新增中…' : '新增人设'}
            </button>
          </section>
        </>
      )}
    </div>
  )
}
