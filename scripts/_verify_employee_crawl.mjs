const API = 'http://127.0.0.1:3000/api';
const j = async (p, i = {}) => { const r = await fetch(API + p, { ...i, headers: { 'content-type': 'application/json', ...(i.headers || {}) } }); const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; } return { status: r.status, body: b }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const phone = '13900000002';
let token = '';
for (let attempt = 1; attempt <= 6; attempt++) {
  const s = await j('/auth/sms/send', { method: 'POST', body: JSON.stringify({ phone }) });
  const code = s.body?.devCode;
  if (code) {
    const l = await j('/auth/sms/login', { method: 'POST', body: JSON.stringify({ phone, code }) });
    token = l.body?.accessToken || l.body?.token || '';
    if (token) break;
  }
  console.log('login retry', attempt, s.status, JSON.stringify(s.body).slice(0, 120));
  await sleep(70000);
}
if (!token) { console.log('LOGIN_FAILED'); process.exit(1); }
const H = { authorization: 'Bearer ' + token };
const run = await j('/employees/boss-daily-lead-topics/run', { method: 'POST', headers: H, body: JSON.stringify({ title: '守卫修复后复验：抓取参考页再出选题', input: { text: '先用工具抓取 https://example.com 的内容作为参考，再给本地口腔诊所出 3 条获客选题。' } }) });
console.log('run', run.status, run.body?.id || JSON.stringify(run.body).slice(0, 200));
const id = run.body?.id;
let last = null;
for (let i = 0; i < 60; i++) {
  await sleep(5000);
  const t = await j('/employee-tasks/' + id, { headers: H });
  last = t.body;
  if (['awaiting_approval', 'succeeded', 'failed', 'rejected'].includes(last?.status)) break;
}
const meta = last?.outputMeta || {};
console.log('STATUS', last?.status, 'executor', last?.executor, 'node', meta.node, 'model', meta.model);
console.log('STEPS', JSON.stringify(meta.steps || []));
console.log('ERROR', last?.error || 'none');
console.log('OUTPUT_HEAD', String(last?.outputText || '').slice(0, 300));
