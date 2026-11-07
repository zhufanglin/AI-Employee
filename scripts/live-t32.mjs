// Explicitly opted-in live provider acceptance; local API only.
import { createRequire } from 'node:module';
import { loadServerEnv } from './_env.mjs';
import { runToolLoop } from '../packages/worker/tool-loop.mjs';
loadServerEnv();
if (process.env.FCM_LIVE_T32 !== '1') throw new Error('Set FCM_LIVE_T32=1 to run a paid live acceptance.');
const base = process.env.FCM_API || 'http://127.0.0.1:3000/api';
if (!/^http:\/\/127\.0\.0\.1:3000\/api\/?$/.test(base)) throw new Error('Live acceptance requires the isolated local API.');
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
let token = '', task, timer;
async function api(path, init = {}) {
  const response = await fetch(base + path, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(String(body?.error?.message || body?.message || response.status));
  return body;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
try {
  const phone = '139' + String(Date.now()).slice(-8);
  const sent = await post('/auth/sms/send', { phone });
  if (!sent.devCode) throw new Error('Local development SMS mode is required');
  const login = await post('/auth/sms/login', { phone, code: sent.devCode });
  token = login.accessToken;
  await db.user.update({ where: { id: login.user.id }, data: { credits: 100 } });
  await post('/employees/boss-lead-radar/install', {});
  const created = await post('/employees/boss-lead-radar/run', { executor: 'desktop', title: 'T-32 真实验收：播报稿与配图', input: { text: '制作一段关于本地咖啡店新品的简短播报稿，先生成一张配图，再返回正文。' } });
  const pulled = await api('/employee-tasks/pull?limit=1');
  task = pulled.items.find(x => x.id === created.id);
  if (!task?.outputMeta?.claimToken) throw new Error('Could not claim live test task');
  const claimToken = task.outputMeta.claimToken;
  timer = setInterval(() => void post('/employee-execution/tasks/' + task.id + '/heartbeat', { claimToken }).catch(e => console.error('heartbeat:', e.message)), 30000);
  let imageSubmissions = 0;
  const result = await runToolLoop({
    api: async (path, init) => {
      if (path === '/media/images/generations' && ++imageSubmissions > 1) throw new Error('验收只允许生成一张图片，请勿自动重试');
      console.log('step', path.startsWith('/media/tasks/') ? '/media/tasks/:id' : path);
      return api(path, init);
    },
    model: 'doubao-seed-2.0-lite', maxSteps: 4, timeoutMs: 900000,
    messages: [{ role: 'user', content: '制作一段关于本地咖啡店新品的简短播报稿。必须先调用 image_gen 生成一张咖啡店新品海报，然后调用 finish 返回中文播报稿。' }]
  });
  const artifacts = [{ kind: 'text', text: result.content }, ...result.media.filter(m => m.url).map(m => ({ kind: m.kind, path: m.url }))];
  await api('/employee-tasks/' + task.id, { method: 'PATCH', body: JSON.stringify({ claimToken, status: 'awaiting_approval', outputText: result.content, outputMeta: { ...task.outputMeta, steps: result.steps, media: result.media, usage: result.usages }, artifacts }) });
  console.log(JSON.stringify({ taskId: task.id, content: result.content, media: result.media, steps: result.steps }, null, 2));
} catch (error) {
  if (task?.outputMeta?.claimToken) await api('/employee-tasks/' + task.id, { method: 'PATCH', body: JSON.stringify({ claimToken: task.outputMeta.claimToken, status: 'failed', error: String(error?.message || error), outputMeta: { ...task.outputMeta, ...(error?.partial || {}) } }) }).catch(() => {});
  console.error('Live acceptance failed:', error?.message || error);
  if (error?.partial) console.log(JSON.stringify({ partial: error.partial }));
  process.exitCode = 1;
} finally { if (timer) clearInterval(timer); await db.$disconnect(); }
