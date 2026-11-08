/**
 * P24 平台发布 RPA：抖音 / 小红书 / 视频号 创作后台的选择器与纯函数。
 *
 * 重要：下列选择器是按三个平台 2024-2025 年前端结构推测的候选值，尚未真机校准。
 * Electron 页面里没有 playwright 的 :has-text 伪类，文本匹配统一写成 'text=发布'
 * 这种自定义写法，由 platform.ts 用 textContent 兜底匹配。
 * 每个候选数组按可信度从高到低排列，全部命中失败时 platform.ts 会抛「选择器未命中」。
 */

export type PlatformId = 'douyin' | 'xiaohongshu' | 'shipinhao'
export type MediaType = 'video' | 'image'

export interface PlatformDriver {
  name: string
  homeUrl: string
  loginUrlHint: string
  fileInput: string[]
  titleInput: string[]
  contentInput: string[]
  submitButton: string[]
  successHint: string[]
  loggedInCookies?: string[]
  /** 已登录才会出现的页面文案（0.1.11：用来做登录态的正向证据，避免空白页被误判成已登录） */
  loggedInCues: string[]
  /** 作品数据页（0.1.11：P25 取数用，打不开就回落到 homeUrl） */
  dataUrl: string
}

export const DRIVERS: Record<PlatformId, PlatformDriver> = {
  douyin: {
    name: '抖音',
    homeUrl: 'https://creator.douyin.com/creator-micro/content/upload',
    loginUrlHint: 'https://creator.douyin.com/',
    fileInput: ['input[type="file"]', '.upload-btn-input', 'input[accept*="video"]', 'input[accept*="image"]'],
    titleInput: ['.semi-input', 'input[placeholder*="标题"]', 'input[placeholder*="作品标题"]', '.title-input input'],
    contentInput: ['.zone-container', '[contenteditable="true"]', '.editor-kit-container [contenteditable]'],
    submitButton: ['text=发布', '.content-confirm-container button', 'button[type="submit"]'],
    successHint: ['发布成功', '作品发布成功', '发布完成', '已发布'],
    loggedInCookies: ['sessionid', 'sessionid_ss', 'sid_tt', 'passport_csrf_token'],
    loggedInCues: ['发布作品', '上传视频', '作品管理', '创作灵感', '数据概览'],
    dataUrl: 'https://creator.douyin.com/creator-micro/data/content'
  },
  xiaohongshu: {
    name: '小红书',
    homeUrl: 'https://creator.xiaohongshu.com/publish/publish',
    loginUrlHint: 'https://creator.xiaohongshu.com/login',
    fileInput: ['input[type="file"]', '.upload-input', 'input[accept*="video"]', 'input[accept*="image"]'],
    titleInput: ['input[placeholder*="标题"]', '.d-text', 'input[placeholder*="填写标题"]', '.title-input input'],
    contentInput: ['.ql-editor', '[contenteditable="true"]', '.editor-content', '.publish-editor [contenteditable]'],
    submitButton: ['text=发布', '.publishBtn', 'button[class*="publish"]'],
    successHint: ['发布成功', '笔记发布成功', '发布完成', '已发布'],
    loggedInCues: ['发布笔记', '上传图文', '笔记管理', '数据看板'],
    dataUrl: 'https://creator.xiaohongshu.com/new/statistics/data'
  },
  shipinhao: {
    name: '视频号',
    homeUrl: 'https://channels.weixin.qq.com/platform/post/create',
    loginUrlHint: 'https://channels.weixin.qq.com/platform',
    fileInput: ['input[type="file"]', '.weui-desktop-upload__input', 'input[accept*="video"]', 'input[accept*="image"]'],
    titleInput: ['input[placeholder*="标题"]', 'input[placeholder*="填写标题"]', '.weui-desktop-form__input'],
    contentInput: ['.input-editor', '[contenteditable="true"]', '.weui-desktop-editor', '.post-desc [contenteditable]'],
    submitButton: ['text=发表', '.weui-desktop-btn_primary', 'button[class*="primary"]'],
    successHint: ['发表成功', '发布成功', '发表完成', '已发表'],
    loggedInCues: ['发表动态', '上传视频', '内容管理', '数据中心'],
    dataUrl: 'https://channels.weixin.qq.com/platform/statistics'
  }
}

/** 平台清单：渲染层与 status() 默认遍历用 */
export const PLATFORMS: { id: PlatformId; name: string; homeUrl: string; types: MediaType[] }[] = [
  { id: 'douyin', name: '抖音', homeUrl: DRIVERS.douyin.homeUrl, types: ['video', 'image'] },
  { id: 'xiaohongshu', name: '小红书', homeUrl: DRIVERS.xiaohongshu.homeUrl, types: ['video', 'image'] },
  { id: 'shipinhao', name: '视频号', homeUrl: DRIVERS.shipinhao.homeUrl, types: ['video', 'image'] }
]

/** 标题字数上限（按字符数 Array.from 计，中文/emoji 各算 1 个） */
export const TITLE_LIMITS: Record<string, number> = { douyin: 30, xiaohongshu: 20, shipinhao: 16 }

/** 正文 + 空格 + '#tag1 #tag2'；标签去掉首尾 #、去空、去重、最多 10 个 */
export function buildContent(content: string, tags?: string[]): string {
  const body = typeof content === 'string' ? content.trim() : ''
  const clean: string[] = []
  const list = Array.isArray(tags) ? tags : []
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim().replace(/^#+/, '').replace(/#+$/, '').trim()
    if (!tag) continue
    if (clean.indexOf(tag) >= 0) continue
    clean.push(tag)
    if (clean.length >= 10) break
  }
  const tagText = clean.map((t) => '#' + t).join(' ')
  return [body, tagText].filter(Boolean).join(' ').trim()
}

/** 标题按平台上限截断（Array.from 按字符数，不是 UTF-16 码元） */
export function clampTitle(platform: string, title?: string): string {
  const raw = typeof title === 'string' ? title.trim() : ''
  if (!raw) return ''
  const limit = TITLE_LIMITS[platform] || 30
  return Array.from(raw).slice(0, limit).join('')
}

/** 平台是否支持指定发布类型 */
export function platformSupports(platform: string, type: string): boolean {
  const row = PLATFORMS.find((p) => p.id === platform)
  return !!row && row.types.indexOf(type as MediaType) >= 0
}
