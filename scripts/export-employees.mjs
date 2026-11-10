import { writeFileSync } from 'node:fs'
import { EMPLOYEES } from '../packages/server/prisma/employees.ts'
writeFileSync('_deploy/employees.json', JSON.stringify(EMPLOYEES, null, 1), 'utf8')
console.log('EMPLOYEES', EMPLOYEES.length)
