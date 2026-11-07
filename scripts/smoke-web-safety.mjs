import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const { handler } = require('./dist/capabilities/capabilities/web-extract.js');
for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/', 'http://10.0.0.1/', 'http://[::1]/', 'http://2130706433/']) {
  await assert.rejects(handler({ params: { url } }), /禁止访问/);
}
console.log('PASS web extraction blocks private, metadata and encoded loopback addresses');
