#!/usr/bin/env node
/** P11 工具第一批单测：web_search（Tavily/Bing 归一 + 未配置报错）与 file_write/file_read（往返/越权/非法名/超限）。 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-ws-'));
process.env.WORKSPACE_DIR = workspace;
process.env.WORKSPACE_MAX_BYTES = '2000000';
process.env.SEARCH_PROVIDER = '';
process.env.TAVILY_API_KEY = '';
process.env.BING_SEARCH_KEY = '';
process.env.PUBLIC_BASE_URL = 'https://api.example.com';
process.env.OSS_ACCESS_KEY_ID = '';
process.env.OSS_ACCESS_KEY_SECRET = '';
process.env.OSS_BUCKET = '';
process.env.OSS_REGION = '';
process.env.OSS_ENDPOINT = '';

const search = require('../packages/server/dist/capabilities/capabilities/search.js');
const files = require('../packages/server/dist/capabilities/capabilities/files.js');

let pass = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('[PASS] ' + name); }
  catch (error) { console.log('[FAIL] ' + name + ' :: ' + (error && error.message ? error.message : error)); process.exitCode = 1; }
}
async function checkAsync(name, fn) {
  try { await fn(); pass += 1; console.log('[PASS] ' + name); }
  catch (error) { console.log('[FAIL] ' + name + ' :: ' + (error && error.message ? error.message : error)); process.exitCode = 1; }
}
async function rejects(name, fn, needle) {
  try { await fn(); console.log('[FAIL] ' + name + ' :: 未抛错'); process.exitCode = 1; }
  catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (needle && !message.includes(needle)) { console.log('[FAIL] ' + name + ' :: 错误文案不含「' + needle + '」实际：' + message); process.exitCode = 1; }
    else { pass += 1; console.log('[PASS] ' + name); }
  }
}

function stubFetch(payload) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options: options || {} });
    return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
  };
  return calls;
}

(async () => {
  check('能力清单：web_search 与两个文件能力已定义', () => {
    assert.equal(search.descriptor.name, 'web_search');
    const names = files.descriptors.map((d) => d.name);
    assert.deepEqual(names, ['file_write', 'file_read']);
  });

  await rejects('未配置任何搜索 key 时明确报错（不静默空返回）', async () => {
    await search.handler({ userId: 'u1', phone: null, params: { query: '测试' } });
  }, '未配置搜索服务');

  await checkAsync('Tavily 结果归一（snippet 截断）', async () => {
    process.env.SEARCH_PROVIDER = 'tavily';
    process.env.TAVILY_API_KEY = 'tvly-test';
    const longText = 'x'.repeat(900);
    const calls = stubFetch({ results: [
      { title: 'A', url: 'https://a.example.com/1', content: longText, published_date: '2026-11-01' },
      { title: 'B', url: 'https://b.example.com/2', content: 'short' },
    ] });
    const data = await search.handler({ userId: 'u1', phone: null, params: { query: '社区团购' } });
    assert.equal(data.provider, 'tavily');
    assert.equal(data.total, 2);
    assert.equal(calls[0].url, 'https://api.tavily.com/search');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.query, '社区团购');
    assert.equal(body.api_key, 'tvly-test');
    assert.ok(data.items[0].snippet.length <= 403, 'snippet 需截断');
    assert.equal(data.items[0].published, '2026-11-01');
    assert.equal(data.items[1].snippet, 'short');
  });

  await checkAsync('Bing 结果归一', async () => {
    process.env.SEARCH_PROVIDER = 'bing';
    process.env.BING_SEARCH_KEY = 'bing-test';
    const calls = stubFetch({ webPages: { value: [
      { name: 'N1', url: 'https://n1.example.com', snippet: 'snip1', datePublished: '2026-10-30' },
    ] } });
    const data = await search.handler({ userId: 'u1', phone: null, params: { query: '跨境 选品', maxResults: 3 } });
    assert.equal(data.provider, 'bing');
    assert.equal(data.total, 1);
    assert.ok(calls[0].url.includes('api.bing.microsoft.com/v7.0/search'));
    assert.ok(calls[0].url.includes('count=3'));
    assert.equal(calls[0].options.headers['Ocp-Apim-Subscription-Key'], 'bing-test');
    assert.equal(data.items[0].snippet, 'snip1');
  });

  await rejects('query 为空被拒', async () => {
    await search.handler({ userId: 'u1', phone: null, params: {} });
  }, 'query 必填');

  let written = null;
  await checkAsync('file_write 落盘并返回 key/url', async () => {
    written = await files.handlers.file_write({ userId: 'u1', phone: null, params: { name: '选品清单.md', content: '# 清单\n- 抽纸' } });
    assert.ok(written.key.startsWith('workspace/u1/'), 'key 前缀');
    assert.equal(written.name, '选品清单.md');
    assert.ok(written.bytes > 0);
    assert.equal(written.url, 'https://api.example.com/uploads/' + written.key);
    assert.ok(fs.existsSync(path.join(workspace, 'u1', written.key.split('/').pop())), '本地文件应存在');
  });

  await checkAsync('file_read 往返一致', async () => {
    const data = await files.handlers.file_read({ userId: 'u1', phone: null, params: { key: written.key } });
    assert.equal(data.name, '选品清单.md');
    assert.equal(data.text, '# 清单\n- 抽纸');
    assert.equal(data.truncated, false);
  });

  await checkAsync('file_read 截断生效（maxChars 下限 500）', async () => {
    const big = await files.handlers.file_write({ userId: 'u1', phone: null, params: { name: '长文.txt', content: 'a'.repeat(900) } });
    const data = await files.handlers.file_read({ userId: 'u1', phone: null, params: { key: big.key, maxChars: 500 } });
    assert.equal(data.truncated, true);
    assert.equal(data.text.length, 500);
    const clamped = await files.handlers.file_read({ userId: 'u1', phone: null, params: { key: big.key, maxChars: 10 } });
    assert.equal(clamped.text.length, 500, 'maxChars 低于 500 时按 500 处理');
  });

  await rejects('跨用户读被拒', async () => {
    await files.handlers.file_read({ userId: 'u2', phone: null, params: { key: written.key } });
  }, '无权访问');

  await rejects('非法文件名 ../x.md 被拒', async () => {
    await files.handlers.file_write({ userId: 'u1', phone: null, params: { name: '../x.md', content: 'a' } });
  }, '路径分隔符');

  await rejects('非法文件名 a/b.md 被拒', async () => {
    await files.handlers.file_write({ userId: 'u1', phone: null, params: { name: 'a/b.md', content: 'a' } });
  }, '路径分隔符');

  await rejects('可执行扩展名被拒', async () => {
    await files.handlers.file_write({ userId: 'u1', phone: null, params: { name: 'evil.exe', content: 'a' } });
  }, '不支持的文件类型');

  await rejects('缺扩展名被拒', async () => {
    await files.handlers.file_write({ userId: 'u1', phone: null, params: { name: 'noext', content: 'a' } });
  }, '必须带扩展名');

  await checkAsync('超限被拒（WORKSPACE_MAX_BYTES=100）', async () => {
    process.env.WORKSPACE_MAX_BYTES = '100';
    try {
      await files.handlers.file_write({ userId: 'u1', phone: null, params: { name: 'big.txt', content: 'y'.repeat(500) } });
      assert.fail('应当抛错');
    } catch (error) {
      assert.ok(String(error.message).includes('KB'), '错误文案应含 KB：' + error.message);
    } finally {
      process.env.WORKSPACE_MAX_BYTES = '2000000';
    }
  });

  await rejects('读不存在的 key 报文件不存在', async () => {
    await files.handlers.file_read({ userId: 'u1', phone: null, params: { key: 'workspace/u1/00000000-0000-0000-0000-000000000000-nope.md' } });
  }, '文件不存在');

  console.log('');
  if (process.exitCode) { console.log('P11 TOOLS SMOKE FAILED (' + pass + ' checks passed)'); }
  else { console.log('P11 TOOLS SMOKE OK (' + pass + ' checks)'); }
  fs.rmSync(workspace, { recursive: true, force: true });
})();
