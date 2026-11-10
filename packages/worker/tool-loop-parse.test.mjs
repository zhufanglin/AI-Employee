import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instruction, skillSection, needsSection, strategySection, personaSection } from './tool-loop.mjs';

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

test('P42 数据授权：needs 为空不追加', () => {
  assert.equal(needsSection(undefined), '');
  assert.equal(needsSection([]), '');
  assert.equal(needsSection(['', '  ']), '');
});

test('P42 数据授权：有 needs 列出条目', () => {
  const section = needsSection(['strategy.sections:产品体系|竞争与优势', 'persona']);
  assert.match(section, /## 当前员工岗位的数据授权/);
  assert.match(section, /- strategy\.sections:产品体系\|竞争与优势/);
  assert.match(section, /- persona/);
});

test('P42 公司战略：无战略不追加', () => {
  assert.equal(strategySection(undefined), '');
  assert.equal(strategySection(''), '');
  assert.equal(strategySection(null), '');
});

test('P42 公司战略：带版本头与事实优先声明', () => {
  const section = strategySection('## 2. 产品体系\n我们卖企业AI员工。', { version: 'V1.3', updatedAt: '2026-11-10T02:00:00.000Z' });
  assert.match(section, /## 公司战略（当前版本 V1\.3），更新于 2026-11-10/);
  assert.match(section, /与它冲突的说法以它为准/);
  assert.match(section, /我们卖企业AI员工。/);
});

test('P42 公司战略：超过 6000 字截断', () => {
  const section = strategySection('战'.repeat(9000));
  assert.match(section, /\[战略文档已截断\]/);
  assert.ok(section.length < 6800);
});

test('P42 账号人设：为空不追加、有内容带人设声明', () => {
  assert.equal(personaSection(''), '');
  const section = personaSection('| 名称 | 定位 |\n| 老王 | 老板IP |');
  assert.match(section, /## 账号人设/);
  assert.match(section, /不是客服话术/);
  assert.match(section, /老板IP/);
});

test('P42 账号人设：超过 1500 字截断', () => {
  const section = personaSection('人'.repeat(4000));
  assert.match(section, /\[人设资料已截断\]/);
  assert.ok(section.length < 2200);
});
