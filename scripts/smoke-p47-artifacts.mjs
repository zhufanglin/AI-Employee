import assert from 'node:assert/strict';
import { collectFiles, runToolLoop } from '../packages/worker/tool-loop.mjs';
const a = { key: 'workspace/u/a.xlsx', name: 'a.xlsx' }, b = { key: 'workspace/u/b.md', name: 'b.md' }, c = { key: 'workspace/u/c.mp4', name: 'c.mp4' };
assert.deepEqual(collectFiles(a), [a]);
assert.deepEqual(collectFiles({ file: b }), [b]);
assert.deepEqual(collectFiles(c), [c]);
assert.deepEqual(collectFiles({ ...a, file: a }), [a]);
assert.deepEqual(collectFiles({ name: 'missing' }), []);
assert.deepEqual(collectFiles({ key: 'https://example.com/secret', name: 'unsafe' }), []);
const d = { key: 'workspace/u/d.docx', name: 'd.docx' };
const commands = ['file_write', 'doc_write', 'transcribe', 'media_process', 'doc_write', 'finish'];
const outputs = [a, d, { file: b }, c, d]; let turn = 0, calls = 0;
const api = async (path) => {
  if (path === '/capabilities') return { items: [] };
  if (path === '/compute/chat/completions') { const tool = commands[turn++]; return { choices: [{ message: { content: JSON.stringify({ tool, params: tool === 'finish' ? { text: '完成' } : {} }) } }] }; }
  if (path === '/capabilities/run') return { success: true, data: outputs[calls++] };
  throw new Error('unexpected path');
};
const result = await runToolLoop({ api, model: 'test', messages: [], maxSteps: 7 });
assert.deepEqual(result.files, [a, d, b, c]);
console.log('P47 artifacts: 3 output shapes, invalid key, cross-step dedup and tool loop PASS');
