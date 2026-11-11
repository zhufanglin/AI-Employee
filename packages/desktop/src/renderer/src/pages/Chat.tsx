import { useEffect, useRef, useState } from 'react'
import { ChatMessageItem, ChatSessionSummary, Model } from '../types'

type Msg = { role: 'user' | 'assistant'; content: string; error?: boolean }
type ActiveSend = { requestId: string; sessionId: string; content: string }

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

// 会话列表里的更新时间：今天显示 HH:mm，更早显示 MM-DD。
function formatSessionTime(iso?: string) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) : pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

export default function Chat({ models, onBalance }: { models: Model[]; onBalance: (n: number) => void }) {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [sessionLoading, setSessionLoading] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [editing, setEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [editError, setEditError] = useState('')
  const [banner, setBanner] = useState('')
  const [model, setModel] = useState<string>('')
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [usage, setUsage] = useState<any>(null)
  const requestRef = useRef<string>('')
  const activeRef = useRef<ActiveSend | null>(null)
  const errorHandledRef = useRef(false)
  const sessionIdRef = useRef<string | null>(null)
  const openSeqRef = useRef(0)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (models.length && !model) setModel(models[0].id)
  }, [models, model])

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight, behavior: 'smooth' })
  }, [msgs])

  useEffect(() => {
    void refreshSessions()
  }, [])

  function applySession(id: string | null) {
    sessionIdRef.current = id
    setSessionId(id)
  }

  async function refreshSessions(): Promise<ChatSessionSummary[]> {
    try {
      const r = await window.fcm.chat.sessions(30)
      const items = Array.isArray(r?.items) ? r.items : []
      setSessions(items)
      const sid = sessionIdRef.current
      if (sid) {
        const cur = items.find((item) => item.id === sid)
        if (cur && cur.title) setTitle(cur.title)
      }
      return items
    } catch (e: any) {
      setBanner('加载会话列表失败：' + String(e?.message || e))
      return []
    } finally {
      setSessionsLoading(false)
    }
  }

  // 失败时把最后一条空 assistant 占位替换成错误气泡，并持久化 isError 消息。
  function finishError(message: string) {
    if (errorHandledRef.current) return
    errorHandledRef.current = true
    const active = activeRef.current
    activeRef.current = null
    const text = message || '请求失败'
    setMsgs((prev) => {
      const next = [...prev]
      const last = next[next.length - 1]
      if (last && last.role === 'assistant' && !last.content) {
        next[next.length - 1] = { role: 'assistant', content: text, error: true }
      } else {
        next.push({ role: 'assistant', content: text, error: true })
      }
      return next
    })
    setBusy(false)
    if (active?.sessionId) {
      void window.fcm.chat
        .appendMessages(active.sessionId, [{ role: 'assistant', content: text, isError: true }])
        .catch(() => {})
    }
  }

  useEffect(() => {
    const offChunk = window.fcm.chat.onChunk(({ requestId, delta }) => {
      if (requestId !== requestRef.current) return
      if (activeRef.current) activeRef.current.content += delta
      setMsgs((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last && last.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + delta }
        return next
      })
    })
    const offDone = window.fcm.chat.onDone(({ requestId, usage, content, aborted }) => {
      if (requestId !== requestRef.current) return
      const active = activeRef.current
      const finalContent = String(content || '') || (active ? active.content : '')
      setMsgs((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last && last.role === 'assistant') next[next.length - 1] = { ...last, content: finalContent || last.content }
        return next
      })
      setUsage(usage || null)
      setBusy(false)
      if (aborted) setStopped(true)
      const sid = active?.sessionId
      if (sid && finalContent) {
        void window.fcm.chat
          .appendMessages(sid, [
            {
              role: 'assistant',
              content: finalContent,
              tokensIn: usage?.prompt_tokens,
              tokensOut: usage?.completion_tokens,
              isError: false
            }
          ])
          .then(() => {
            void refreshSessions()
          })
          .catch(() => {})
      } else {
        void refreshSessions()
      }
      activeRef.current = null
      window.fcm.credits.balance().then((b) => onBalance(b.balance)).catch(() => {})
    })
    const offErr = window.fcm.chat.onError(({ requestId, message }) => {
      if (requestId !== requestRef.current) return
      finishError(String(message || '请求失败'))
    })
    return () => {
      offChunk()
      offDone()
      offErr()
    }
  }, [])

  function startNew() {
    if (busy) return
    openSeqRef.current++
    applySession(null)
    setTitle('')
    setTitleDraft('')
    setEditing(false)
    setEditError('')
    setMsgs([])
    setUsage(null)
    setStopped(false)
    setBanner('')
    setSessionLoading(false)
  }

  async function openSession(id: string) {
    if (busy) return
    const seq = ++openSeqRef.current
    setSessionLoading(true)
    setBanner('')
    try {
      const detail = await window.fcm.chat.getSession(id)
      if (seq !== openSeqRef.current) return
      const session = detail.session
      applySession(session.id)
      setTitle(session.title || '')
      setEditing(false)
      setEditError('')
      if (session.model && models.some((m) => m.id === session.model)) setModel(session.model)
      const list = Array.isArray(detail.messages) ? detail.messages : []
      setMsgs(
        list.map((m: ChatMessageItem): Msg => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content || '',
          error: !!m.isError
        }))
      )
      setUsage(null)
      setStopped(false)
    } catch (e: any) {
      if (seq === openSeqRef.current) setBanner('加载对话失败：' + String(e?.message || e))
    } finally {
      if (seq === openSeqRef.current) setSessionLoading(false)
    }
  }

  async function handleDelete(id: string) {
    if (busy) return
    if (!window.confirm('删除这个对话？删除后不可恢复。')) return
    try {
      await window.fcm.chat.removeSession(id)
      const items = await refreshSessions()
      if (sessionIdRef.current === id) {
        if (items.length > 0) await openSession(items[0].id)
        else startNew()
      }
    } catch (e: any) {
      setBanner('删除对话失败：' + String(e?.message || e))
    }
  }

  function startRename() {
    if (!sessionIdRef.current) return
    setTitleDraft(title || '')
    setEditError('')
    setEditing(true)
  }

  async function commitRename() {
    const id = sessionIdRef.current
    const nextTitle = titleDraft.trim()
    if (!id) {
      setEditing(false)
      return
    }
    if (!nextTitle) {
      setEditError('标题不能为空')
      return
    }
    if (nextTitle === title) {
      setEditing(false)
      return
    }
    try {
      await window.fcm.chat.renameSession(id, { title: nextTitle })
      setTitle(nextTitle)
      setEditing(false)
      setEditError('')
      void refreshSessions()
    } catch (e: any) {
      // 失败保留输入框，把服务端原因原样显示出来
      setEditError(String(e?.message || e))
    }
  }

  async function changeModel(next: string) {
    const prev = model
    if (next === prev) return
    setModel(next)
    const id = sessionIdRef.current
    if (!id) return
    try {
      await window.fcm.chat.renameSession(id, { model: next })
      void refreshSessions()
    } catch (e: any) {
      setModel(prev)
      setBanner('切换模型失败：' + String(e?.message || e))
    }
  }

  function stop() {
    if (!busy) return
    const requestId = requestRef.current
    if (!requestId) return
    void window.fcm.chat.abort(requestId)
  }

  async function send() {
    const text = input.trim()
    if (!text || busy || !model || sessionLoading) return
    let sid = sessionIdRef.current
    if (!sid) {
      try {
        const created = await window.fcm.chat.createSession({ model })
        sid = created.session.id
        applySession(sid)
        setTitle(created.session.title || '')
        void refreshSessions()
      } catch (e: any) {
        setBanner('新建对话失败：' + String(e?.message || e))
        return
      }
    }
    const history: Msg[] = [
      ...msgs.filter((m) => !m.error && !(m.role === 'assistant' && !m.content)),
      { role: 'user', content: text }
    ]
    setInput('')
    setMsgs([...history, { role: 'assistant', content: '' }])
    setBusy(true)
    setStopped(false)
    setBanner('')
    const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36)
    requestRef.current = requestId
    activeRef.current = { requestId, sessionId: sid, content: '' }
    errorHandledRef.current = false
    // 先持久化用户这条消息（失败不阻塞生成，最终以服务端保存为准）
    void window.fcm.chat.appendMessages(sid, [{ role: 'user', content: text }]).catch(() => {})
    try {
      await window.fcm.chat.send({
        requestId,
        body: {
          model,
          messages: history.map((m) => ({ role: m.role, content: m.content }))
        }
      })
    } catch (e: any) {
      if (!errorHandledRef.current) finishError(String(e?.message || e))
    }
  }

  return (
    <div className="chat-page">
      <aside className="chat-sessions">
        <button className="chat-new" onClick={startNew} disabled={busy}>＋ 新对话</button>
        <div className="chat-session-list">
          {sessionsLoading && sessions.length === 0 && <div className="chat-session-empty">加载中…</div>}
          {!sessionsLoading && sessions.length === 0 && <div className="chat-session-empty">暂无历史对话</div>}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={'chat-session-item' + (s.id === sessionId ? ' on' : '')}
              onClick={() => { void openSession(s.id) }}
              title={s.title || '新对话'}
            >
              <div className="chat-session-top">
                <span className="chat-session-title">{s.title || '新对话'}</span>
                <span className="chat-session-time">{formatSessionTime(s.updatedAt)}</span>
              </div>
              <div className="chat-session-preview">{s.preview || '还没有消息'}</div>
              <button
                className="chat-session-del"
                title="删除对话"
                onClick={(e) => { e.stopPropagation(); void handleDelete(s.id) }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>

      <section className="chat chat-main">
        <header className="chat-head">
          <div className="chat-head-info">
            {editing ? (
              <div className="chat-title">
                <input
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); void commitRename() }
                    if (e.key === 'Escape') setEditing(false)
                  }}
                  autoFocus
                  placeholder="对话标题"
                />
                <button className="tiny-btn" onClick={() => void commitRename()}>保存</button>
                <button className="tiny-btn" onClick={() => setEditing(false)}>取消</button>
              </div>
            ) : (
              <h2
                className={sessionId ? 'clickable' : ''}
                onClick={startRename}
                title={sessionId ? '点击重命名' : ''}
              >
                {title || '新对话'}
                {sessionId && <span className="pen">✎</span>}
              </h2>
            )}
            {editError ? <p className="chat-title-error">{editError}</p> : <p>{sessionId ? '对话已保存到云端' : '发送后自动保存到云端'}</p>}
          </div>
          <select value={model} onChange={(e) => { void changeModel(e.target.value) }} title="选择模型" disabled={busy}>
            {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </header>

        {banner && <div className="chat-banner">{banner}</div>}

        <div className="messages" ref={boxRef}>
          {sessionLoading && <div className="chat-loading">正在载入对话…</div>}
          {!sessionLoading && msgs.length === 0 && (
            <div className="empty">
              <h3>开始一段对话</h3>
              <p>{sessionId ? '继续输入消息即可' : '当前模型：' + (models.find((m) => m.id === model)?.name || '—')}</p>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={'msg ' + m.role + (m.error ? ' error' : '')}>
              <div className="who">{m.role === 'user' ? '我' : 'AI 员工'}</div>
              <div className="bubble">{m.content || (busy && i === msgs.length - 1 ? '▍' : '')}</div>
            </div>
          ))}
          {stopped && <div className="chat-stopped">已停止生成</div>}
        </div>

        <div className="composer">
          {usage && <div className="usage">本次：输入 {usage.prompt_tokens ?? 0} / 输出 {usage.completion_tokens ?? 0} tokens</div>}
          <div className="row">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (!busy) void send()
                }
              }}
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              rows={3}
            />
            {busy ? (
              <button className="primary chat-stop" onClick={stop}>停止</button>
            ) : (
              <button className="primary" disabled={!input.trim() || !model || sessionLoading} onClick={() => void send()}>发送</button>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
