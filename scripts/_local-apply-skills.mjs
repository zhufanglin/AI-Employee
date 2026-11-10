import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire('C:/Users/30290/Desktop/fcmediaagent-replica/packages/server/')
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const map = JSON.parse(readFileSync('C:/Users/30290/Desktop/fcmediaagent-replica/_deploy/skills-md.json', 'utf8'))
let n = 0
for (const [slug, skillMd] of Object.entries(map)) {
  const res = await prisma.aiEmployee.updateMany({ where: { slug }, data: { skillMd } })
  n += res.count
}
const total = await prisma.aiEmployee.count({ where: { NOT: { skillMd: null } } })
console.log('APPLIED', n, 'WITH_SKILL', total)
await prisma.$disconnect()
