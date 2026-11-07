// 生产用：把 SKILL.md 原文写入 AiEmployee.skillMd（只更新这一列，不动其它字段）
// 用法：node apply-skills-md.mjs            （读同目录 skills.json）
// 依赖：cwd 下的 @prisma/client 已按新 schema generate 过
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/package.json");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const map = JSON.parse(readFileSync(new URL("./skills.json", import.meta.url), "utf8"));
let ok = 0, missing = [];
for (const [slug, md] of Object.entries(map)) {
  const r = await prisma.aiEmployee.updateMany({ where: { slug }, data: { skillMd: md } });
  if (r.count) ok += 1; else missing.push(slug);
}
const total = await prisma.aiEmployee.count();
const withSkill = await prisma.aiEmployee.count({ where: { skillMd: { not: null } } });
console.log("[apply-skills] updated=" + ok + " missing=" + JSON.stringify(missing) + " withSkillMd=" + withSkill + "/" + total);
await prisma.$disconnect();
if (missing.length) process.exit(1);
