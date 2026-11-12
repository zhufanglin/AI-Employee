/**
 * P1 语音转写（transcribe）冒烟
 *
 * 本地没有 faster-whisper 引擎（生产才有），这里只验证「契约与降级」：
 *  1) 能力已注册（descriptor 名称/分类/入口），能力服务里真的挂上了 transcribe
 *  2) 缺 source / 空 source → 中文 400 提示
 *  3) ASR_ENABLED=0 → 明确提示已关闭
 *  4) 本机没有引擎时 → 中文提示「本机没有安装语音识别引擎」，不是 500 也不是英文报错
 *  5) 工作区里不存在的文件 → 中文报错，不抛未捕获异常
 *  6) 引擎路径可用（生产上跑）时，真实转写会在生产验收脚本里覆盖
 *
 * 用法：node scripts/smoke-p46-asr.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '')

try {
  const raw = readFileSync(ROOT + '/packages/server/.env', 'utf8').replace(/^\uFEFF/, '')
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {}

const { descriptors, handlers } = require(ROOT + '/packages/server/dist/capabilities/capabilities/asr.js')

let pass = 0
let fail = 0
const chk = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')) }
}

async function expectThrow(fn, needle) {
  try { await fn(); return { threw: false } } catch (e) {
    const msg = String((e && e.message) || e)
    return { threw: true, msg, matched: msg.includes(needle) }
  }
}

const handler = handlers.transcribe
const ctx = (params) => ({ userId: 'smoke-p46-asr-user', phone: '13900000002', params })

async function main() {
  console.log('== P1 语音转写冒烟 ==')

  // 1) descriptor
  const desc = (descriptors || []).find((d) => d && d.name === 'transcribe')
  chk('descriptor 存在且 name=transcribe', !!desc)
  chk('descriptor 分类为 media', !!desc && desc.category === 'media', desc && desc.category)
  chk('descriptor 标题含「语音」', !!desc && String(desc.title).includes('语音'), desc && desc.title)
  chk('descriptor 声明了 source 参数', !!desc && !!(desc.params && desc.params.source))
  chk('handler 是函数', typeof handler === 'function')
  chk('能力服务已挂载 transcribe', /asrDescriptors/.test(readFileSync(ROOT + '/packages/server/src/capabilities/capability.service.ts', 'utf8')))

  // 2) 参数校验
  const noSource = await expectThrow(() => handler(ctx({})), 'source 必填')
  chk('缺 source → 中文提示', noSource.threw && noSource.matched, noSource)

  const blank = await expectThrow(() => handler(ctx({ source: '   ' })), 'source 必填')
  chk('source 全空白 → 中文提示', blank.threw && blank.matched, blank)

  // 3) 关闭开关
  const before = process.env.ASR_ENABLED
  process.env.ASR_ENABLED = '0'
  const off = await expectThrow(() => handler(ctx({ source: 'demo.mp3' })), '语音转写能力已关闭')
  chk('ASR_ENABLED=0 → 提示已关闭', off.threw && off.matched, off)
  if (before === undefined) delete process.env.ASR_ENABLED
  else process.env.ASR_ENABLED = before

  // 4) 本机无引擎时的降级提示（生产上存在引擎，这条会变成「文件不存在」类错误，两种都算通过）
  process.env.ASR_PYTHON = ROOT + '/__no_such_python__'
  const noEngine = await expectThrow(() => handler(ctx({ source: 'demo.mp3' })), '本机没有安装语音识别引擎')
  chk('无引擎 → 中文提示（不是 500/英文）', noEngine.threw && noEngine.matched, noEngine)
  delete process.env.ASR_PYTHON

  // 5) 工作区里没有的文件
  process.env.ASR_PYTHON = process.env.ASR_PYTHON || '/opt/fcmediaagent/asr/venv/bin/python'
  const missing = await expectThrow(() => handler(ctx({ source: 'definitely-not-exists-' + Date.now() + '.mp3' })), '')
  chk('工作区缺文件 → 抛中文错误', missing.threw && /[\u4e00-\u9fa5]/.test(missing.msg), missing)
  delete process.env.ASR_PYTHON

  // 6) 文档/提示里能查到能力来源
  const src = readFileSync(ROOT + '/packages/server/src/capabilities/capabilities/asr.ts', 'utf8')
  chk('asr.ts 使用 ffmpeg 抽 16k 单声道', src.includes('16000') && src.includes('pcm_s16le'))
  chk('asr.ts 有 SSRF 守卫（复用 prepareSource）', src.includes('prepareSource'))
  chk('asr.ts 有超时保护', src.includes('ASR_TIMEOUT_MS'))

  console.log('ASR SMOKE ' + (fail === 0 ? 'OK' : 'FAILED') + ' (' + pass + ' checks, ' + fail + ' failed)')
  if (fail > 0) process.exitCode = 1
}

main().catch((e) => {
  console.log('  FAIL 未捕获异常 → ' + String((e && e.stack) || e))
  console.log('ASR SMOKE FAILED')
  process.exitCode = 1
})
