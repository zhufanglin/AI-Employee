import { useCallback, useEffect, useRef, useState } from 'react'

type MemoryItem = {
  id: string
  kind: string
  title: string | null
  content: string
  tags: string[]
  employeeSlug?: string | null
  sourceTaskId?: string | null
  hitCount?: number
  createdAt: string
  updatedAt?: string
}

type MemoryStats = {
  total?: number
  byKind?: Record<string, number>
  last7d?: number
  topTags?: { tag: string; count: number }[]
}

type DedupeProposal = {
  relation?: string
  keepId?: string
  dropId?: string
  keepTitle?: string | null
  dropTitle?: string | null
  similarity?: number
  mergedPreview?: string | null
}

type DedupeResult = {
  mode?: string
  total?: number
  scanned?: number
  calls?: number
  applied?: number
  truncated?: boolean
  durationMs?: number
  proposals?: DedupeProposal[]
}

const KIND_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'note', label: '笔记' },
  { value: 'fact', label: '事实' },
  { value: 'preference', label: '偏好' },
  { value: 'lesson', label: '经验' }
]
const KIND_LABEL: Record<string, string> = { note: '笔记', fact: '事实', preference: '偏好', lesson: '经验' }
const KIND_KEYS = ['note', 'fact', 'preference', 'lesson']
const PAGE_SIZE = 20

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

function itemTitle(item: MemoryItem): string {
  const title = String(item.title || '').trim()
  if (title) return title
  const text = String(item.content || '').trim()
  if (!text) return '（无标题）'
  return text.length > 20 ? text.slice(0, 20) + '…' : text
}

export default function Memory() {
  const [searchText, setSearchText] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [kind, setKind] = useState('')
  const [items, setItems] = useState<MemoryItem[]>([])
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyId, setBusyId] = useState('')
  const [merging, setMerging] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dedupe, setDedupe] = useState<DedupeResult | null>(null)
  const [dedupeBusy, setDedupeBusy] = useState(false)
  const reqRef = useRef(0)

  const refreshStats = useCallback(async () => {
    const memory = (window as any).fcm.memory
    try {
      const s = await memory.stats()
      setStats(s || null)
    } catch {
      /* 统计失败不覆盖列表错误；列表刷新时会再次尝试 */
    }
  }, [])

  const refresh = useCallback(async () => {
    const memory = (window as any).fcm.memory
    const rid = ++reqRef.current
    setLoading(true)
    setError('')
    try {
      const r = await memory.list({
        query: appliedQuery || undefined,
        kind: kind || undefined,
        limit: PAGE_SIZE
      })
      if (rid !== reqRef.current) return
      const list: MemoryItem[] = Array.isArray(r?.items) ? r.items : []
      setItems(list)
      setNextCursor(r?.nextCursor || null)
      setTotal(typeof r?.total === 'number' ? r.total : list.length)
      setSelected(new Set())
      setExpanded(new Set())
    } catch (e: any) {
      if (rid === reqRef.current) setError(friendlyError(e))
    } finally {
      if (rid === reqRef.current) setLoading(false)
    }
    await refreshStats()
  }, [appliedQuery, kind, refreshStats])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    const memory = (window as any).fcm.memory
    setLoadingMore(true)
    setError('')
    try {
      const r = await memory.list({
        query: appliedQuery || undefined,
        kind: kind || undefined,
        limit: PAGE_SIZE,
        cursor: nextCursor
      })
      const list: MemoryItem[] = Array.isArray(r?.items) ? r.items : []
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id))
        return [...current, ...list.filter((item) => !seen.has(item.id))]
      })
      setNextCursor(r?.nextCursor || null)
      if (typeof r?.total === 'number') setTotal(r.total)
    } catch (e: any) {
      setError(friendlyError(e))
    } finally {
      setLoadingMore(false)
    }
  }

  async function removeItem(item: MemoryItem) {
    if (!window.confirm('确定删除记忆「' + itemTitle(item) + '」吗？删除后不可恢复。')) return
    const memory = (window as any).fcm.memory
    setBusyId(item.id)
    setError('')
    setNotice('')
    try {
      await memory.remove(item.id)
      setItems((current) => current.filter((row) => row.id !== item.id))
      setSelected((current) => {
        const next = new Set(current)
        next.delete(item.id)
        return next
      })
      setTotal((current) => (typeof current === 'number' ? Math.max(0, current - 1) : current))
      setNotice('已删除 1 条记忆')
      await refreshStats()
    } catch (e: any) {
      setError(friendlyError(e))
    } finally {
      setBusyId('')
    }
  }

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleExpanded(id: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function mergeSelected() {
    const ids = Array.from(selected)
    if (ids.length !== 2) return
    const memory = (window as any).fcm.memory
    setMerging(true)
    setError('')
    setNotice('')
    try {
      const r = await memory.merge({ keepId: ids[0], dropId: ids[1] })
      const preview = String(r?.content || '').slice(0, 30)
      setNotice('已合并 2 条记忆' + (preview ? '：' + preview + (String(r?.content || '').length > 30 ? '…' : '') : ''))
      setSelected(new Set())
      await refresh()
    } catch (e: any) {
      setError(friendlyError(e))
    } finally {
      setMerging(false)
    }
  }

  async function runDedupeReport() {
    const memory = (window as any).fcm.memory
    setDedupeBusy(true)
    setError('')
    setNotice('')
    try {
      const r = await memory.dedupe({ mode: 'report', limit: 30 })
      setDedupe(r || null)
      setNotice('查重完成：扫描 ' + Number(r?.scanned || 0) + ' 条，发现 ' + (r?.proposals || []).length + ' 组建议')
    } catch (e: any) {
      setError(friendlyError(e))
    } finally {
      setDedupeBusy(false)
    }
  }

  async function applyDedupe() {
    const memory = (window as any).fcm.memory
    setDedupeBusy(true)
    setError('')
    setNotice('')
    try {
      const r = await memory.dedupe({ mode: 'apply', limit: 30 })
      setDedupe(r || null)
      setNotice('查重执行完成：应用 ' + Number(r?.applied || 0) + ' 组，耗时 ' + Number(r?.durationMs || 0) + 'ms')
      await refresh()
    } catch (e: any) {
      setError(friendlyError(e))
    } finally {
      setDedupeBusy(false)
    }
  }

  const byKind = stats?.byKind || {}
  const proposals = dedupe?.proposals || []
  const selectedCount = selected.size

  return <div className="page memory-page">
    <header className="page-head">
      <h2>记忆</h2>
      <p>员工在任务里沉淀的长期记忆，可搜索、删除和手动合并</p>
    </header>

    <div className="memory-stats">
      <span>总数 <b>{typeof stats?.total === 'number' ? stats.total : (typeof total === 'number' ? total : '-')}</b></span>
      {KIND_KEYS.map((key) => <span key={key}>{KIND_LABEL[key]} <b>{byKind[key] ?? 0}</b></span>)}
      <span>最近 7 天 <b>{typeof stats?.last7d === 'number' ? stats.last7d : '-'}</b></span>
    </div>

    {error && <div className="error office-alert">{error}</div>}
    {notice && <div className="office-notice">{notice}</div>}

    <section className="page-card memory-toolbar">
      <form
        className="memory-search"
        onSubmit={(event) => {
          event.preventDefault()
          setAppliedQuery(searchText.trim())
        }}
      >
        <input
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          placeholder="搜索标题、内容或标签，回车搜索"
        />
        <button className="ghost" type="submit" disabled={loading}>搜索</button>
      </form>
      <select
        className="memory-kind"
        value={kind}
        onChange={(event) => setKind(event.target.value)}
        aria-label="按类型筛选"
      >
        {KIND_OPTIONS.map((option) => <option key={option.value || 'all'} value={option.value}>{option.label}</option>)}
      </select>
      <button
        className="ghost"
        disabled={loading}
        onClick={() => { setSearchText(''); setAppliedQuery(''); setKind('') }}
      >重置</button>
      <button className="primary office-button" disabled={dedupeBusy} onClick={() => void runDedupeReport()}>
        {dedupeBusy ? '查重中…' : '查重'}
      </button>
    </section>

    {selectedCount > 0 && <div className="memory-mergebar">
      <span>
        已选 {selectedCount} 条{selectedCount === 2 ? '，合并时以创建时间较早的一条为准' : '，请再选 1 条进行合并'}
      </span>
      {selectedCount === 2 && (
        <button className="primary office-button" disabled={merging} onClick={() => void mergeSelected()}>
          {merging ? '合并中…' : '合并所选 2 条'}
        </button>
      )}
      <button className="ghost" disabled={merging} onClick={() => setSelected(new Set())}>取消选择</button>
    </div>}

    {!!dedupe && <section className="page-card memory-dedupe">
      <div className="office-section-head">
        <div>
          <h3>查重建议 <small>{dedupe.mode === 'apply' ? '（已执行）' : '（报告）'}</small></h3>
          <p>
            全库 {Number(dedupe.total || 0)} 条，本次扫描 {Number(dedupe.scanned || 0)} 条，发现 {proposals.length} 组
            {dedupe.truncated ? '（达到预算上限，结果已截断）' : ''}，用时 {Number(dedupe.durationMs || 0)}ms
          </p>
        </div>
        <div className="memory-dedupe-actions">
          <button className="ghost" disabled={dedupeBusy || dedupe.mode === 'apply'} onClick={() => void applyDedupe()}>
            立即合并（执行）
          </button>
          <button className="ghost" disabled={dedupeBusy} onClick={() => setDedupe(null)}>关闭</button>
        </div>
      </div>
      {!proposals.length && <div className="empty-state">没有发现需要合并的重复记忆</div>}
      {!!proposals.length && <div className="memory-proposals">
        {proposals.map((proposal, index) => <article className="memory-proposal" key={(proposal.keepId || '') + '-' + (proposal.dropId || '') + '-' + index}>
          <div className="memory-proposal-head">
            <span className={proposal.relation === 'merge' ? 'pill active' : 'pill'}>
              {proposal.relation === 'merge' ? '可合并' : '疑似重复'}
            </span>
            <span className="muted small">
              相似度 {typeof proposal.similarity === 'number' ? (proposal.similarity * 100).toFixed(1) + '%' : '-'}
            </span>
          </div>
          <div className="memory-proposal-row"><span>保留</span><b>{proposal.keepTitle || proposal.keepId || '-'}</b></div>
          <div className="memory-proposal-row"><span>删除</span><b>{proposal.dropTitle || proposal.dropId || '-'}</b></div>
          {proposal.mergedPreview && <pre className="memory-proposal-preview">{proposal.mergedPreview}</pre>}
        </article>)}
      </div>}
    </section>}

    <section className="office-block">
      <div className="office-section-head">
        <div><h3>记忆列表 <small>{typeof total === 'number' ? '共 ' + total + ' 条' : ''}</small></h3></div>
        <button className="ghost" disabled={loading} onClick={() => void refresh()}>刷新</button>
      </div>

      {loading && !items.length && <div className="empty-state">加载中…</div>}
      {!loading && !items.length && !error && (
        <div className="empty-state">还没有记忆，员工在任务里说的客户偏好会自动记下来</div>
      )}

      {!!items.length && <div className="memory-list">
        {items.map((item) => {
          const text = String(item.content || '')
          const isExpanded = expanded.has(item.id)
          const longContent = text.length > 40 || text.includes('\n')
          return <article className={selected.has(item.id) ? 'memory-card selected' : 'memory-card'} key={item.id}>
            <div className="memory-card-head">
              <label className="memory-check-wrap" title="选中用于合并">
                <input
                  type="checkbox"
                  className="memory-check"
                  checked={selected.has(item.id)}
                  onChange={() => toggleSelected(item.id)}
                />
              </label>
              <b className="memory-title">{itemTitle(item)}</b>
              <span className="pill">{KIND_LABEL[item.kind] || item.kind || '其他'}</span>
            </div>
            <div className={isExpanded ? 'memory-content expanded' : 'memory-content'}>{text || '（无内容）'}</div>
            {longContent && (
              <button className="link" onClick={() => toggleExpanded(item.id)}>{isExpanded ? '收起' : '展开全文'}</button>
            )}
            {!!item.tags?.length && <div className="memory-tags">
              {item.tags.map((tag) => <span className="memory-tag" key={tag}>#{tag}</span>)}
            </div>}
            <div className="memory-meta">
              <span>{item.createdAt ? new Date(item.createdAt).toLocaleString() : ''}</span>
              <span>命中 {Number(item.hitCount || 0)} 次</span>
              {item.employeeSlug && <span>员工 {item.employeeSlug}</span>}
              <button className="link memory-remove" disabled={busyId === item.id} onClick={() => void removeItem(item)}>
                {busyId === item.id ? '删除中…' : '删除'}
              </button>
            </div>
          </article>
        })}
      </div>}

      {!!nextCursor && <div className="memory-more">
        <button className="ghost" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? '加载中…' : '加载更多'}
        </button>
      </div>}
    </section>
  </div>
}
