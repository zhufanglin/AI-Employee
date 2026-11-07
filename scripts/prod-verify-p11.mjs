// P11 production verification: capabilities list + file_write/file_read roundtrip + web_search error shape
const BASE = process.env.BASE || 'http://127.0.0.1:3000/api';
const PHONE = process.env.PHONE || '13900000002';
let fails = 0;
function check(ok, name, extra) { console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (extra ? ' :: ' + extra : '')); if (!ok) fails++; }
async function req(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
function jpost(path, obj, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  return req(path, { method: 'POST', headers, body: JSON.stringify(obj || {}) });
}
function jget(path, token) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  return req(path, { method: 'GET', headers });
}
async function login() {
  let sent = await jpost('/auth/sms/send', { phone: PHONE });
  if (!sent.body || !sent.body.devCode) {
    console.log('[info] devCode missing, waiting 62s for sms rate limit');
    await new Promise(r => setTimeout(r, 62000));
    sent = await jpost('/auth/sms/send', { phone: PHONE });
  }
  const code = sent.body && sent.body.devCode;
  if (!code) throw new Error('no devCode: ' + JSON.stringify(sent.body));
  const login = await jpost('/auth/sms/login', { phone: PHONE, code });
  const token = login.body && (login.body.accessToken || login.body.token || (login.body.data && login.body.data.accessToken));
  if (!token) throw new Error('no token: ' + JSON.stringify(login.body));
  return token;
}
(async () => {
  const token = await login();
  check(!!token, 'login ok');
  const caps = await jget('/capabilities', token);
  const arr = Array.isArray(caps.body) ? caps.body : (caps.body && (caps.body.capabilities || caps.body.items || (caps.body.data && caps.body.data.capabilities))) || [];
  const names = arr.map(x => x && x.name).filter(Boolean);
  console.log('[info] capabilities = ' + names.join(','));
  for (const n of ['web_extract', 'web_search', 'file_write', 'file_read', 'content_save', 'llm_text']) check(names.includes(n), 'capability present: ' + n, 'total=' + names.length);
  const content = '# P11 生产验收\n\n时间：' + new Date().toISOString() + '\n\n- web_search\n- file_write / file_read\n';
  const w = await jpost('/capabilities/run', { name: 'file_write', params: { name: 'p11-prod-check.md', content } }, token);
  const wd = w.body && w.body.success !== undefined ? w.body : (w.body || {});
  const key = (w.body && w.body.data && w.body.data.key) || (w.body && w.body.key);
  check(w.status === 200 || w.status === 201, 'file_write http', String(w.status));
  check(!!(w.body && w.body.success), 'file_write success', JSON.stringify(w.body).slice(0, 200));
  check(!!key && key.indexOf('workspace/') === 0, 'file_write key prefix', String(key));
  if (key) {
    const r = await jpost('/capabilities/run', { name: 'file_read', params: { key } }, token);
    const text = r.body && r.body.data && r.body.data.text;
    check(!!(r.body && r.body.success), 'file_read success');
    check(typeof text === 'string' && text.indexOf('P11 生产验收') >= 0, 'file_read content matches', String(text || '').slice(0, 60));
  }
  const s = await jpost('/capabilities/run', { name: 'web_search', params: { query: '中科元晟' } }, token);
  const smsg = JSON.stringify(s.body || '');
  const searchOk = !!(s.body && s.body.success);
  if (searchOk) check(true, 'web_search works', smsg.slice(0, 160));
  else check(smsg.indexOf('未配置搜索服务') >= 0 || smsg.indexOf('SEARCH') >= 0, 'web_search returns clear error when unconfigured', smsg.slice(0, 200));
  console.log(fails === 0 ? 'PROD P11 VERIFY OK' : 'PROD P11 VERIFY FAILED (' + fails + ')');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR', e && e.message); process.exit(2); });
