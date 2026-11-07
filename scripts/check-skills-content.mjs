#!/usr/bin/env node
/**
 * check-skills-content.mjs -- 校验 packages/server/prisma/skills-content.ts。
 * 纯文本解析（不编译 TS）：统计 'slug': `...` 条目、长度、frontmatter 字段与反引号转义。
 * 断言失败时打印差异并以 exit code 1 退出。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SKILLS_DIR = join(ROOT, 'packages', 'desktop', 'resources', 'skills');
const CONTENT_FILE = join(ROOT, 'packages', 'server', 'prisma', 'skills-content.ts');

const MIN_CHARS = 500;
const MAX_CHARS = 12000;

const ENTRY_RE = /^  '([a-z0-9][a-z0-9-]*)': `((?:[^`\\]|\\.)*)`,$/gm;
const DELIMITER_RE = /(?<!\\)`/g;

const problems = [];

function onDiskSlugs() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isDirectory()) return false;
      const st = statSync(join(SKILLS_DIR, entry.name, 'SKILL.md'), { throwIfNoEntry: false });
      return Boolean(st && st.isFile());
    })
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

let text;
try {
  text = readFileSync(CONTENT_FILE, 'utf8');
} catch (err) {
  console.error('FAIL: cannot read ' + CONTENT_FILE + ': ' + err.message);
  process.exit(1);
}

const entries = [];
for (const match of text.matchAll(ENTRY_RE)) {
  entries.push({ slug: match[1], body: match[2], length: match[2].length });
}

const expectedSlugs = onDiskSlugs();
const actualSlugs = entries.map((entry) => entry.slug);
const missing = expectedSlugs.filter((slug) => !actualSlugs.includes(slug));
const extra = actualSlugs.filter((slug) => !expectedSlugs.includes(slug));

if (entries.length !== expectedSlugs.length) {
  problems.push('entry count mismatch: file=' + entries.length + ', resources/skills dirs with SKILL.md=' + expectedSlugs.length);
}
if (missing.length) problems.push('missing slugs: ' + missing.join(', '));
if (extra.length) problems.push('unexpected slugs: ' + extra.join(', '));
if (JSON.stringify(actualSlugs) !== JSON.stringify([...actualSlugs].sort())) {
  problems.push('entries are not sorted by slug');
}

for (const entry of entries) {
  if (entry.length < MIN_CHARS) {
    problems.push(entry.slug + ': content too short (' + entry.length + ' < ' + MIN_CHARS + ')');
  }
  if (entry.length > MAX_CHARS) {
    problems.push(entry.slug + ': content too long (' + entry.length + ' > ' + MAX_CHARS + ')');
  }
  if (!entry.body.includes('name:')) {
    problems.push(entry.slug + ': missing "name:"');
  }
  if (!entry.body.includes('description:')) {
    problems.push(entry.slug + ': missing "description:"');
  }
}

const delimiters = (text.match(DELIMITER_RE) || []).length;
if (delimiters !== entries.length * 2) {
  problems.push('unescaped backtick delimiters: found ' + delimiters + ', expected ' + entries.length * 2);
}
if (!/^export const SKILL_CONTENT: Record<string, string> = \{$/m.test(text)) {
  problems.push('missing export const SKILL_CONTENT declaration');
}
if (!/^export const SKILL_CONTENT_VERSION = '\d{4}-\d{2}-\d{2}T[^']+'\;$/m.test(text)) {
  problems.push('missing or malformed SKILL_CONTENT_VERSION');
}

if (problems.length) {
  console.error('SKILLS CONTENT FAILED (' + problems.length + ' problem(s)):');
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}

console.log('SKILLS CONTENT OK (' + entries.length + ' entries)');
