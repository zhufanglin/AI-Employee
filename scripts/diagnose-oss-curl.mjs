// Compare curl and SDK without printing the signed URL or credentials.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadServerEnv } from './_env.mjs';
loadServerEnv();
if (process.env.FCM_OSS_WRITE_PROBE !== '1') throw new Error('Explicit test opt-in required');
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const OSS = require('ali-oss');
const client = new OSS({ region: process.env.OSS_REGION, accessKeyId: process.env.OSS_ACCESS_KEY_ID, accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET, bucket: process.env.OSS_BUCKET, endpoint: process.env.OSS_ENDPOINT, secure: true, timeout: 15000 });
const key = 'media/diagnostics/codex-' + randomUUID() + '.txt';
const source = fileURLToPath(new URL('../packages/server/uploads/media/2118417550782320642.jpg', import.meta.url));
const signed = client.signatureUrl(key, { method: 'PUT', expires: 120 });
console.log('Disposable probe object:', key);
try {
  const result = await new Promise((resolve, reject) => {
    const p = spawn('curl.exe', ['--config', '-', '--upload-file', source, '--silent', '--show-error', '--connect-timeout', '8', '--max-time', '30', '--output', 'NUL', '--write-out', '%{http_code}'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let code = '';
    p.stdout.on('data', chunk => code += chunk.toString());
    p.on('error', reject);
    p.on('close', status => resolve({ status, http: code }));
    p.stdin.end('url = "' + signed.replaceAll('"', '%22') + '"\n');
  });
  console.log('curl upload:', JSON.stringify(result));
  if (result.status !== 0 || result.http !== '200') process.exitCode = 1;
} finally {
  try { await client.head(key); await client.delete(key); console.log('Disposable object deleted'); }
  catch (e) { if (e.status === 404) console.log('Disposable object does not exist'); else { console.log('Cleanup could not be confirmed:', e.code || e.name); process.exitCode = 1; } }
}
