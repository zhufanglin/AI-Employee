// Read-only inspection of disposable diagnostics objects.
import { createRequire } from 'node:module';
import { loadServerEnv } from './_env.mjs';
loadServerEnv();
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const OSS = require('ali-oss');
const client = new OSS({ region: process.env.OSS_REGION, accessKeyId: process.env.OSS_ACCESS_KEY_ID, accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET, bucket: process.env.OSS_BUCKET, endpoint: process.env.OSS_ENDPOINT, secure: true, timeout: 15000 });
try {
  const r = await client.list({ prefix: 'media/diagnostics/codex-', 'max-keys': 1000 });
  console.log(JSON.stringify((r.objects || []).map(x => ({ name: x.name, size: x.size, lastModified: x.lastModified })), null, 2));
} catch (e) { console.log('Diagnostic listing failed:', e.code || e.name, 'status:', e.status || 'none'); process.exitCode = 1; }
