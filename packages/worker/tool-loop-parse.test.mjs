import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instruction, skillSection } from './tool-loop.mjs';

test('纯 JSON', () => {
  assert.deepEqual(instruction('{"tool":"finish","params":{"text":"成品"}}'), { tool: 'finish', params: { text: '成品' } });
});

test('Markdown 代码围栏', () => {
  assert.deepEqual(instruction('```json\n{"tool":"web_extract","params":{"url":"https://example.com"}}\n```'), { tool: 'web_extract', params: { url: 'https://example.com' } });
});

test('前后带解释文字', () => {
  const text = '我先抓取一下。\n{"tool":"web_extract","params":{"url":"https://example.com"}}\n以上。';
  assert.equal(instruction(text).tool, 'web_extract');
});

test('tool 别名 action / name', () => {
  assert.equal(instruction('{"action":"finish","params":{"text":"x"}}').tool, 'finish');
  assert.equal(instruction('{"name":"finish","args":{"text":"x"}}').tool, 'finish');
});

test('params 缺失回退空对象', () => {
  assert.deepEqual(instruction('{"tool":"content_query"}'), { tool: 'content_query', params: {} });
});

test('非法输入报错', () => {
  assert.throws(() => instruction('我要开始干活了'), /有效的 JSON/);
  assert.throws(() => instruction('{"params":{}}'), /tool 字符串/);
});

test('技能说明注入：无 skill 不追加', () => {
  assert.equal(skillSection(undefined), '');
  assert.equal(skillSection(''), '');
  assert.equal(skillSection(null), '');
});

test('技能说明注入：有 skill 追加并带优先级声明', () => {
  const section = skillSection('---\nname: boss-lead-radar\n---\n第一步：抓取同行账号。');
  assert.match(section, /技能说明|SKILL\.md/);
  assert.match(section, /工具白名单、JSON 指令协议、计费和安全限制始终优先/);
  assert.match(section, /第一步：抓取同行账号。/);
});

test('技能说明注入：超长截断并标记', () => {
  const section = skillSection('x'.repeat(20000));
  assert.match(section, /\[技能说明已截断\]/);
  assert.ok(section.length < 20000);
});
