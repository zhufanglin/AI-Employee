#!/usr/bin/env node
/**
 * gen-skills-content.mjs -- 把 packages/desktop/resources/skills/<slug>/SKILL.md
 * 打包成 packages/server/prisma/skills-content.ts（服务端技能内容表，供种子/技能派发读取）。
 *
 * 约束：
 *  - 零依赖，仅使用 node 内置模块；ESM。
 *  - 收录 resources/skills 下每个含 SKILL.md 的子目录，按 slug 字母序排列。
 *  - 保留原文（含 YAML frontmatter），单条上限 12000 字符；超限截断并在末尾追加 "[内容已截断]"。
 *  - 模板字符串内转义反引号与 ${，保证产出是合法 TypeScript。
 *  - 幂等：重复运行除 SKILL_CONTENT_VERSION 时间戳外输出完全一致。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SKILLS_DIR = join(ROOT, 'packages', 'desktop', 'resources', 'skills');
const OUT_FILE = join(ROOT, 'packages', 'server', 'prisma', 'skills-content.ts');

const MAX_CHARS = 12000;
const TRUNCATE_SUFFIX = '\n\n[内容已截断]';

function listSlugs() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isDirectory()) return false;
      const skillFile = join(SKILLS_DIR, entry.name, 'SKILL.md');
      const st = statSync(skillFile, { throwIfNoEntry: false });
      return Boolean(st && st.isFile());
    })
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function toTemplateBody(raw) {
  let text = raw.replace(/\r\n/g, '\n');
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS - TRUNCATE_SUFFIX.length) + TRUNCATE_SUFFIX;
  }
  return text
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

const slugs = listSlugs();
if (slugs.length === 0) {
  console.error('ERROR: no SKILL.md found under ' + SKILLS_DIR);
  process.exit(1);
}

const lines = [];
lines.push('/**');
lines.push(' * skills-content.ts -- 自动生成，请勿手改。');
lines.push(' * 生成器：scripts/gen-skills-content.mjs');
lines.push(' * 来源：packages/desktop/resources/skills/<slug>/SKILL.md（保留原始 frontmatter）。');
lines.push(' * 条目数：' + slugs.length + '；单条上限 ' + MAX_CHARS + ' 字符。');
lines.push(' */');
lines.push('');
lines.push('export const SKILL_CONTENT: Record<string, string> = {');
for (const slug of slugs) {
  const raw = readFileSync(join(SKILLS_DIR, slug, 'SKILL.md'), 'utf8');
  if (raw.length < 500) {
    console.error('WARN: ' + slug + ' SKILL.md is shorter than 500 chars (' + raw.length + ')');
  }
  lines.push("  '" + slug + "': `" + toTemplateBody(raw) + "`,");
}
lines.push('};');
lines.push('');
lines.push("export const SKILL_CONTENT_VERSION = '" + new Date().toISOString() + "';");
lines.push('');

const out = lines.join('\n');
writeFileSync(OUT_FILE, out, 'utf8');
console.log('skills-content.ts generated: ' + slugs.length + ' entries, ' + Buffer.byteLength(out, 'utf8') + ' bytes -> ' + OUT_FILE);
console.log('slugs: ' + slugs.join(', '));
