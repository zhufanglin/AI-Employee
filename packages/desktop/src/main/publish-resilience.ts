/**
 * 定时发布韧性策略（P26+）：
 *   - 瞬时失败判定：只有「超时 / 页面没有响应 / ERR_ABORTED / net:: / 加载失败 / target closed」
 *     这类环境性故障才自动重试；「未登录 / 未选中图片 / 标题过长」这类业务失败一次就停。
 *   - 失败阶段归类：publish() 没有单独的 stage 字段，这里优先用它的 steps（最后一步失败的那条）
 *     推断「上传 / 填写 / 提交 / 判定」，再回落到失败文案关键词。
 *   - 自动重试参数：同一平台最多再试 PLATFORM_RETRY_TIMES 次，每次前等 PLATFORM_RETRY_DELAY_MS。
 *
 * 本文件刻意不依赖 Electron 和 node:fs，纯函数，便于自测脚本直接加载断言。
 */

/** 同一平台失败后最多自动重试几次（与整条 job 的 attempts / MAX_ATTEMPTS 是两套机制） */
export const PLATFORM_RETRY_TIMES = 1
/** 自动重试前的等待时间：给平台页面/上传器一点恢复时间 */
export const PLATFORM_RETRY_DELAY_MS = 8 * 1000
/** publish() 既没有 stage 也没有可归类的 steps 时的兜底阶段 */
export const DEFAULT_PUBLISH_STAGE = '提交'

/** 稳定的业务失败：出现这些词一律不重试（重试也不会变好，还会重复占用平台窗口） */
const STABLE_PATTERNS: RegExp[] = [
  /未登录|没有登录|还没有登录/,
  /未选中图片|没有选中图片|请先选择素材|请选择素材/,
  /标题过长|标题超长|标题太长/,
  /暂不支持|不支持发布/
]

/**
 * 瞬时失败特征。命中任意一条就认为值得再试一次。
 * 顺序只用于日志归类，不影响判定。
 */
const TRANSIENT_PATTERNS: Array<{ pattern: RegExp; kind: string }> = [
  { pattern: /超时|timed?\s*out/i, kind: '超时' },
  { pattern: /页面没有响应|页面无响应|没有响应|unresponsive/i, kind: '页面没有响应' },
  { pattern: /ERR_ABORTED/i, kind: 'ERR_ABORTED' },
  { pattern: /net::/i, kind: 'net::' },
  {
    pattern: /加载失败|加载超时|failed to load|ERR_FAILED|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/i,
    kind: '加载失败'
  },
  { pattern: /target closed|target page, context or browser has been closed|Object has been destroyed/i, kind: 'target closed' }
]

function messageText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value instanceof Error) return value.message.trim()
  if (value && typeof value === 'object' && typeof (value as any).message === 'string') {
    return String((value as any).message).trim()
  }
  return ''
}

/** 命中的瞬时故障类型；不是瞬时失败返回空字符串。 */
export function transientErrorKind(message: unknown): string {
  const raw = messageText(message)
  if (!raw) return ''
  // 业务失败优先：即使文案里带了「超时」之类的词（例如「标题过长」不会，但保持防御），也不重试。
  if (STABLE_PATTERNS.some((pattern) => pattern.test(raw))) return ''
  for (const item of TRANSIENT_PATTERNS) {
    if (item.pattern.test(raw)) return item.kind
  }
  return ''
}

/** 是否值得自动重试（单看失败文案，不看尝试次数）。 */
export function isTransientPublishError(message: unknown): boolean {
  return transientErrorKind(message) !== ''
}

/**
 * 是否还有自动重试额度：只对「未成功 + 瞬时特征 + 还有次数」返回 true。
 * 次数从 0 开始算：0 表示还没重试过。
 */
export function shouldRetryPlatform(
  retriedTimes: number,
  result: { ok?: boolean; message?: unknown; error?: unknown } | null | undefined
): boolean {
  if (!result || result.ok === true) return false
  const used = Number(retriedTimes) || 0
  if (used >= PLATFORM_RETRY_TIMES) return false
  return isTransientPublishError(result.error !== undefined && result.error !== null && result.error !== '' ? result.error : result.message)
}

/** 步骤名 → 失败阶段。'切换/打开' 算准备，登录单独一类，其余按语义归类。 */
const STAGE_BY_STEP: Array<{ pattern: RegExp; stage: string }> = [
  { pattern: /检查登录|扫码登录|登录状态/, stage: '登录' },
  { pattern: /打开创作后台|切换到发布方式|切换发布方式|打开后台/, stage: '准备' },
  { pattern: /上传/, stage: '上传' },
  { pattern: /填写|标题|正文|联想|定时发布/, stage: '填写' },
  { pattern: /等待发布结果|发布结果|判定|结果/, stage: '判定' },
  { pattern: /点击发布|补点发布|提交/, stage: '提交' }
]

const STAGE_BY_MESSAGE: Array<{ pattern: RegExp; stage: string }> = [
  { pattern: /未登录|没有登录|还没有登录|扫码登录/, stage: '登录' },
  { pattern: /上传|素材|文件|图片|视频/, stage: '上传' },
  { pattern: /标题|正文|填写|内容|字数/, stage: '填写' },
  { pattern: /发布结果|判定|跳转|成功提示|没有响应/, stage: '判定' },
  { pattern: /点击发布|发布按钮|提交/, stage: '提交' }
]

function matchStage(table: Array<{ pattern: RegExp; stage: string }>, text: string): string {
  for (const item of table) {
    if (item.pattern.test(text)) return item.stage
  }
  return ''
}

function stepNameOf(step: any): string {
  if (!step || typeof step !== 'object') return ''
  return messageText(step.step)
}

/**
 * 推断失败阶段：
 *   1) publish() 若已经返回非空 stage，直接透传（platform.ts 目前没有，但保留兼容）；
 *   2) 否则看 steps 里最后一条 ok=false 的步骤名；
 *   3) 再否则看失败文案关键词；
 *   4) 都没有就给通用值「提交」。
 */
export function derivePublishStage(steps: unknown, message?: unknown): string {
  const list = Array.isArray(steps) ? steps : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const step = list[i] as any
    if (!step || typeof step !== 'object' || step.ok !== false) continue
    const stage = matchStage(STAGE_BY_STEP, stepNameOf(step))
    if (stage) return stage
  }
  const raw = messageText(message)
  if (raw) {
    const stage = matchStage(STAGE_BY_MESSAGE, raw)
    if (stage) return stage
  }
  return DEFAULT_PUBLISH_STAGE
}
