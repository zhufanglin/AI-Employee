import { useEffect, useRef, useState } from 'react'
import { Model } from '../types'

type Msg = { role: 'user' | 'assistant'; content: string; usage?: any; error?: boolean }

export default function Chat({ models, onBalance }: { models: Model[]; onBalance: (n: number) => void }) {
  const [model, setModel] = useState<string>('')
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [usage, setUsage] = useState<any>(null)
  const requestRef = useRef<string>('')
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (models.length && !model) setModel(models[0].id) }, [models])
  useEffect(() => { boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight, behavior: 'smooth' }) }, [msgs])

  useEffect(() => {
    const offChunk = window.fcm.chat.onChunk(({ requestId, delta }) => {
      if (requestId !== requestRef.current) return
      setMsgs((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last && last.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + delta }
        return next
      })
    })
    const offDone = window.fcm.chat.onDone(({ requestId, usage }) => {
      if (requestId !== requestRef.current) return
      setUsage(usage || null)
      setBusy(false)
      window.fcm.credits.balance().then((b) => onBalance(b.balance)).catch(() => {})
    })
    const offErr = window.fcm.chat.onError(({ requestId, message }) => {
      if (requestId !== requestRef.current) return
      setMsgs((prev) => [...prev, { role: 'assistant', content: message, error: true }])
      setBusy(false)
    })
    return () => { offChunk(); offDone(); offErr() }
  }, [])

  async function send() {
    const text = input.trim()
    if (!text || busy || !model) return
    setInput('')
    const history = [...msgs.filter((m) => !m.error), { role: 'user' as const, content: text }]
    setMsgs([...history, { role: 'assistant', content: '' }])
    setBusy(true)
    const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36)
    requestRef.current = requestId
    try {
      await window.fcm.chat.send({
        requestId,
        body: { model, messages: history.map((m) => ({ role: m.role, content: m.content })) }
      })
    } catch (e: any) {
      setMsgs((prev) => [...prev.slice(0, -1), { role: 'assistant', content: e.message, error: true }])
      setBusy(false)
    }
  }

  return (
    <div className="chat">
      <header className="chat-head">
        <div>
          <h2>对话</h2>
          <p>通过服务端代理调用官方模型，按次计费</p>
        </div>
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </header>

      <div className="messages" ref={boxRef}>
        {msgs.length === 0 && (
          <div className="empty">
            <h3>开始一段对话</h3>
            <p>当前模型：{models.find((m) => m.id === model)?.name || '—'}</p>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={'msg ' + m.role + (m.error ? ' error' : '')}>
            <div className="who">{m.role === 'user' ? '我' : 'AI 员工'}</div>
            <div className="bubble">{m.content || (busy && i === msgs.length - 1 ? '▍' : '')}</div>
          </div>
        ))}
      </div>

      <div className="composer">
        {usage && <div className="usage">本次：输入 {usage.prompt_tokens ?? 0} / 输出 {usage.completion_tokens ?? 0} tokens</div>}
        <div className="row">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            rows={3}
          />
          <button className="primary" disabled={busy || !input.trim()} onClick={send}>{busy ? '生成中' : '发送'}</button>
        </div>
      </div>
    </div>
  )
}
