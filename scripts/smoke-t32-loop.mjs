// Isolated tool-loop checks: no model or media provider calls.
import assert from 'node:assert/strict';
import { runToolLoop } from '../packages/worker/tool-loop.mjs';

const commands = [
  { tool: 'not_allowed', params: {} },
  { tool: 'image_gen', params: { prompt: 'test' } },
  { tool: 'finish', params: { text: '播报稿示例' } },
];
let submits = 0, queries = 0;
const api = async (path) => {
  if (path === '/capabilities') return { items: [] };
  if (path === '/compute/chat/completions') return { choices: [{ message: { content: JSON.stringify(commands.shift()) } }], usage: { total_tokens: 1 } };
  if (path === '/media/images/generations') { submits++; return { taskId: 'test-image', status: 'QUEUED', estimatedAmount: 20 }; }
  if (path === '/media/tasks/test-image') { if (++queries === 1) throw new Error('temporary network error'); return { status: 'SUCCESS', resultUrl: 'https://example.invalid/image.png', settledAmount: 20 }; }
  throw new Error('unexpected request: ' + path);
};
const result = await runToolLoop({ api, model: 'test', messages: [], maxSteps: 4, timeoutMs: 5000, pollMs: 10 });
assert.equal(result.content, '播报稿示例');
assert.equal(result.steps.length, 3);
assert.equal(result.steps[0].success, false);
assert.equal(result.media[0].kind, 'image');
assert.equal(result.media[0].credits, 20);
assert.equal(submits, 1, 'status query errors must never resubmit a paid task');
console.log('PASS controlled tool loop, allowlist and media artifact');

let calls = 0;
const ambiguousApi = async (path) => {
  if (path === '/capabilities') return { items: [] };
  if (path === '/compute/chat/completions') { calls++; return { choices: [{ message: { content: JSON.stringify({ tool: 'image_gen', params: { prompt: 'x' } }) } }] }; }
  throw new Error('媒体任务提交结果待核对，请勿重复提交并联系客服');
};
await assert.rejects(runToolLoop({ api: ambiguousApi, model: 'test', messages: [], timeoutMs: 5000, pollMs: 10 }), /待核对/);
assert.equal(calls, 1);
console.log('PASS ambiguous paid submission is not retried');
