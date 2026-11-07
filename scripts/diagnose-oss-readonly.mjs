// Read-only OSS connectivity diagnostic; never prints credentials.
import { createRequire } from 'node:module';
import { lookup } from 'node:dns/promises';
import { loadServerEnv } from './_env.mjs';
loadServerEnv();
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const OSS = require('ali-oss');
const keys = ['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_BUCKET', 'OSS_REGION', 'OSS_ENDPOINT'];
const present = Object.fromEntries(keys.map(k => [k, Boolean(process.env[k])]));
console.log('configured:', JSON.stringify(present));
if (Object.values(present).some(x => !x)) process.exit(2);
const endpoint = process.env.OSS_ENDPOINT.replace(/^https?:\/\//, '').replace(/\/$/, '');
try {
  const addresses = await lookup(endpoint, { all: true });
  console.log('endpoint DNS:', JSON.stringify(addresses.map(a => ({ family: a.family, fakeIp: /^198\.(18|19)\./.test(a.address), private: /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address) }))));
} catch (e) { console.log('endpoint DNS failed:', e.code || e.name); }
try {
  const host = process.env.OSS_BUCKET + '.' + endpoint;
  const url = new URL('https://dns.alidns.com/resolve');
  url.searchParams.set('name', host); url.searchParams.set('type', 'A');
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const body = await r.json();
  console.log('AliDNS HTTPS resolution:', r.status, 'A records:', (body.Answer || []).filter(x => x.type === 1).length);
} catch (e) { console.log('AliDNS HTTPS resolution failed:', e.code || e.name); }
const client = new OSS({ region: process.env.OSS_REGION, accessKeyId: process.env.OSS_ACCESS_KEY_ID, accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET, bucket: process.env.OSS_BUCKET, endpoint: process.env.OSS_ENDPOINT, secure: true, timeout: 15000 });
try {
  const result = await client.head('media/auto/2118407399031529474.jpg');
  console.log('known object HEAD:', result.res?.status || 'success');
} catch (e) { console.log('known object HEAD failed:', e.code || e.name, 'status:', e.status || 'none'); process.exitCode = 1; }
try {
  const result = await client.getBucketInfo();
  const owner = String(result?.bucket?.Owner?.ID || result?.bucket?.owner?.id || result?.bucket?.owner?.ID || '');
  console.log('bucket owner read:', owner ? 'UID ends ' + owner.slice(-4) : 'owner identifier not returned');
} catch (e) { console.log('bucket owner read failed:', e.code || e.name, 'status:', e.status || 'none'); }
