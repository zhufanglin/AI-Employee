import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'

const TEAM = ['boss-lead-radar', 'boss-private-lead-manager', 'boss-sales-followup']
const STATUS: Record<string, string> = {
  queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败',
  needs_input: '等待补充信息', awaiting_approval: '待验收'
}

export default function EmployeeOffice() {
  const [catalog, setCatalog] = useState<any[]>([])
  const [installed, setInstalled] = useState<any[]>([])
  const [tasks, setTasks] = useState<any[]>([])
  const [selected, setSelected] = useState('')
  const [query, setQuery] = useState('')
  const [title, setTitle] = useState('')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [executor, setExecutor] = useState<any>(null)
  const [apiOrigin, setApiOrigin] = useState('')
  const [attachments, setAttachments] = useState<any[]>([])
  const [library, setLibrary] = useState<any[]>([])

  useEffect(() => {
    let active = true
    ;(window as any).fcm.settings.get().then((s: any) => { if (active) setApiOrigin(new URL(s.apiBase).origin) }).catch(() => {})
    return () => { active = false }
  }, [])

  function mediaUrl(value: unknown) {
    if (typeof value !== 'string' || !value) return ''
    try {
      const url = new URL(value, apiOrigin || undefined)
      if (!['http:', 'https:'].includes(url.protocol)) return ''
      if (apiOrigin && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) && url.pathname.startsWith('/uploads/media/')) return new URL(url.pathname + url.search, apiOrigin).href
      return url.href
    } catch { return '' }
  }

  const refreshLibrary = useCallback(async () => {
    try { const r = await (window as any).fcm.workspace.list(50); setLibrary(r?.items || []) } catch { /* 忽略 */ }
  }, [])

  const refresh = useCallback(async () => {
    setError('')
    try {
      const [c, m, t] = await Promise.all([
        window.fcm.employees.catalog(), window.fcm.employees.mine(), window.fcm.employeeTasks.list('?limit=50')
      ])
      void refreshLibrary()
      const employees = c.items || []
      const mine = m.items || []
      setCatalog(employees)
      setInstalled(mine)
      setTasks(t.items || [])
      setSelected((current) => mine.some((item: any) => item.slug === current && item.install?.effectiveEnabled)
        ? current
        : mine.find((item: any) => item.install?.effectiveEnabled)?.slug || '')
    } catch (e: any) { setError(e?.message || '加载员工数据失败') }
  }, [refreshLibrary])

  useEffect(() => { void refresh() }, [refresh])

  // 本机执行器状态 + 任务列表轻量轮询：任务被端上执行完后自动从"排队中"变"待验收"
  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const [status, list] = await Promise.all([
          window.fcm.employeeExecution.status(), window.fcm.employeeTasks.list('?limit=50')
        ])
        if (!alive) return
        setExecutor(status)
        setTasks(list.items || [])
      } catch { /* 未登录或服务端暂不可用时静默 */ }
    }
    void poll()
    const timer = setInterval(poll, 6000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return catalog
    return catalog.filter((e) => [e.name, e.title, e.description, e.slug, ...(e.tags || [])].join(' ').toLowerCase().includes(q))
  }, [catalog, query])
  const installedIds = new Set(installed.filter((e) => e.install?.effectiveEnabled).map((e) => e.slug))
  const teamMembers = TEAM.map((slug) => catalog.find((e) => e.slug === slug)).filter(Boolean)

  async function act(fn: () => Promise<any>, message?: string) {
    setBusy(true); setError(''); setNotice('')
    try { await fn(); if (message) setNotice(message); await refresh() }
    catch (e: any) { setError(e?.message || '操作失败') }
    finally { setBusy(false) }
  }

  async function installTeam() {
    setBusy(true); setError(''); setNotice('')
    const failed: string[] = []
    for (const emp of teamMembers) {
      if (installedIds.has(emp.slug)) continue
      try { await window.fcm.employees.install(emp.slug) }
      catch (e: any) { failed.push(`${emp.name}：${e?.message || '安装失败'}`) }
    }
    await refresh()
    if (failed.length) setError('团队安装未全部完成：' + failed.join('；'))
    else setNotice('团队员工已安装')
    setBusy(false)
  }

  async function pickFiles() {
    setBusy(true); setError('')
    try {
      const picked = await (window as any).fcm.workspace.pick()
      const items = picked?.items || []
      if (items.length) {
        setAttachments((current) => {
          const seen = new Set(current.map((f) => f.key))
          return [...current, ...items.filter((f: any) => !seen.has(f.key))]
        })
        setNotice(`已上传 ${items.length} 份资料，提交任务时员工会读取它们`)
        void refreshLibrary()
      }
    } catch (e: any) { setError(e?.message || '上传资料失败') }
    finally { setBusy(false) }
  }

  async function removeLibraryFile(file: any) {
    await act(async () => {
      await (window as any).fcm.workspace.remove({ key: file.key })
      setAttachments((current) => current.filter((f) => f.key !== file.key))
      await refreshLibrary()
    }, `已删除 ${file.name}`)
  }

  function composedText() {
    const base = input.trim()
    if (!attachments.length) return base
    const list = attachments.map((f) => `- ${f.name}（${f.ext}，${Math.max(1, Math.round((f.bytes || 0) / 1024))}KB）`)
    return [base, '', '本次任务可用的上传资料：', ...list, '', '读取方式：先用 file_list 确认文件名；文本文件用 file_read（参数 name），Excel/Word/PDF 用 doc_read（参数 name）。不要凭空猜测文件内容。'].join('\n')
  }

  async function runTask(event: FormEvent) {
    event.preventDefault()
    if (!selected || !input.trim()) return
    await act(async () => {
      await window.fcm.employees.run({
        slug: selected,
        title: title.trim() || undefined,
        input: { text: composedText(), files: attachments.map((f) => ({ name: f.name, key: f.key })) }
      })
      setTitle(''); setInput(''); setAttachments([])
    }, '任务已提交；完成情况会显示在任务列表中。')
  }

  const taskEmployee = (id: string) => catalog.find((employee) => employee.id === id)

  return <div className="page employee-office">
    <header className="page-head office-head">
      <div><h2>员工办公区</h2><p>安装员工、提交任务、查看产物并验收结果</p></div>
      <div className="office-head-actions">
        <span className={executor?.running ? 'pill active' : 'pill'}>
          本机执行器：{executor?.running ? (executor?.busy ? '执行中' : '待命中') : '已停止'}
        </span>
        {executor?.lastRun && <span className="muted small">{executor.lastRun.ok ? '上次成功' : '上次失败'} {new Date(executor.lastRun.at).toLocaleTimeString()}</span>}
        <button className="ghost" disabled={busy} onClick={() => void refresh()}>刷新</button>
      </div>
    </header>
    {error && <div className="error office-alert">{error}</div>}
    {notice && <div className="office-notice">{notice}</div>}

    <section className="team-panel">
      <div className="office-section-head"><div><h3>获客成交团队</h3><p>线索发现 → 客户分层 → 销售跟进建议</p></div>
        <button className="primary office-button" disabled={busy || !teamMembers.length || teamMembers.every((e) => installedIds.has(e.slug))} onClick={() => void installTeam()}>
          {teamMembers.length && teamMembers.every((e) => installedIds.has(e.slug)) ? '团队已安装' : '安装团队'}
        </button>
      </div>
      <div className="employee-grid team-grid">
        {teamMembers.map((emp: any, index) => <article className="employee-card team-card" key={emp.id}>
          <div className="employee-icon">{emp.avatarEmoji || '🤖'}</div>
          <div className="employee-card-title"><b>{index + 1}. {emp.name}</b><span className={installedIds.has(emp.slug) ? 'pill active' : 'pill'}>{installedIds.has(emp.slug) ? '已安装' : '未安装'}</span></div>
          <p>{emp.title || emp.description}</p>
        </article>)}
        {!teamMembers.length && <div className="muted">团队员工目录加载中…</div>}
      </div>
    </section>

    <section className="office-block">
      <div className="office-section-head"><div><h3>员工目录 <small>{catalog.length} 位</small></h3><p>安装后即可提交任务</p></div>
        <input className="office-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索员工" />
      </div>
      <div className="employee-grid">
        {filtered.map((emp: any) => <article className="employee-card" key={emp.id}>
          <div className="employee-icon">{emp.avatarEmoji || '🤖'}</div>
          <div className="employee-card-title"><b>{emp.name}</b><span className={installedIds.has(emp.slug) ? 'pill active' : 'pill'}>{installedIds.has(emp.slug) ? '已安装' : '未安装'}</span></div>
          <div className="employee-role">{emp.title || emp.category || 'AI 员工'}</div>
          <p>{emp.description || '为你的工作流程提供协助'}</p>
          <div className="employee-actions">
            {installedIds.has(emp.slug)
              ? <button className="ghost" disabled={busy} onClick={() => void act(() => window.fcm.employees.uninstall(emp.slug), `${emp.name}已卸载`)}>卸载</button>
              : <button className="ghost" disabled={busy} onClick={() => void act(() => window.fcm.employees.install(emp.slug), `${emp.name}已安装`)}>安装员工</button>}
            {installedIds.has(emp.slug) && <button className="link" onClick={() => { setSelected(emp.slug); document.getElementById('employee-task-form')?.scrollIntoView({ behavior: 'smooth' }) }}>创建任务 →</button>}
          </div>
        </article>)}
        {!filtered.length && <div className="empty-state">没有匹配的员工</div>}
      </div>
    </section>

    <section className="office-block" id="employee-task-form">
      <div className="office-section-head"><div><h3>发起任务</h3><p>提交后任务状态由执行端更新；当前页面展示服务端记录和产物</p></div></div>
      <form className="task-form" onSubmit={runTask}>
        <label>执行员工<select value={selected} onChange={(e) => setSelected(e.target.value)} required>
          <option value="">请选择已安装员工</option>
          {installed.filter((e) => e.install?.effectiveEnabled).map((e) => <option key={e.id} value={e.slug}>{e.name}</option>)}
        </select></label>
        <label>任务名称<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：分析本周新增线索" /></label>
        <label>任务说明<textarea value={input} onChange={(e) => setInput(e.target.value)} placeholder="描述目标、背景资料和期望输出" rows={3} required /></label>
        <div className="attach-row">
          <button type="button" className="ghost" disabled={busy} onClick={() => void pickFiles()}>添加资料（Excel / Word / PDF / 文本 / 图片）</button>
          <span className="muted small">单份 ≤ 20MB；员工会用 doc_read / file_read 读取内容</span>
        </div>
        {!!attachments.length && <div className="attach-list">
          {attachments.map((f) => <span className="attach-chip" key={f.key}>
            📎 {f.name}
            <button type="button" className="link" onClick={() => setAttachments((current) => current.filter((x) => x.key !== f.key))}>移除</button>
          </span>)}
        </div>}
        <button className="primary office-button" disabled={busy || !selected || !input.trim()}>提交任务</button>
      </form>
    </section>

    <section className="office-block">
      <div className="office-section-head"><div><h3>我的资料库 <small>{library.length} 份</small></h3><p>上传后会保存在服务端工作区，员工在任务里按文件名读取；首次进入会自动放一份《企业基础资料.md》模板，填好后重新上传同名文件即可替换</p></div>
        <button className="ghost" disabled={busy} onClick={() => void refreshLibrary()}>刷新</button>
      </div>
      {!library.length && <div className="empty-state">还没有资料。点「添加资料」上传客户名单、产品价格表、竞品文档或 PDF；员工所有任务都会先读《企业基础资料.md》。</div>}
      {!!library.length && <div className="attach-list">
        {library.slice(0, 20).map((f: any) => <span className="attach-chip" key={f.key}>
          <button className="link" disabled={busy} onClick={() => void act(async () => { await window.fcm.workspace.download({ key: f.key, name: f.name }) })}>{f.name}</button>
          <span className="muted small">{Math.max(1, Math.round((f.bytes || 0) / 1024))}KB</span>
          <button className="link" disabled={busy} onClick={() => void removeLibraryFile(f)}>删除</button>
        </span>)}
      </div>}
    </section>

    <section className="office-block">
      <div className="office-section-head"><div><h3>任务与验收</h3><p>最近 {tasks.length} 条任务</p></div></div>
      {!tasks.length && <div className="empty-state">暂无任务。安装员工后可以发起第一项任务。</div>}
      <div className="task-list">{tasks.map((task: any) => {
        const emp = taskEmployee(task.employeeId)
        return <article className="task-card" key={task.id}>
          <div className="task-top"><div><b>{task.title}</b><div className="muted">{emp?.name || '员工'} · {task.createdAt ? new Date(task.createdAt).toLocaleString() : ''}</div></div>
            <span className={`pill status-${task.status}`}>{STATUS[task.status] || task.status}</span>
          </div>
          {task.outputText && <pre className="task-output">{task.outputText}</pre>}
          {task.error && <div className="task-error">{task.error}</div>}
          {!!task.artifacts?.length && <div className="artifact-list">{task.artifacts.map((a: any) => {
            const url = ['image', 'video'].includes(a.kind) ? mediaUrl(a.url || a.path) : ''
            return <div key={a.id || `${a.kind}-${a.url}-${a.path}`}>
              <b>{a.kind}</b> {a.kind === 'workspace-file' && typeof a.path === 'string' ? <button className="link" disabled={busy} onClick={() => void act(async () => { await window.fcm.workspace.download({ key: a.path, name: a.text || '文件' }) })}>下载 {a.text || '文件'}</button> : url ? <><a href={url} target="_blank" rel="noreferrer">打开产物</a><div>{a.kind === 'image' ? <img src={url} alt="员工生成的图片" style={{ maxWidth: '100%', maxHeight: 360 }} /> : <video controls src={url} style={{ maxWidth: '100%', maxHeight: 360 }} />}</div></> : a.text || a.url || a.path || '产物已生成'}
            </div>
          })}</div>}
          {task.status === 'awaiting_approval' && <div className="task-actions">
            <button className="primary office-button" disabled={busy} onClick={() => void act(() => window.fcm.employeeTasks.approve({ id: task.id }), '已通过验收')}>通过验收</button>
            <button className="ghost" disabled={busy} onClick={() => { const reason = window.prompt('请填写驳回原因') || ''; if (reason.trim()) void act(() => window.fcm.employeeTasks.reject({ id: task.id, reason: reason.trim() }), '已驳回任务') }}>驳回</button>
          </div>}
        </article>
      })}</div>
    </section>
  </div>
}
