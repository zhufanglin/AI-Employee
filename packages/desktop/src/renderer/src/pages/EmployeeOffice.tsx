import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'

const TEAM = ['boss-lead-radar', 'boss-private-lead-manager', 'boss-sales-followup']
const STATUS: Record<string, string> = {
  queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败',
  needs_input: '等待补充信息', awaiting_approval: '待验收'
}

/** 员工开工前必读的企业资料文件名（服务端 ensureWorkspaceSeed 会播种同名模板） */
const PROFILE_FILE = '企业基础资料.md'

/**
 * 企业资料里需要用户亲手填的 6 项。
 * sections 是模板里对应的小节标题关键词；fields 是小节里的条目标签（「- 主营产品或服务：」这种），
 * 因为模板里很多关键词只出现在条目行、不出现在 Markdown 标题里，判定必须两边都看；hint 说明「该填什么」。
 */
type ProfileSpec = { key: string; label: string; hint: string; sections: string[]; fields: string[] }
const PROFILE_SPECS: ProfileSpec[] = [
  {
    key: 'brand', label: '公司/品牌名', hint: '企业或品牌的对外名称，例如「杭州某某科技有限公司」',
    sections: ['品牌介绍', '企业/品牌名称'], fields: ['企业/品牌名称', '品牌名称', '公司名称']
  },
  {
    key: 'business', label: '主营业务', hint: '主营产品或服务，以及价格带、利润来源',
    sections: ['企业与产品'], fields: ['主营产品或服务', '所在行业', '核心价格带', '主要利润来源']
  },
  {
    key: 'customer', label: '目标客户', hint: '是 B2B 还是 B2C，客户身份、规模、最常见需求与顾虑',
    sections: ['目标客户'], fields: ['目标客户身份', '典型行业', '最常见需求', '主要决策人', '平均成交周期']
  },
  {
    key: 'advantage', label: '核心优势', hint: '客户为什么选你、有哪些已验证的案例和数据',
    sections: ['竞争与优势'], fields: ['客户为什么选择我们', '已验证案例与数据', '主要同行', '核心优势']
  },
  {
    key: 'script', label: '话术口径', hint: '跟进频率、可接受的优惠边界、不能承诺的话术',
    sections: ['销售与私域', '话术口径'], fields: ['可接受的优惠边界', '销售跟进频率', '线索阶段定义', '话术口径']
  },
  {
    key: 'output', label: '输出偏好', hint: '语气、输出语言、每次默认给几个方案',
    sections: ['输出偏好'], fields: ['语气', '输出语言', '每次默认给几个方案']
  }
]

/** 小节正文里出现这些占位符、或冒号后面只有这些字，都算没填 */
const PROFILE_PLACEHOLDER = /^(（请填写）|\(请填写\)|请填写|待填写|待补充|待完善|TODO|todo|TBD)$/
/** 只有大片空行的小节正文超过这个字符数，按「没填」处理（模板小节本身就比较长） */
const EMPTY_SECTION_CHARS = 200
/** Markdown 标题行：## 企业与产品 / ### 目标客户 … */
const PROFILE_HEADING = /^\s{0,3}(#{1,6})\s*(.+?)\s*$/

/** 取某个小节（标题包含 keyword）的正文；找不到该小节返回 null */
function profileSectionBody(text: string, keyword: string): string | null {
  const lines = text.split(/\r?\n/)
  let start = -1
  let level = 0
  for (let i = 0; i < lines.length; i += 1) {
    const matched = PROFILE_HEADING.exec(lines[i])
    if (!matched) continue
    const current = matched[1].length
    if (start < 0) {
      if (matched[2].replace(/[\s*#]/g, '').includes(keyword)) { start = i + 1; level = current }
    } else if (current <= level) {
      return lines.slice(start, i).join('\n')
    }
  }
  return start >= 0 ? lines.slice(start).join('\n') : null
}

/** 把一行整理成「用户真正写下的内容」：去掉条目符号、占位符和只有键名没有值的写法 */
function profileLineValue(raw: string): string {
  const line = raw.trim().replace(/^[-*+]\s*/, '').trim()
  if (!line) return ''
  if (PROFILE_PLACEHOLDER.test(line)) return ''
  const colon = Math.max(line.indexOf('：'), line.indexOf(':'))
  if (colon >= 0) {
    const value = line.slice(colon + 1).trim()
    if (!value || PROFILE_PLACEHOLDER.test(value)) return ''
    return value
  }
  return line
}

/** 某一项是否已填：没有对应小节 / 还有「（请填写）」占位 / 去掉空行后不足 2 个字，都算没填 */
function profileSectionFilled(body: string | null): boolean {
  if (!body) return false
  const content = body.split(/\r?\n/).map(profileLineValue).join('').replace(/[\s\u3000]/g, '')
  if (body.length > EMPTY_SECTION_CHARS && !content) return false
  return content.length >= 2
}

/** 某个条目（例如「- 主营产品或服务：」）冒号后面是否写了内容；只写了占位符或括号里的提示都算没填 */
function profileFieldFilled(text: string, label: string): boolean {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*+]\s*/, '').replace(/\*\*/g, '')
    const index = line.indexOf(label)
    if (index < 0) continue
    const tail = line.slice(index + label.length)
    const colon = Math.max(tail.indexOf('：'), tail.indexOf(':'))
    const value = (colon >= 0 ? tail.slice(colon + 1) : tail).trim()
    if (!value || PROFILE_PLACEHOLDER.test(value)) continue
    if (!value.replace(/[*\s]/g, '')) continue
    return true
  }
  return false
}

/**
 * 单项是否已填：先看模板条目有没有写内容；
 * 用户把整段改写成自由文本时（小节里一个条目标签都不剩），再按小节正文兜底。
 */
function profileSpecFilled(text: string, spec: ProfileSpec): boolean {
  if (spec.fields.some((label) => profileFieldFilled(text, label))) return true
  const body = spec.sections.map((keyword) => profileSectionBody(text, keyword)).find((item) => item !== null) ?? null
  if (!body) return false
  if (spec.fields.some((label) => body.includes(label))) return false
  return profileSectionFilled(body)
}

/** 按 6 项把资料正文判一遍 */
function judgeProfile(text: string) {
  const filled = PROFILE_SPECS.map((spec) => profileSpecFilled(text, spec))
  const done = filled.filter(Boolean).length
  return { filled, done, total: PROFILE_SPECS.length, missing: PROFILE_SPECS.filter((_, index) => !filled[index]) }
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
  const [profileText, setProfileText] = useState<string | null>(null)
  const [profilePath, setProfilePath] = useState('')
  const [profileOpen, setProfileOpen] = useState(true)

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

  // 企业资料完整度：优先读客户端工作区里的同名文件（files:* 只在本地工作区目录内可读）；
  // 读不到内容时卡片降级成「该填什么」的引导，不谎报进度。
  const refreshProfile = useCallback(async () => {
    const files = (window as any).fcm?.files
    if (!files?.list) { setProfileText(null); setProfilePath(''); return }
    try {
      const listed = await files.list({})
      if (!listed?.ok) return
      const hit = (listed.items || []).find((item: any) => !item.isDir && item.name === PROFILE_FILE)
      if (!hit?.path) { setProfileText(null); setProfilePath(''); return }
      setProfilePath(String(hit.path))
      const read = await files.read({ path: hit.path, maxBytes: 200000 })
      setProfileText(read?.ok ? String(read.text || '') : null)
    } catch { /* 本地工作区不可用时静默降级 */ }
  }, [])

  const refresh = useCallback(async () => {
    setError('')
    try {
      const [c, m, t] = await Promise.all([
        window.fcm.employees.catalog(), window.fcm.employees.mine(), window.fcm.employeeTasks.list('?limit=50')
      ])
      void refreshLibrary()
      void refreshProfile()
      const employees = c.items || []
      const mine = m.items || []
      setCatalog(employees)
      setInstalled(mine)
      setTasks(t.items || [])
      setSelected((current) => mine.some((item: any) => item.slug === current && item.install?.effectiveEnabled)
        ? current
        : mine.find((item: any) => item.install?.effectiveEnabled)?.slug || '')
    } catch (e: any) { setError(e?.message || '加载员工数据失败') }
  }, [refreshLibrary, refreshProfile])

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
  // 资料完整度：有正文才判 6 项；读不到正文时保持 null，卡片按引导态展示
  const profileJudge = useMemo(() => (profileText ? judgeProfile(profileText) : null), [profileText])
  const profileInWorkspace = library.some((file: any) => file?.name === PROFILE_FILE)

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

  /** 一键打开本地资料文件用系统默认编辑器修改 */
  async function openProfileFile() {
    const files = (window as any).fcm?.files
    if (!files?.open || !profilePath) return
    setError('')
    try {
      const result = await files.open({ path: profilePath })
      if (result?.error) setError(String(result.error))
      else setNotice('已用系统默认编辑器打开《企业基础资料.md》，改完保存即可')
    } catch (e: any) { setError(e?.message || '打开文件失败') }
  }

  /** 复制资料文件路径：本地副本给绝对路径，只有服务端副本时给工作区内的相对位置 */
  async function copyProfilePath() {
    const text = profilePath || '工作区/' + PROFILE_FILE
    try {
      await navigator.clipboard.writeText(text)
      setError('')
      setNotice('已复制路径：' + text)
    } catch { setError('复制失败，请手动记录路径：' + text) }
  }

  /** 下载服务端工作区里的资料文件，填好后重新上传同名文件即可替换 */
  async function downloadProfileFile() {
    const file = library.find((item: any) => item?.name === PROFILE_FILE)
    if (!file) { setError('工作区里还没有《企业基础资料.md》，请先点「上传填好的同名文件」放一份进来'); return }
    await act(async () => {
      await (window as any).fcm.workspace.download({ key: file.key, name: file.name })
      void refreshProfile()
    }, '已下载《企业基础资料.md》，把 6 项填好后上传同名文件即可替换')
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

    {/* P46 企业资料完整度：员工开工前会先读这份资料，先让用户知道该填什么 */}
    {profileJudge && profileJudge.done === profileJudge.total
      ? <section className="office-block profile-card profile-card-done">
          <p className="profile-done">资料已完整，员工产出会贴合你的业务</p>
        </section>
      : <section className="office-block profile-card">
          <div className="profile-card-head">
            <div>
              <h3>企业资料完整度</h3>
              <p className="muted small">员工每次开工前都会先读《企业基础资料.md》；填得越全，产出越贴合你的业务。</p>
            </div>
            <button className="ghost" onClick={() => setProfileOpen((value) => !value)}>{profileOpen ? '收起' : '展开'}</button>
          </div>
          <div className="profile-progress">
            <span className="profile-progress-text">{profileJudge ? <>已填 {profileJudge.done}/{PROFILE_SPECS.length}</> : '未读到资料内容'}</span>
            <span className="profile-progress-bar"><i style={{ width: `${profileJudge ? Math.round((profileJudge.done / PROFILE_SPECS.length) * 100) : 0}%` }} /></span>
          </div>
          {profileOpen && <>
            <div className="profile-field-list">
              {PROFILE_SPECS.map((spec, index) => {
                const filled = !!(profileJudge && profileJudge.filled[index])
                return <div className={filled ? 'profile-field filled' : 'profile-field'} key={spec.key}>
                  <b>{filled ? '已填' : '待填'} · {spec.label}</b>
                  <span className="muted small">{filled ? '已填写' : spec.hint}</span>
                </div>
              })}
            </div>
            <p className="profile-missing">还缺这些：{(profileJudge ? profileJudge.missing : PROFILE_SPECS).map((spec) => spec.label).join('、')}</p>
            <p className="profile-hint">{profileText ? '资料已读到，按上面 6 项补齐即可。' : profileInWorkspace ? '工作区里已有这份文件，但当前版本读不到它的内容：请下载后核对 6 项是否填全，填好再上传同名文件覆盖。' : '还没有《企业基础资料.md》：先上传一份填好的（或下载模板填写），否则员工只能按通用模板写。'}</p>
            <div className="profile-actions">
              {!!profilePath && <button className="primary office-button" disabled={busy} onClick={() => void openProfileFile()}>一键打开资料文件编辑</button>}
              {profileInWorkspace && <button className="ghost" disabled={busy} onClick={() => void downloadProfileFile()}>下载《企业基础资料.md》</button>}
              <button className="ghost" disabled={busy} onClick={() => void pickFiles()}>上传填好的同名文件</button>
              <button className="link" onClick={() => void copyProfilePath()}>复制路径</button>
            </div>
            <p className="muted small">路径：{profilePath || '工作区/' + PROFILE_FILE}</p>
          </>}
        </section>}

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
          {task.status === 'queued' && <p className="queue-hint">
            {typeof task.queuePosition === 'number' && task.queuePosition > 1
              ? `排队中，前面还有 ${task.queuePosition - 1} 个任务`
              : '排队中，前面没有别的任务，马上开始'}
          </p>}
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
