import { readFileSync, writeFileSync } from 'node:fs'
const p = 'C:\\Users\\30290\\Desktop\\fcmediaagent-replica\\docs\\handoff\\state.json'
const raw = readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
const j = JSON.parse(raw)
if (!j.tasks.some((t) => t.id === 'T-62')) {
  const now = new Date().toISOString()
  j.tasks.push({
    id: 'T-62',
    title: 'P36 修 platform:status 报 Object has been destroyed（含抖音 cookie 误判）+ 0.1.20',
    status: 'in_progress',
    owner: 'dsh-lead',
    scope: [],
    accept: '',
    blockedBy: [],
    createdAt: now,
    history: [{ at: now, by: 'dsh-lead', what: 'claim' }],
    lease: { at: now, heartbeat: now, reason: null },
    checkpoint: {
      progress: [],
      notes: ['守卫 + IPC 兜底 + partitionOf 修复；真机 status 三平台返回正常（抖音 loggedIn=true）；verify GREEN；打包 0.1.20 中'],
      files: []
    }
  })
} else {
  const t = j.tasks.find((x) => x.id === 'T-62')
  t.checkpoint.notes.push('已发布 0.1.20 并校验 asar')
  t.checkpoint.notes = t.checkpoint.notes.slice(-5)
}
writeFileSync(p, JSON.stringify(j, null, 2), 'utf8')
console.log('board updated: tasks=' + j.tasks.length)
