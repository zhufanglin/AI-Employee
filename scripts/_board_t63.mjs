import { readFileSync, writeFileSync } from 'node:fs'
const p = 'docs/handoff/state.json'
const raw = readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
const st = JSON.parse(raw)
st.tasks = st.tasks || []
let t = st.tasks.find((x) => x.id === 'T-63')
if (!t) {
  t = {
    id: 'T-63',
    title: 'P37 修「点平台发布弹出视频号助手」（0 透明度渲染）+ 抖音冷启动误报「打开页面失败」+ 0.1.21',
    status: 'in_progress',
    owner: 'dsh-lead',
    scope: ['packages/desktop/src/main/platform.ts', 'scripts/check-desktop-p24.mjs', 'scripts/check-desktop-p25.mjs', 'docs/handoff/P37-平台页弹窗与冷启动误报.md'],
    checkpoint: { at: new Date().toISOString(), notes: ['showForRender(0 透明度)', 'ERR_ABORTED movedOn', 'navigate 失败继续 probe（15 轮）'] }
  }
  st.tasks.push(t)
  console.log('CREATED T-63')
} else {
  t.checkpoint = t.checkpoint || { notes: [] }
  t.checkpoint.notes = [...(t.checkpoint.notes || []), 'refresh ' + new Date().toISOString()].slice(-5)
  console.log('UPDATED T-63')
}
writeFileSync(p, JSON.stringify(st, null, 2) + '\n', 'utf8')
console.log('TOTAL', st.tasks.length)