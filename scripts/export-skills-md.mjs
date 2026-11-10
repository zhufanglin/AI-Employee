#!/usr/bin/env node
/**
 * export-skills-md.mjs -- 把 resources/skills/<slug>/SKILL.md 导出成 JSON，
 * 供生产环境用纯 Node（不需要 tsx）写回 AiEmployee.skillMd。
 * 用法：node scripts/export-skills-md.mjs [输出路径，默认 _deploy/skills-md.json]
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SKILLS_DIR = join(ROOT, 'packages', 'desktop', 'resources', 'skills');
const OUT = resolve(ROOT, process.argv[2] || '_deploy/skills-md.json');
const MAX_CHARS = 12000;
const SUFFIX = '\n\n[内容已截断]';

const slugs = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && statSync(join(SKILLS_DIR, e.name, 'SKILL.md'), { throwIfNoEntry: false })?.isFile())
  .map((e) => e.name)
  .sort();

const out = {};
for (const slug of slugs) {
  let text = readFileSync(join(SKILLS_DIR, slug, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS - SUFFIX.length) + SUFFIX;
  out[slug] = text;
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 1), 'utf8');
const bytes = Buffer.byteLength(JSON.stringify(out), 'utf8');
console.log('exported ' + slugs.length + ' skills (' + bytes + ' bytes) -> ' + OUT);
