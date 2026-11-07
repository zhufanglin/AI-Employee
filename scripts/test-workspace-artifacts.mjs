import assert from 'node:assert/strict';
import { runToolLoop } from '../packages/worker/tool-loop.mjs';

let step = 0;
const api = async (path) => {
  if (path === '/capabilities') return { items: [] };
  if (path === '/compute/chat/completions') {
    const commands = [
      { tool: 'file_write', params: { name: '线索.csv', content: 'name\nDemo' } },
      { tool: 'finish', params: { text: '已完成线索清单' } },
    ];
    return { choices: [{ message: { content: JSON.stringify(commands[step++]) } }] };
  }
  if (path === '/capabilities/run') return { success: true, data: { key: 'workspace/test/uuid-线索.csv', name: '线索.csv', url: null } };
  throw new Error('unexpected path ' + path);
};
const result = await runToolLoop({ api, model: 'fixture', messages: [], maxSteps: 3 });
assert.deepEqual(result.files, [{ key: 'workspace/test/uuid-线索.csv', name: '线索.csv' }]);
assert.equal(result.content, '已完成线索清单');
console.log('Employee tool loop preserves private workspace artifacts');
