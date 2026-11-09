const fs = require('fs')
const p = process.argv[2]
let t = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
fs.writeFileSync(p, '\uFEFF' + t, 'utf8')
const b = fs.readFileSync(p)
console.log('BOM=' + [...b.slice(0, 3)].join(',') + ' SIZE=' + b.length)
