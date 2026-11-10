#!/usr/bin/env node
/**
 * P24 platform-drivers 纯函数单测（不依赖 electron）。
 * 做法：用 esbuild 把 platform-drivers.ts transform 成 CJS，在内存里 require，避免先编译整个桌面端。
 * 运行：
 *   C:\Users\30290\Desktop\REA逆向\toolchain\node-v24.22.1-win-x64\node.exe scripts\smoke-p24-platform-drivers.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as esbuild from 'esbuild'

const require2 = createRequire(import.meta.url)

const srcPath = new URL('../packages/desktop/src/main/platform-drivers.ts', import.meta.url)
const source = readFileSync(srcPath, 'utf8')
const transformed = esbuild.transformSync(source, { loader: 'ts', format: 'cjs', target: 'node18' })
const mod = { exports: {} }
const load = new Function('exports', 'require', 'module', '__filename', '__dirname', transformed.code)
load(mod.exports, require2, mod, srcPath.pathname, new URL('.', srcPath).pathname)

const { DRIVERS, PLATFORMS, TITLE_LIMITS, buildContent, clampTitle, platformSupports } = mod.exports

let pass = 0
let fail = 0
function check(name, ok, extra) {
  if (ok) {
    pass++
    console.log('PASS ' + name + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''))
  } else {
    fail++
    console.log('FAIL ' + name + ' ' + JSON.stringify(extra))
  }
}

function charLen(s) {
  return Array.from(s).length
}

// ── buildContent ──
check('buildContent 无标签只返回正文', buildContent('今天发个视频') === '今天发个视频', buildContent('今天发个视频'))
check('buildContent 拼接空格与 #', buildContent('正文', ['话题']) === '正文 #话题', buildContent('正文', ['话题']))
check(
  'buildContent 去掉首尾 # 并去重去空',
  buildContent('正文', ['#话题', '话题', ' #另一个 ', '', '#']) === '正文 #话题 #另一个',
  buildContent('正文', ['#话题', '话题', ' #另一个 ', '', '#'])
)
check('buildContent 正文为空时只输出标签', buildContent('', ['a']) === '#a', buildContent('', ['a']))
check('buildContent 正文首尾空白被裁剪', buildContent('  正文  ', [' tag ']) === '正文 #tag', buildContent('  正文  ', [' tag ']))
const manyTags = Array.from({ length: 12 }, (_, i) => 't' + i)
const many = buildContent('正文', manyTags)
check('buildContent 标签最多 10 个', (many.match(/#/g) || []).length === 10, many)
check('buildContent 保留第 10 个、丢弃第 11 个', many.indexOf('#t9') >= 0 && many.indexOf('#t10') < 0, many)
check('buildContent 忽略非字符串标签', buildContent('正文', [1, null, 'ok']) === '正文 #ok', buildContent('正文', [1, null, 'ok']))
check('buildContent 内容自带 # 不重复处理', buildContent('正文 #自带', ['自带']) === '正文 #自带 #自带', buildContent('正文 #自带', ['自带']))

// ── clampTitle ──
const longZh = '一二三四五六七八九十'.repeat(6)
check('clampTitle 抖音上限 30', charLen(clampTitle('douyin', longZh)) === 30, clampTitle('douyin', longZh))
check('clampTitle 小红书上上限 20', charLen(clampTitle('xiaohongshu', longZh)) === 20, clampTitle('xiaohongshu', longZh))
check('clampTitle 视频号上限 16', charLen(clampTitle('shipinhao', longZh)) === 16, clampTitle('shipinhao', longZh))
check('clampTitle 短标题不截断', clampTitle('douyin', '短标题') === '短标题', clampTitle('douyin', '短标题'))
check('clampTitle 去首尾空白', clampTitle('douyin', '  标题  ') === '标题', clampTitle('douyin', '  标题  '))
check('clampTitle 空值返回空串', clampTitle('douyin', undefined) === '' && clampTitle('douyin', '   ') === '')
check('clampTitle 中文按字符数不是字节', clampTitle('shipinhao', '中'.repeat(40)) === '中'.repeat(16))
check('clampTitle emoji 按一字符截断', charLen(clampTitle('shipinhao', '😀'.repeat(20))) === 16, charLen(clampTitle('shipinhao', '😀'.repeat(20))))
check('TITLE_LIMITS 三个平台数值正确', TITLE_LIMITS.douyin === 30 && TITLE_LIMITS.xiaohongshu === 20 && TITLE_LIMITS.shipinhao === 16, TITLE_LIMITS)

// ── DRIVERS ──
const ids = ['douyin', 'xiaohongshu', 'shipinhao']
check('DRIVERS 恰好三个平台', Object.keys(DRIVERS).sort().join(',') === ids.slice().sort().join(','), Object.keys(DRIVERS))
const homeUrls = {
  douyin: 'https://creator.douyin.com/creator-micro/content/upload',
  xiaohongshu: 'https://creator.xiaohongshu.com/publish/publish',
  shipinhao: 'https://channels.weixin.qq.com/platform/post/create'
}
for (const id of ids) {
  const d = DRIVERS[id]
  check('DRIVERS ' + id + ' 存在且有名称', !!d && typeof d.name === 'string' && d.name.length > 0, d && d.name)
  check('DRIVERS ' + id + ' homeUrl 正确', d.homeUrl === homeUrls[id], d.homeUrl)
  check('DRIVERS ' + id + ' 有 loginUrlHint', typeof d.loginUrlHint === 'string' && d.loginUrlHint.indexOf('http') === 0, d.loginUrlHint)
  for (const key of ['fileInput', 'titleInput', 'contentInput', 'submitButton', 'successHint']) {
    const arr = d[key]
    check('DRIVERS ' + id + '.' + key + ' 至少 3 个候选', Array.isArray(arr) && arr.length >= 3, arr && arr.length)
    check('DRIVERS ' + id + '.' + key + ' 候选均为非空字符串', Array.isArray(arr) && arr.every((s) => typeof s === 'string' && s.trim().length > 0))
  }
  // 小红书真机（2026-11-09）：发布按钮是 <xhs-publish-btn submit-text="发布">，文字在封闭 shadowRoot 里，
  // textContent 搜不到，因此允许用自定义元素选择器 + submitPoint 比例点击代替 text= 候选。
  check(
    'DRIVERS ' + id + ' 发布按钮含文本候选或用元素比例点击',
    d.submitButton.some((s) => s.indexOf('text=') === 0) || (!!d.submitPoint && d.submitButton.length > 0),
    { submitButton: d.submitButton, submitPoint: d.submitPoint || null }
  )
}
check('抖音登录 cookie 含 sessionid', Array.isArray(DRIVERS.douyin.loggedInCookies) && DRIVERS.douyin.loggedInCookies.indexOf('sessionid') >= 0, DRIVERS.douyin.loggedInCookies)

// ── PLATFORMS / platformSupports ──
check('PLATFORMS 三个平台', PLATFORMS.length === 3, PLATFORMS.map((p) => p.id))
check('PLATFORMS id 与 DRIVERS 对齐', PLATFORMS.every((p) => !!DRIVERS[p.id]) && PLATFORMS.map((p) => p.id).join(',') === ids.join(','))
check('PLATFORMS 每个平台都支持 video', PLATFORMS.every((p) => p.types.indexOf('video') >= 0), PLATFORMS.map((p) => p.types))
// P40 真机（2026-11-10）：视频号网页版没有独立的图文上传控件，先只声明 video
check('视频号只支持 video（图文未适配）', platformSupports('shipinhao', 'video') === true && platformSupports('shipinhao', 'image') === false)
check('platformSupports 正常', platformSupports('douyin', 'video') === true && platformSupports('douyin', 'image') === true)
check('platformSupports 未知平台为 false', platformSupports('bilibili', 'video') === false)

console.log('')
if (fail) {
  console.error('P24 platform-drivers SMOKE FAILED (' + fail + ' failed / ' + pass + ' passed)')
  process.exit(1)
}
console.log('P24 platform-drivers SMOKE OK (' + pass + ' checks)')
