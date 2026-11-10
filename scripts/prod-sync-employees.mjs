import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire('/opt/fcmediaagent/app/')
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const seeds = JSON.parse(readFileSync('/opt/fcmediaagent/audit/employees.json', 'utf8'))
const skills = JSON.parse(readFileSync('/opt/fcmediaagent/audit/skills-md.json', 'utf8'))
let n = 0
for (const e of seeds) {
  const data = { ...e, skillMd: skills[e.slug] ?? undefined }
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k]
  await prisma.aiEmployee.upsert({ where: { slug: e.slug }, update: data, create: data })
  n += 1
}
const required = await prisma.aiEmployee.count({ where: { cliRequirement: 'required' } })
console.log('SYNCED', n, 'REQUIRED_LEFT', required)
await prisma.$disconnect()
