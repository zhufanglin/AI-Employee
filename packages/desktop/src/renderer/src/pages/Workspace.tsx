import { useEffect, useState } from 'react'

/**
 * P27 文件管理页：浏览 / 预览 / 新建 / 打开 / 删除工作区里的文件。
 *
 * 数据全部走 window.fcm.files（由 Lead 在 preload 暴露，对应主进程 file-ops.ts 的 files:* 通道）。
 * 页面不直接碰 node，预览内容只读；删除前必须二次确认。
 */

type FileItem = {
  name: string
  path: string
  isDir: boolean
  size: number
  mtime: number
}

type FilesApi = {
  list: (p?: { dir?: string }) => Promise<any>
  read: (p: { path: string; maxBytes?: number }) => Promise<any>
  write: (p: { path: string; text: string }) => Promise<any>
  remove: (p: { path: string }) => Promise<any>
  mkdir: (p: { path: string }) => Promise<any>
  open: (p: { path: string }) => Promise<any>
  reveal: (p: { path: string }) => Promise<any>
}

type Preview = { text: string; truncated: boolean }

/** 与主进程 file-ops.ts 的 ERR_BINARY 逐字一致 */
const BINARY_HINT = '这个文件不是文本文件，请用「打开」交给系统程序'

function filesApi(): FilesApi | null {
  const api = (window.fcm as unknown as { files?: FilesApi } | undefined)?.files
  return api && typeof api.list === 'function' ? api : null
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 从主进程返回的绝对路径里推断分隔符，保证拼出来的路径和 files:list 返回的一致 */
function sepOf(path: string): string {
  return path.includes('\\') ? '\\' : '/'
}

function joinPath(base: string, ...parts: string[]): string {
  const sep = sepOf(base)
  return base.replace(/[\\/]+$/, '') + sep + parts.join(sep)
}

/** 工作区根到当前目录的相对段；不在此根下时返回空（面包屑只显示「工作区」） */
function relativeSegments(root: string, dir: string): string[] {
  if (!root || !dir) return []
  const norm = (s: string) => s.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  const r = norm(root)
  const d = norm(dir)
  if (d === r) return []
  if (!d.startsWith(r + '/')) return []
  return d.slice(r.length + 1).split('/').filter(Boolean)
}

function formatSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '—'
  if (size < 1024) return size + ' B'
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
  return (size / 1024 / 1024).toFixed(1) + ' MB'
}

function formatTime(mtime: number): string {
  if (!mtime) return '—'
  return new Date(mtime).toLocaleString('zh-CN', { hour12: false })
}

const WORKSPACE_CSS = `
.workspace-bar { display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.workspace-crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; min-width: 0; }
.workspace-crumbs button { background: transparent; color: var(--brand-2); padding: 3px 5px; font-size: 13px; border-radius: 6px; overflow-wrap: anywhere; text-align: left; }
.workspace-crumbs button:hover { background: var(--bg-3); }
.workspace-crumbs button:disabled { color: var(--text); cursor: default; }
.workspace-crumb-sep { color: var(--muted); margin: 0 1px; }
.workspace-create { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.workspace-create input { width: 180px; padding: 8px 10px; }
.workspace-create .ghost { padding: 8px 12px; font-size: 13px; }
.workspace-grid { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(280px, 1fr); gap: 14px; align-items: start; }
.workspace-list { padding: 8px 4px; min-height: 180px; max-height: calc(100vh - 260px); overflow: auto; }
.workspace-table-row { cursor: pointer; }
.workspace-table-row:hover td { background: rgba(79, 124, 255, .06); }
.workspace-table-row.on td { background: rgba(79, 124, 255, .14); }
.workspace-name { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.workspace-name span:last-child { overflow-wrap: anywhere; }
.workspace-preview { display: flex; flex-direction: column; gap: 10px; max-height: calc(100vh - 260px); overflow: auto; }
.workspace-preview-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.workspace-preview-title { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.workspace-preview-head .muted.small { margin-top: 4px; }
.workspace-preview-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 12px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.65; color: #c3cad8; max-height: calc(100vh - 470px); min-height: 120px; overflow: auto; }
.workspace-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.workspace-actions .ghost { padding: 6px 10px; font-size: 12px; }
.workspace-danger { color: #ff9d9d; }
.workspace-confirm { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.workspace-preview-empty { color: var(--muted); font-size: 13px; padding: 18px 4px; }
.workspace-preview-empty p { margin: 0 0 6px; }
`

export default function Workspace() {
  const [root, setRoot] = useState('')
  const [dir, setDir] = useState('')
  const [items, setItems] = useState<FileItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<FileItem | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState('')
  const [pendingDelete, setPendingDelete] = useState<FileItem | null>(null)

  async function load(path?: string) {
    const api = filesApi()
    if (!api) {
      setError('文件管理接口尚未接线（window.fcm.files 不存在），请联系管理员更新客户端')
      return
    }
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const r = await api.list(path ? { dir: path } : {})
      if (!r?.ok) {
        setError(String(r?.error || '读取文件夹失败'))
        return
      }
      setRoot((prev) => prev || String(r.dir || ''))
      setDir(String(r.dir || ''))
      setItems(Array.isArray(r.items) ? (r.items as FileItem[]) : [])
      setSelected(null)
      setPreview(null)
      setPreviewError('')
      setPendingDelete(null)
    } catch (e) {
      setError(msgOf(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // 只在进页面时读一次；之后由导航/刷新按钮触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function selectItem(item: FileItem) {
    setSelected(item)
    setPreview(null)
    setPreviewError('')
    if (item.isDir) return
    const api = filesApi()
    if (!api) return
    setPreviewLoading(true)
    try {
      const r = await api.read({ path: item.path, maxBytes: 200000 })
      if (!r?.ok) {
        setPreviewError(String(r?.error || '读取文件失败'))
        return
      }
      setPreview({ text: String(r.text || ''), truncated: !!r.truncated })
    } catch (e) {
      setPreviewError(msgOf(e))
    } finally {
      setPreviewLoading(false)
    }
  }

  async function openItem(item: FileItem) {
    if (item.isDir) {
      await load(item.path)
      return
    }
    const api = filesApi()
    if (!api) return
    setError('')
    try {
      const r = await api.open({ path: item.path })
      if (r?.error) setError(String(r.error))
    } catch (e) {
      setError(msgOf(e))
    }
  }

  async function revealItem(item: FileItem) {
    const api = filesApi()
    if (!api) return
    setError('')
    try {
      const r = await api.reveal({ path: item.path })
      if (!r?.ok) setError(String(r?.error || '无法在文件夹中显示'))
    } catch (e) {
      setError(msgOf(e))
    }
  }

  async function doDelete(item: FileItem) {
    const api = filesApi()
    if (!api) return
    setBusy('delete')
    setError('')
    try {
      const r = await api.remove({ path: item.path })
      if (!r?.ok) {
        setError(String(r?.error || '删除失败'))
        return
      }
      await load(dir || undefined)
      setNotice('已删除「' + item.name + '」')
    } catch (e) {
      setError(msgOf(e))
    } finally {
      setBusy('')
    }
  }

  async function create(kind: 'dir' | 'file') {
    const name = newName.trim()
    if (!name) {
      setError(kind === 'dir' ? '请输入文件夹名称' : '请输入文件名')
      return
    }
    if (/[\\/]/.test(name)) {
      setError('名称不能包含路径分隔符')
      return
    }
    const api = filesApi()
    if (!api) {
      setError('文件管理接口尚未接线（window.fcm.files 不存在），请联系管理员更新客户端')
      return
    }
    const baseDir = dir || root
    if (!baseDir) return
    const target = joinPath(baseDir, name)
    setBusy(kind)
    setError('')
    try {
      const r = kind === 'dir' ? await api.mkdir({ path: target }) : await api.write({ path: target, text: '' })
      if (!r?.ok) {
        setError(String(r?.error || '新建失败'))
        return
      }
      setNewName('')
      await load(dir || undefined)
      setNotice(kind === 'dir' ? '已新建文件夹「' + name + '」' : '已新建文件「' + name + '」')
    } catch (e) {
      setError(msgOf(e))
    } finally {
      setBusy('')
    }
  }

  const segments = relativeSegments(root, dir)
  const crumbs: { label: string; path: string }[] = root
    ? [{ label: '工作区', path: root }, ...segments.map((s, i) => ({ label: s, path: joinPath(root, ...segments.slice(0, i + 1)) }))]
    : []

  return (
    <div className="page">
      <style>{WORKSPACE_CSS}</style>

      <div className="page-head">
        <div>
          <h2>📁 文件管理</h2>
          <p className="muted small">
            这里是你电脑上的工作区{root ? '（' + root + '）' : ''}。员工任务读写的资料也落在这个目录；预览为只读，删除前会再确认一次。
          </p>
        </div>
        <button className="ghost" disabled={loading} onClick={() => void load(dir || undefined)}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice ok">{notice}</p>}

      {pendingDelete && (
        <div className="notice err workspace-confirm">
          <span>
            确定删除「{pendingDelete.name}」？{pendingDelete.isDir ? '文件夹里的内容会一起删除，' : ''}删除后不可恢复。
          </span>
          <div className="workspace-actions">
            <button className="ghost workspace-danger" disabled={busy === 'delete'} onClick={() => void doDelete(pendingDelete)}>
              {busy === 'delete' ? '删除中…' : '确认删除'}
            </button>
            <button className="ghost" onClick={() => setPendingDelete(null)}>取消</button>
          </div>
        </div>
      )}

      <div className="workspace-bar">
        <div className="workspace-crumbs">
          {crumbs.map((c, i) => (
            <span key={c.path} className="workspace-crumb">
              {i > 0 && <span className="workspace-crumb-sep">/</span>}
              <button type="button" disabled={loading || c.path === dir} onClick={() => void load(c.path)}>{c.label}</button>
            </span>
          ))}
        </div>
        <div className="workspace-create">
          <input
            value={newName}
            placeholder="新文件夹 / 文件名"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void create('file') }}
          />
          <button className="ghost" disabled={!!busy} onClick={() => void create('dir')}>新建文件夹</button>
          <button className="ghost" disabled={!!busy} onClick={() => void create('file')}>新建文件</button>
        </div>
      </div>

      <div className="workspace-grid">
        <section className="card workspace-list">
          <table className="table">
            <thead>
              <tr><th>名称</th><th>大小</th><th>修改时间</th></tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.path}
                  className={'workspace-table-row' + (selected?.path === item.path ? ' on' : '')}
                  onClick={() => void selectItem(item)}
                  onDoubleClick={() => void openItem(item)}
                >
                  <td>
                    <span className="workspace-name"><span>{item.isDir ? '📁' : '📄'}</span><span>{item.name}</span></span>
                  </td>
                  <td className="muted">{item.isDir ? '—' : formatSize(item.size)}</td>
                  <td className="muted">{formatTime(item.mtime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!items.length && <p className="empty-state">{loading ? '读取中…' : '这个文件夹还是空的，可以新建文件或文件夹。'}</p>}
        </section>

        <aside className="card workspace-preview">
          {selected ? (
            <>
              <div className="workspace-preview-head">
                <div>
                  <h3 className="workspace-preview-title">{selected.isDir ? '📁' : '📄'} {selected.name}</h3>
                  <p className="muted small">
                    {selected.isDir ? '文件夹' : formatSize(selected.size)}
                    {selected.mtime ? ' · ' + formatTime(selected.mtime) : ''}
                  </p>
                </div>
                <div className="workspace-actions">
                  <button className="ghost" onClick={() => void openItem(selected)}>打开</button>
                  <button className="ghost" onClick={() => void revealItem(selected)}>在文件夹中显示</button>
                  <button className="ghost workspace-danger" onClick={() => setPendingDelete(selected)}>删除</button>
                </div>
              </div>

              {selected.isDir ? (
                <p className="muted small">这是一个文件夹；双击列表里的文件夹可以进入。</p>
              ) : previewLoading ? (
                <p className="muted small">读取中…</p>
              ) : previewError ? (
                <div className="notice err">
                  {previewError}
                  {previewError === BINARY_HINT && (
                    <div style={{ marginTop: 8 }}>
                      <button className="ghost" onClick={() => void openItem(selected)}>交给系统程序打开</button>
                    </div>
                  )}
                </div>
              ) : preview ? (
                <>
                  <pre className="workspace-preview-text">{preview.text || '（空文件）'}</pre>
                  {preview.truncated && <p className="hint">文件较大，只显示前 200KB。需要完整内容请用「打开」。</p>}
                </>
              ) : null}
            </>
          ) : (
            <div className="workspace-preview-empty">
              <p>从左侧点一个文件查看内容。</p>
              <p className="muted small">双击文件夹进入，双击文件用系统程序打开。</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
