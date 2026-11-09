const fs = require('fs')
const p = process.argv[2]
const v = process.argv[3]
const t = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
const j = JSON.parse(t)
j.version = v
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf8')
const b = fs.readFileSync(p)
console.log('VER=' + j.version + ' BOM=' + b[0])
