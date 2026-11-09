#!/usr/bin/env node
/**
 * P32 评论回复桌面端接线静态检查：
 * 驱动选择器 → platform.ts 快照/回复方法 → IPC → preload → 渲染层 UI → 样式。
 * 用法：node scripts/check-desktop-p32.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..')
const desktop = path.join(root, 'packages', 'desktop', 'src')
const f = {
  drivers: path.join(desktop, 'main', 'platform-drivers.ts'),
  platform: path.join(desktop, 'main', 'platform.ts'),
  main: path.join(desktop, 'main', 'index.ts'),
  preload: path.join(desktop, 'preload', 'index.ts'),
  types: path.join(desktop, 'renderer', 'src', 'types.ts'),
  page: path.join(desktop, 'renderer', 'src', 'pages', 'PlatformPublish.tsx'),
  styles: path.join(desktop, 'renderer', 'src', 'styles.css')
}

let checks = 0
let failed = 0
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
function check(name, ok, detail) {
  checks += 1
  if (ok) console.log('[PASS] ' + name)
  else {
    failed += 1
    console.log('[FAIL] ' + name + (detail ? ' :: ' + detail : ''))
  }
}

const drivers = read(f.drivers)
const platform = read(f.platform)
const main = read(f.main)
const preload = read(f.preload)
const types = read(f.types)
const page = read(f.page)
const styles = read(f.styles)

// 1. 驱动
check('驱动声明 commentsUrl', /commentsUrl:\s*string/.test(drivers))
check('驱动声明 commentItems / commentReplyButton / commentReplyInput / commentSendButton',
  ['commentItems', 'commentReplyButton', 'commentReplyInput', 'commentSendButton'].every((k) => drivers.includes(k + ': string[]')))
check('抖音配了评论管理页', drivers.includes("commentsUrl: 'https://creator.douyin.com/creator-micro/interaction/comment'"))
check('小红书配了评论管理页', drivers.includes('creator.xiaohongshu.com/new/interaction'))
check('视频号配了评论管理页', drivers.includes('channels.weixin.qq.com/platform/interaction/comment'))
check('导出 COMMENT_TEXT_MAX', drivers.includes('export const COMMENT_TEXT_MAX'))
check('导出扫描脚本生成器', drivers.includes('export function scanCommentsScript'))
check('导出点回复脚本生成器', drivers.includes('export function clickReplyScript'))
check('导出回复结果探针', drivers.includes('export function replyOutcomeScript'))

// 2. platform.ts
check('platform.ts 引入评论脚本生成器', platform.includes('scanCommentsScript') && platform.includes('clickReplyScript'))
check('导出 PlatformCommentsSnapshot', platform.includes('export interface PlatformCommentsSnapshot'))
check('导出 PlatformReplyResult', platform.includes('export interface PlatformReplyResult'))
check('实现 comments()', /async comments\(platform: string/.test(platform))
check('comments() 打不开评论页会回落首页', platform.includes("this.log('[' + id + '] 评论页打不开，回落到首页：'"))
check('comments() 先判登录态', /comments-login/.test(platform))
check('实现 replyComment()', /async replyComment\(/.test(platform))
check('replyComment 校验空内容', platform.includes("result.message = '回复内容不能为空'"))
check('replyComment 校验字数上限', platform.includes('最多 ' + "' + COMMENT_TEXT_MAX + '" + ' 字'))
check('replyComment 要求 index 或 match', platform.includes("请指定要回复哪条评论"))
check('replyComment 有未登录中文提示', platform.includes('请先在「发布」页点「扫码登录」完成登录'))
check('replyComment 复用 fillField 填内容', /this\.fillField\(w, id, '回复'/.test(platform))
check('replyComment 未命中发送按钮给中文错误', platform.includes('没找到发送按钮'))
check('replyComment 有结果确认步骤', platform.includes('确认回复结果'))
check('replyComment 落截图（复用 shot）', platform.includes("'reply-' + name"))

// 3. IPC / preload
check('main 注册 platform:comments', main.includes("ipcMain.handle('platform:comments'"))
check('main 注册 platform:reply-comment', main.includes("ipcMain.handle('platform:reply-comment'"))
check('preload 透出 comments', preload.includes("invoke('platform:comments'"))
check('preload 透出 replyComment', preload.includes("invoke('platform:reply-comment'"))

// 4. types
check('types 定义 PlatformCommentsSnapshot', types.includes('export type PlatformCommentsSnapshot'))
check('types 定义 PlatformReplyResult', types.includes('export type PlatformReplyResult'))
check('types 暴露 comments 桥', types.includes('comments: (p: { platform: string; maxItems?: number })'))
check('types 暴露 replyComment 桥', types.includes('replyComment: (p: { platform: string; index?: number; match?: string; text: string })'))

// 5. 渲染层
check('发布页有读评论按钮', page.includes('读评论'))
check('发布页调 platform.comments', page.includes('window.fcm.platform.comments({ platform: id'))
check('发布页调 platform.replyComment', page.includes('window.fcm.platform.replyComment({ platform: id, index, text })'))
check('发布页复用 withTimeout 防挂死', page.includes("'读取评论超时（窗口可能已关闭），请重试'"))
check('发布页逐条渲染评论', page.includes('platform-comment-list') && page.includes('comments.items.map'))
check('发布页显示回复步骤', page.includes('replyResult.steps'))
check('发布页提示 index 定位语义', page.includes('回复是按「第几条」定位的'))
check('样式包含评论区块', styles.includes('.platform-comment-item') && styles.includes('.platform-comment-reply'))

if (failed) {
  console.error('P32 desktop check FAILED (' + checks + ' checks, ' + failed + ' failed)')
  process.exit(1)
}
console.log('P32 desktop check OK (' + checks + ' checks)')
