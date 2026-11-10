#!/usr/bin/env node
/**
 * apply-skills-md.mjs -- 在生产机把 skills-md.json 写回 AiEmployee.skillMd（纯 Node，不依赖 tsx）。
 * 用法：node /opt/fcmediaagent/audit/apply-skills-md.mjs [json路径]
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('/opt/fcmediaagent/app/');
const { PrismaClient } = require('@prisma/client');
const jsonPath = process.argv[2] || '/opt/fcmediaagent/audit/skills-md.json';
const data = JSON.parse(readFileSync(jsonPath, 'utf8'));

const prisma = new PrismaClient();
try {
  let updated = 0;
  const missing = [];
  for (const [slug, skillMd] of Object.entries(data)) {
    const row = await prisma.aiEmployee.findUnique({ where: { slug } });
    if (!row) { missing.push(slug); continue; }
    await prisma.aiEmployee.update({ where: { slug }, data: { skillMd } });
    updated += 1;
  }
  console.log('APPLIED ' + updated + '/' + Object.keys(data).length + (missing.length ? ' missing=' + missing.join(',') : ''));
  const rows = await prisma.aiEmployee.findMany({ select: { slug: true, skillMd: true } });
  const withMd = rows.filter((r) => (r.skillMd || '').length > 200);
  console.log('EMPLOYEES_WITH_SKILLMD ' + withMd.length + '/' + rows.length);
} finally {
  await prisma.$disconnect();
}
