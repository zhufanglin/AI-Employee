// Explicitly opted-in, tiny disposable OSS write/read/delete probe.
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { loadServerEnv } from './_env.mjs';
loadServerEnv();
if (process.env.FCM_OSS_WRITE_PROBE !== '1') throw new Error('Explicit test opt-in required');
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const OSS = require('ali-oss');
const client = new OSS({ region: process.env.OSS_REGION, accessKeyId: process.env.OSS_ACCESS_KEY_ID, accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET, bucket: process.env.OSS_BUCKET, endpoint: process.env.OSS_ENDPOINT, secure: true, timeout: 30000 });
const key = 'media/diagnostics/codex-' + randomUUID() + '.txt';
const requestedBytes = Number(process.env.FCM_OSS_TEST_BYTES || 0);
if (requestedBytes && (!Number.isSafeInteger(requestedBytes) || requestedBytes < 1 || requestedBytes > 4 * 1024 * 1024)) throw new Error('invalid probe size');
const data = process.env.FCM_OSS_TEST_IMAGE === '1'
  ? await readFile(fileURLToPath(new URL('../packages/server/uploads/media/2118417550782320642.jpg', import.meta.url)))
  : requestedBytes ? Buffer.alloc(requestedBytes, 0x51) : Buffer.from('isolated oss integration diagnostic');
console.log('Disposable probe object:', key);
let created = false;
try {
  let put;
  if (process.env.FCM_OSS_STREAM === '1') {
    async function* pieces() {
      for (let i = 0; i < data.length; i += 1024) {
        yield data.subarray(i, i + 1024);
        await new Promise(resolve => setTimeout(resolve, 2));
      }
    }
    put = await client.putStream(key, Readable.from(pieces()), { contentLength: data.length, headers: { 'Content-Type': 'text/plain' } });
  } else put = await client.put(key, data, { headers: { 'Content-Type': 'text/plain' } });
  created = true;
  const read = await client.get(key);
  const hash = b => createHash('sha256').update(b).digest('hex');
  if (hash(read.content) !== hash(data)) throw new Error('downloaded data does not match');
  console.log('OSS write/read verified; bytes:', data.length, 'HTTP statuses:', put.res?.status, read.res?.status);
} catch (e) { console.log('OSS write/read failed:', e.code || e.name, 'status:', e.status || 'none'); process.exitCode = 1; }
finally {
  if (!created) {
    try { await client.head(key); created = true; console.log('Object exists despite ambiguous write response'); }
    catch (e) { if (e.status !== 404) console.log('Unable to confirm cleanup need:', e.code || e.name); }
  }
  if (created) {
    try { await client.delete(key); console.log('Disposable object deleted'); }
    catch (e) { console.log('Disposable object cleanup failed:', e.code || e.name, 'object:', key); process.exitCode = 1; }
  }
}
