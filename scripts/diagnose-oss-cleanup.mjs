// Only an explicitly identified object created by the diagnostic may be checked/deleted.
import { createRequire } from 'node:module';
import { loadServerEnv } from './_env.mjs';
loadServerEnv();
const key = process.argv[2] || '';
if (!/^media\/diagnostics\/codex-[a-f0-9-]{36}\.txt$/.test(key)) throw new Error('invalid diagnostic object key');
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const OSS = require('ali-oss');
const client = new OSS({ region: process.env.OSS_REGION, accessKeyId: process.env.OSS_ACCESS_KEY_ID, accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET, bucket: process.env.OSS_BUCKET, endpoint: process.env.OSS_ENDPOINT, secure: true, timeout: 15000 });
try { await client.head(key); await client.delete(key); console.log('Identified diagnostic object deleted'); }
catch (e) { if (e.status === 404) console.log('Identified diagnostic object does not exist'); else { console.log('Unable to verify diagnostic object:', e.code || e.name); process.exitCode = 1; } }
