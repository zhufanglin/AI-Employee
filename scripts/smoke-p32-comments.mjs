#!/usr/bin/env node
/**
 * P32 评论回复：页面脚本生成器的行为单测（不依赖 electron，也不依赖真实浏览器）。
 * 做法：用 esbuild 把 platform-drivers.ts transform 成 CJS，再喂一个最小 DOM 假实现执行页面脚本，
 * 断言「能扫到评论 / 能按 index 或 match 命中 / 能点到回复按钮 / 能判断回复结果」。
 * 运行：
 *   C:\Users\30290\Desktop\REA逆向\toolchain\node-v24.22.1-win-x64\node.exe scripts\smoke-p32-comments.mjs
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

const { DRIVERS, COMMENT_TEXT_MAX, COMMENT_ITEMS_MAX, scanCommentsScript, clickReplyScript, replyOutcomeScript } = mod.exports

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

// ── 最小 DOM 假实现 ──
function makeEl(text, opts = {}) {
  const kids = opts.kids || []
  const el = {
    __tag: opts.tag || 'div',
    __visible: opts.visible !== false,
    __classes: opts.classes || [],
    __placeholder: opts.placeholder || '',
    __value: opts.value === undefined ? '' : opts.value,
    innerText: text,
    textContent: text,
    value: opts.value === undefined ? '' : opts.value,
    className: (opts.classes || []).join(' '),
    disabled: false,
    clicked: 0,
    scrolled: 0,
    getBoundingClientRect() {
      return el.__visible ? { width: 200, height: 24 } : { width: 0, height: 0 }
    },
    scrollIntoView() {
      el.scrolled++
    },
    click() {
      el.clicked++
    },
    focus() {},
    getAttribute(n) {
      if (n === 'aria-disabled') return null
      if (n === 'placeholder') return el.__placeholder
      if (n === 'role') return opts.role || null
      return null
    },
    querySelectorAll(sel) {
      const parts = String(sel).split(',').map((s) => s.trim())
      const out = []
      for (const kid of kids) {
        for (const part of parts) {
          if (part === kid.__tag) { out.push(kid); break }
          if (part.indexOf('role=') >= 0 && kid.__role === 'button') { out.push(kid); break }
          if (part.indexOf('text=') === 0) { out.push(kid); break }
          if (kid.__classes.some((c) => part.indexOf(c) >= 0 && part.indexOf('[') === 0)) { out.push(kid); break }
        }
      }
      return out
    }
  }
  if (opts.role) el.__role = opts.role
  for (const kid of kids) kid.__parent = el
  return el
}

function makeDom({ items = [], sel = '.comment-item', sendHint = '', replyBoxes = [], title = '评论管理', href = 'https://creator.douyin.com/comment' } = {}) {
  const registry = new Map()
  if (sel) registry.set(sel, items)
  // 回复输入框候选：'textarea[placeholder*="回复"]' 等，统一按入参注册
  const boxSel = 'textarea[placeholder*="回复"]'
  registry.set(boxSel, replyBoxes)
  for (const s of ['[contenteditable="true"]', 'textarea', '.comment-input textarea']) registry.set(s, replyBoxes)
  const document = {
    title,
    href,
    body: makeEl(sendHint ? '页面内容 ' + sendHint : '页面内容'),
    querySelectorAll(s) {
      const parts = String(s).split(',').map((x) => x.trim())
      const out = []
      for (const part of parts) {
        const hit = registry.get(part)
        if (hit) out.push(...hit)
      }
      return out
    },
    // platform-drivers 的 rootPrefix 会用 document.querySelector(宿主选择器) 找 shadow 宿主
    querySelector(s) {
      const hit = this.querySelectorAll(s)
      return hit.length ? hit[0] : null
    },
    activeElement: null
  }
  const window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) }
  return { document, window, registry }
}

function runScript(script, dom) {
  const fn = new Function('document', 'window', 'location', 'return (' + script + ')')
  return fn(dom.document, dom.window, { href: dom.document.href })
}

// ── 1. 驱动配置 ──
for (const id of ['douyin', 'xiaohongshu', 'shipinhao']) {
  const d = DRIVERS[id]
  check(id + ' 配了评论管理页', typeof d.commentsUrl === 'string' && d.commentsUrl.indexOf('http') === 0, d.commentsUrl)
  check(id + ' 配了评论条目候选（≥3）', Array.isArray(d.commentItems) && d.commentItems.length >= 3, d.commentItems.length)
  check(id + ' 配了回复按钮候选（≥3）', Array.isArray(d.commentReplyButton) && d.commentReplyButton.length >= 3)
  check(id + ' 配了回复输入框候选（≥2）', Array.isArray(d.commentReplyInput) && d.commentReplyInput.length >= 2)
  check(id + ' 配了发送按钮候选（≥3）', Array.isArray(d.commentSendButton) && d.commentSendButton.length >= 3)
}
check('COMMENT_TEXT_MAX 是合理上限', COMMENT_TEXT_MAX >= 100 && COMMENT_TEXT_MAX <= 1000, COMMENT_TEXT_MAX)
check('COMMENT_ITEMS_MAX 是合理上限', COMMENT_ITEMS_MAX >= 10 && COMMENT_ITEMS_MAX <= 200, COMMENT_ITEMS_MAX)

// ── 2. 脚本语法可用 ──
const d0 = DRIVERS.douyin
for (const [name, script] of [
  ['scanCommentsScript', scanCommentsScript(d0)],
  ['clickReplyScript', clickReplyScript(d0, { index: 0 })],
  ['replyOutcomeScript', replyOutcomeScript(d0, '好的收到')]
]) {
  check(name + ' 是字符串', typeof script === 'string' && script.length > 50)
  let ok = true
  try { new Function('return (' + script + ')') } catch (e) { ok = false }
  check(name + ' 语法可执行', ok)
}

// ── 3. scan：读列表 / 去重 / 过滤 / 上限 ──
const btnReply = makeEl('回复', { tag: 'span', classes: ['reply-btn'], role: 'button' })
const itemA = makeEl('张三：这个视频真好用', { kids: [btnReply] })
const itemB = makeEl('李四：请问价格是多少', {})
const itemC = makeEl('a', {}) // 太短，应被过滤
const dup = makeEl('张三：这个视频真好用', {}) // 重复，应被去重
let dom = makeDom({ items: [itemA, itemB, itemC, dup] })
let out = runScript(scanCommentsScript(d0), dom)
check('scan 能读到评论', out.ok === true && out.items.length === 2, out.items)
check('scan 过滤过短文本', out.items.every((i) => i.text.length >= 2), out.items.map((i) => i.text))
check('scan 按文本去重', out.items.filter((i) => i.text.indexOf('张三') >= 0).length === 1)
check('scan 返回命中选择器', out.selector === '.comment-item', out.selector)
check('scan 返回页面标题与地址', out.title === '评论管理' && out.href.indexOf('comment') >= 0, [out.title, out.href])
check('scan index 从 0 连续', out.items[0].index === 0 && out.items[1].index === 1, out.items.map((i) => i.index))

const many = Array.from({ length: COMMENT_ITEMS_MAX + 10 }, (_, i) => makeEl('第 ' + i + ' 条评论内容'))
dom = makeDom({ items: many })
out = runScript(scanCommentsScript(d0), dom)
check('scan 最多返回 COMMENT_ITEMS_MAX 条', out.items.length === COMMENT_ITEMS_MAX, out.items.length)

dom = makeDom({ items: [] })
out = runScript(scanCommentsScript(d0), dom)
check('scan 没评论时 ok=false', out.ok === false && out.items.length === 0)

// ── 4. clickReply：按 index / 按 match ──
const rBtn1 = makeEl('回复', { tag: 'button', classes: ['reply'] })
const rBtn2 = makeEl('回复', { tag: 'button', classes: ['reply'] })
const c1 = makeEl('第一条：求教程', { kids: [rBtn1] })
const c2 = makeEl('第二条：多少钱', { kids: [rBtn2] })
dom = makeDom({ items: [c1, c2] })
let hit = runScript(clickReplyScript(d0, { index: 1 }), dom)
check('clickReply 按 index 命中第二条', hit.ok === true && hit.text.indexOf('第二条') >= 0, hit)
check('clickReply 点到了对应按钮', rBtn2.clicked === 1 && rBtn1.clicked === 0, [rBtn1.clicked, rBtn2.clicked])
check('clickReply 把条目滚进视野', c2.scrolled >= 1, c2.scrolled)

dom = makeDom({ items: [c1, c2] })
hit = runScript(clickReplyScript(d0, { match: '求教程' }), dom)
check('clickReply 按 match 命中第一条', hit.ok === true && hit.index === 0, hit)
check('clickReply 按 match 时点的是第一条按钮', rBtn1.clicked >= 1)

dom = makeDom({ items: [c1, c2] })
hit = runScript(clickReplyScript(d0, { index: 9 }), dom)
check('clickReply index 越界返回 ok=false', hit.ok === false && typeof hit.error === 'string', hit.error)

dom = makeDom({ items: [c1, c2] })
hit = runScript(clickReplyScript(d0, { match: '找不到的内容' }), dom)
check('clickReply match 没命中返回 ok=false', hit.ok === false)

dom = makeDom({ items: [] })
hit = runScript(clickReplyScript(d0, { index: 0 }), dom)
check('clickReply 没评论时给出中文错误', hit.ok === false && hit.error.indexOf('没读到评论') >= 0, hit.error)

// 只有纯文本「回复」节点（没有 class，只能走文本兜底）
const plainBtn = makeEl('回复', { tag: 'div', role: 'button' })
const c3 = makeEl('第三条：怎么联系客服', { kids: [plainBtn] })
dom = makeDom({ items: [c3] })
hit = runScript(clickReplyScript(d0, { index: 0 }), dom)
check(
  'clickReply 能用纯文本「回复」节点找到入口并点它',
  hit.ok === true && plainBtn.clicked === 1 && !!hit.selector,
  hit
)

// ── 5. replyOutcome：成功提示 / 输入框清空 ──
const boxFull = makeEl('', { tag: 'textarea', placeholder: '回复 @张三', value: '好的收到' })
dom = makeDom({ replyBoxes: [boxFull] })
let res = runScript(replyOutcomeScript(d0, '好的收到'), dom)
check('replyOutcome 输入框仍有内容时 cleared=false', res.cleared === false, res)

const boxEmpty = makeEl('', { tag: 'textarea', placeholder: '回复 @张三', value: '' })
dom = makeDom({ replyBoxes: [boxEmpty] })
res = runScript(replyOutcomeScript(d0, '好的收到'), dom)
check('replyOutcome 输入框清空时 cleared=true', res.cleared === true, res)

dom = makeDom({ replyBoxes: [boxFull], sendHint: '回复成功' })
res = runScript(replyOutcomeScript(d0, '好的收到'), dom)
check('replyOutcome 识别成功提示', res.hint === '回复成功', res.hint)

dom = makeDom({ replyBoxes: [boxFull] })
res = runScript(replyOutcomeScript(d0, '好的收到'), dom)
check('replyOutcome 没有提示也没清空时两者都 false', !res.hint && res.cleared === false)

// 三平台脚本都能生成
for (const id of ['douyin', 'xiaohongshu', 'shipinhao']) {
  const dd = DRIVERS[id]
  let okAll = true
  try {
    runScript(scanCommentsScript(dd), makeDom({ items: [makeEl('随便一条评论'), makeEl('再来一条评论')] }))
    runScript(clickReplyScript(dd, { index: 0 }), makeDom({ items: [makeEl('随便一条评论'), makeEl('再来一条评论')] }))
    runScript(replyOutcomeScript(dd, '嗯'), makeDom({ replyBoxes: [makeEl('', { tag: 'textarea', value: '' })] }))
  } catch (e) {
    okAll = false
    console.log('  ' + id + ' 脚本执行异常：' + String(e && e.message))
  }
  check(id + ' 三个脚本都能在页面上跑通', okAll)
}

if (fail) {
  console.log('\nP32 comments SMOKE FAILED (' + pass + ' passed, ' + fail + ' failed)')
  process.exit(1)
}
console.log('\nP32 comments SMOKE OK (' + pass + ' checks)')
