// Exercises the actual cloud worker against local API with model/media mocked.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const base = process.env.FCM_API || 'http://127.0.0.1:3000/api';
if (!/^http:\/\/127\.0\.0\.1:3000\/api\/?$/.test(base)) throw new Error('worker smoke requires local API');
const req = async (path, init = {}) => {
  const r = await fetch(base + path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
  return { status: r.status, body: await r.json() };
};
const phone = '139' + String(Date.now()).slice(-8);
const sent = await req('/auth/sms/send', { method: 'POST', body: JSON.stringify({ phone }) });
const login = await req('/auth/sms/login', { method: 'POST', body: JSON.stringify({ phone, code: sent.body.devCode, consent: { version: "2026-11-12", crossBorder: true, source: "smoke" } }) });
const token = login.body.accessToken;
assert.ok(token);
const headers = { authorization: 'Bearer ' + token };
await req('/employees/boss-lead-radar/install', { method: 'POST', headers, body: '{}' });
const detail = await req('/employees/boss-lead-radar', { headers });
const expectedSkill = detail.body.skillMd?.trim().slice(0, 100);
assert.ok(expectedSkill, 'employee skill must be available for this test');
const created = await req('/employees/boss-lead-radar/run', { method: 'POST', headers, body: JSON.stringify({ executor: 'cloud', title: 'T-32 cloud worker 隔离测试', input: { text: '播报稿和配图' } }) });
assert.ok(created.body.id);
let modelCalls = 0, skillInjected = false;
const proxy = createServer(async (incoming, outgoing) => {
  try {
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
    const path = incoming.url.slice(4);
    let payload;
    if (path === '/compute/chat/completions') {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      skillInjected ||= body.messages?.some(message => message.role === 'system' && message.content?.includes(expectedSkill));
      payload = { choices: [{ message: { content: JSON.stringify(++modelCalls === 1 ? { tool: 'image_gen', params: { prompt: 'test' } } : { tool: 'finish', params: { text: '云端测试播报稿' } }) } }] };
    }
    else if (path === '/media/images/generations') payload = { taskId: 'mock-image', status: 'SUCCESS', estimatedAmount: 20, resultUrl: 'https://example.invalid/mock.png' };
    if (payload) { outgoing.writeHead(200, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify(payload)); return; }
    const response = await fetch(base + path, { method: incoming.method, headers: { 'content-type': 'application/json', ...(incoming.headers.authorization ? { authorization: incoming.headers.authorization } : {}) }, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    outgoing.writeHead(response.status, { 'content-type': 'application/json' }); outgoing.end(await response.text());
  } catch (error) { outgoing.writeHead(500); outgoing.end(JSON.stringify({ message: String(error?.message || error) })); }
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const worker = spawn(process.execPath, [fileURLToPath(new URL('../packages/worker/cloud-executor.mjs', import.meta.url))], { windowsHide: true, stdio: 'ignore', env: { ...process.env, FCM_API: `http://127.0.0.1:${proxy.address().port}/api`, FCM_TOKEN: token, FCM_DEVICE_ID: 't32-isolated-worker', FCM_POLL_MS: '250', FCM_MODEL: 'mock' } });
try {
  let task;
  for (let i = 0; i < 100; i++) {
    const result = await req('/employee-tasks?limit=20', { headers });
    task = result.body.items?.find(item => item.id === created.body.id);
    if (task?.status === 'awaiting_approval' || task?.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(task?.status, 'awaiting_approval', task?.error || 'worker did not complete');
  assert.ok(task.artifacts?.some(x => x.kind === 'image') && task.artifacts?.some(x => x.kind === 'text'));
  assert.equal(task.outputMeta?.steps?.length, 2);
  assert.ok(skillInjected, 'cloud worker must inject the employee skill into the model request');
  console.log('PASS actual cloud worker injects skill, executes two steps and persists text/image artifacts');
} finally { worker.kill(); await new Promise(resolve => proxy.close(resolve)); }
