const asar = require('@electron/asar')
const p = 'C:\\Users\\30290\\AppData\\Local\\Programs\\fcmediaagent-desktop\\resources\\app.asar'
const list = asar.listPackage(p).map((x) => String(x).replace(/^[\\/]/, ''))
const renderer = list.filter((x) => /renderer[\\/]assets[\\/]index-.*\.js$/.test(x))
const main = asar.extractFile(p, 'out\\main\\index.js').toString('utf8')
const rjs = renderer.length ? asar.extractFile(p, renderer[0].replace(/\//g, '\\')).toString('utf8') : ''
const pkg = JSON.parse(asar.extractFile(p, 'package.json').toString('utf8'))
console.log('VERSION=' + pkg.version)
console.log('MAIN_p32_ipc=' + main.includes('platform:reply-comment'))
console.log('MAIN_hasParseMetrics=' + main.includes('platform:parse-metrics'))
console.log('RENDER=' + renderer.join(','))
console.log('R_p32=' + rjs.includes('platform-comment-list'))
console.log('R_p33=' + rjs.includes('platform-result-table'))
// P29 协议守卫在主进程（renderer 里没有这个逻辑），改为断言打包后的 main
console.log('MAIN_p29_guard=' + (main.includes('onBeforeRequest') && main.includes('拦截外部协议请求')))
console.log('R_p26_queue=' + rjs.includes('queue:') )
console.log('MAIN_p34_submitpoint=' + main.includes('submitPoint'))
console.log('MAIN_p34_cdpnav=' + main.includes('Page.navigate'))
