/**
 * P48 来源核对（source_check）冒烟 —— 可离线判定的部分
 *  1) 能力注册：descriptor 名称/分类/参数、能力服务挂载
 *  2) 链接抽取：去重、去尾标点、上限 8、只收 http(s)
 *  3) 归一化：全角/半角、空白、中英文标点、百分号差异都能对上
 *  4) 原句比对：exact / partial / missing / empty
 *  5) 入口校验：没给来源、超过 8 条、非 http 网址 → 中文 400（联网前就拒）
 *  6) 工具循环与指令：worker 白名单含 source_check、指令要求未通过标「未核实」
 * 真实联网核对在生产验收脚本 scripts/prod-verify-p48.mjs 覆盖（本地 SSRF 守卫禁止打 127.0.0.1）。
 * 用法：node scripts/smoke-p48-source-check.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const ROOT = process.cwd()
const mod = require(ROOT + '/packages/server/dist/capabilities/capabilities/source-check.js')
const { descriptor, handler, extractUrls, normForMatch, quoteMatches } = mod

let pass = 0
let fail = 0
function chk(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')) }
}
async function expectThrow(fn) {
  try { await fn(); return { threw: false } }
  catch (e) {
    const anyE = e;
    const msg = String((anyE && (anyE.message || (anyE.response && anyE.response.message))) || e);
    return { threw: true, msg };
  }
}

console.log('== 能力注册 ==')
chk('descriptor.name = source_check', descriptor.name === 'source_check', descriptor.name)
chk('descriptor.category = web', descriptor.category === 'web', descriptor.category)
chk('params 含 claims/urls/text/quote/strict', ['claims', 'urls', 'text', 'quote', 'strict'].every((k) => k in descriptor.params))
chk('handler 是函数', typeof handler === 'function')
const svc = readFileSync(ROOT + '/packages/server/src/capabilities/capability.service.ts', 'utf8')
chk('能力服务注册了 source_check handler', svc.includes('source_check: sourceCheckHandler'))
chk('能力服务 descriptors 含 sourceCheckDescriptor', svc.includes('sourceCheckDescriptor'))

console.log('== 链接抽取 ==')
const text = '据报告(https://a.example.com/x)显示，参见 https://b.example.com/y。还有 https://a.example.com/x 重复。详见 http://c.example.com/z].'
const urls = extractUrls(text)
chk('抽出 3 个链接', urls.length === 3, urls)
chk('去掉尾部标点', urls.every((u) => !/[.,)\]}。；]/.test(u.slice(-1))), urls)
chk('重复链接只留一个', urls.filter((u) => u === 'https://a.example.com/x').length === 1, urls)
chk('非 http 链接不抽', extractUrls('ftp://x.example.com/a 与 javascript:alert(1)').length === 0)
const manyUrls = Array.from({ length: 12 }, (_, i) => 'https://s' + i + '.example.com/p').join(' ')
chk('最多抽 8 个', extractUrls(manyUrls).length === 8, extractUrls(manyUrls).length)

console.log('== 归一化 ==')
chk('全角数字与百分号等价', normForMatch('增长 １３１％') === normForMatch('增长131%'), normForMatch('增长 １３１％'))
chk('中文标点与空格被忽略', normForMatch('去家务化，同比增长 131%。') === normForMatch('去家务化同比增长131%'))
chk('大小写不敏感', normForMatch('Gartner 预测') === normForMatch('gartner预测'))

console.log('== 原句比对 ==')
const page = '小红书 2026 居住趋势显示，「去家务化」笔记发布量同比增长 131%，适宠化搜索增长 680%。'
let m = quoteMatches(page, '去家务化笔记发布量同比增长131%')
chk('完全一致 -> exact', m.found && m.mode === 'exact', m)
m = quoteMatches(page, '去家务化笔记发布量同比增长131%的数据')
chk('少量改写 -> partial 也算通过', m.found && (m.mode === 'partial' || m.mode === 'exact'), m)
m = quoteMatches(page, '适宠化搜索增长680%')
chk('页面里另一句也能命中', m.found, m)
m = quoteMatches(page, '艾瑞咨询白皮书显示家装线索转化率 12.8%')
chk('页面里没有 -> missing', !m.found && m.mode === 'missing', m)
m = quoteMatches(page, '   ')
chk('空引用 -> empty', !m.found && m.mode === 'empty', m)
m = quoteMatches('', '任意一句话')
chk('空页面 -> missing', !m.found, m)

console.log('== 入口校验（联网前拒） ==')
let r = await expectThrow(() => handler({ userId: 'smoke-p48', phone: '', params: {} }))
chk('没给来源 -> 中文提示', r.threw && r.msg.includes('核对'), r)
r = await expectThrow(() => handler({ userId: 'smoke-p48', phone: '', params: { urls: Array.from({ length: 9 }, (_, i) => 'https://s' + i + '.example.com/p') } }))
chk('超过 8 条 -> 中文提示', r.threw && r.msg.includes('8'), r)
r = await expectThrow(() => handler({ userId: 'smoke-p48', phone: '', params: { urls: ['ftp://x.example.com/a'] } }))
chk('非 http 网址 -> 中文提示', r.threw && r.msg.includes('http'), r)
const inner = await handler({ userId: 'smoke-p48', phone: '', params: { urls: ['http://127.0.0.1:3000/api'] } })
chk('内网地址不会判 verified', inner.verified === 0 && inner.items[0].verdict === 'unreachable', inner.items[0])
chk('内网地址提示禁止访问内网', String(inner.items[0].message).includes('内网'), inner.items[0].message)

console.log('== 工具循环接线 ==')
const tl = readFileSync(ROOT + '/packages/worker/tool-loop.mjs', 'utf8')
chk('worker 白名单含 source_check', tl.includes("'source_check'"))
chk('可用工具列表含 source_check', tl.includes('web_search、source_check'))
chk('指令要求引用后核对', tl.includes('必须用 source_check'))
chk('指令要求未通过标未核实', tl.includes('未核实'))

console.log('')
console.log('SOURCE CHECK SMOKE ' + (fail === 0 ? 'OK' : 'FAILED') + ' (' + pass + ' checks, ' + fail + ' failed)')
process.exitCode = fail === 0 ? 0 : 1
