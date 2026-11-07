import { readFileSync, writeFileSync } from 'node:fs';
const p = 'docs/handoff/state.json';
const s = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const t = s.tasks.find((x) => x.id === 'T-36');
if (!t) { console.log('T-36 not found'); process.exit(1); }
t.owner = 'codex';
t.assignedBy = 'dsh-lead';
t.status = 'todo';
if (!Array.isArray(s.readFirst)) s.readFirst = [];
if (!s.readFirst.includes('docs/handoff/T36-T37-技能注入-任务书.md')) s.readFirst.push('docs/handoff/T36-T37-技能注入-任务书.md');
writeFileSync(p, JSON.stringify(s, null, 2) + '\n', 'utf8');
console.log('T-36 owner=codex ok');
