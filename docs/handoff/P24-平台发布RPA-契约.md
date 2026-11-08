# P24 平台发布（RPA）契约

> 目标：在**用户本机**用 Electron 内嵌浏览器登录 抖音 / 小红书 / 视频号 创作后台，自动完成「上传素材 → 填标题正文话题 → 点发布」，并把结果回给员工任务。**全自动，无人工审核。**
> 不在服务器上跑：生产机在美国机房，IP 会被平台风控；本机是用户真实网络与真实账号。

## 0. 平台标识
| 平台 | id | 创作后台 | 发布类型 |
| --- | --- | --- | --- |
| 抖音 | `douyin` | https://creator.douyin.com/creator-micro/content/upload | video / image(图文) |
| 小红书 | `xiaohongshu` | https://creator.xiaohongshu.com/publish/publish | video / image(图文) |
| 视频号 | `shipinhao` | https://channels.weixin.qq.com/platform/post/create | video / image |

## 1. 主进程模块 `packages/desktop/src/main/platform.ts`（子 Agent A 交付）
导出：

```ts
export interface PlatformManagerDeps {
  userDataDir: string           // app.getPath('userData')
  log?: (msg: string) => void
  onEvent?: (e: { platform: string; type: string; message: string; at: string }) => void
}
export interface PlatformStatus { platform: string; name: string; loggedIn: boolean; nickname?: string; checkedAt: string; error?: string }
export interface PublishInput {
  platform: 'douyin' | 'xiaohongshu' | 'shipinhao'
  type: 'video' | 'image'
  title?: string            // 抖音标题 ≤30 字；小红书标题 ≤20 字
  content: string           // 正文（可含 #话题）
  tags?: string[]           // 不带 #，模块自动拼到正文尾部
  mediaPaths: string[]      // 本机绝对路径。video: 1 个 mp4；image: 1-9 张 jpg/png
  scheduledAt?: string      // ISO，留空=立即发布；平台不支持时忽略并返回 warning
}
export interface PublishResult { platform: string; ok: boolean; message: string; url?: string; screenshots: string[]; steps: { step: string; ok: boolean; detail?: string }[] }

export class PlatformManager {
  constructor(deps: PlatformManagerDeps)
  status(platform?: string): Promise<PlatformStatus[]>       // 逐个打开隐藏窗口检查登录态
  login(platform: string): Promise<PlatformStatus>           // 打开可见窗口让用户扫码，轮询登录成功（最长 180s）
  logout(platform: string): Promise<void>                    // 清 partition 存储
  publish(input: PublishInput): Promise<PublishResult>
  openDebug(platform: string): Promise<void>                 // 打开可见窗口，方便用户手动处理滑块/验证码
}
```

要求：
1. 每个平台一个持久化 partition：`persist:platform-<id>`，登录态就存在那里（用户扫码一次，之后复用）。
2. **不新增 npm 依赖**。上传文件用 Electron 内建 CDP：
   `webContents.debugger.attach('1.3')` → `DOM.getDocument` → `DOM.querySelector` → `DOM.setFileInputFiles({ files, nodeId })`，用完 `debugger.detach()`。
3. 填标题/正文：`Runtime.evaluate` 聚焦目标元素 → `Input.insertText`（中文必须走 insertText，`Input.dispatchKeyEvent` 会丢字）。contenteditable 用 `document.execCommand('insertText')` 兜底。
4. 每一步失败都要**截图**存 `<userDataDir>/platform-logs/<platform>-<ts>-<step>.png`（`capturePage().toPNG()` 写文件），并在 `steps` 里记 `{step, ok:false, detail}`，便于我按截图改选择器。
5. 选择器一律写成**候选数组**（见 `platform-drivers.ts`），按顺序尝试；全部失败抛带「选择器未命中」字样的错误。
6. 登录判定：进入创作后台后检查是否被重定向到登录页/DOM 里是否有登录二维码。抖音用 `document.cookie` 含 `sessionid`；小红书/视频号用页面出现「未登录/扫码登录」即视为未登录，否则视为已登录。
7. 所有窗口默认 `show:false`（除 login/openDebug），设 `contextIsolation:true, nodeIntegration:false`，`setWindowOpenHandler` 一律 deny。
8. 发布成功后尽量从页面读到作品链接（找 `a[href*="/video/"]` 等），读不到就让 `url` 为空但 `ok:true`。

## 2. 选择器配置 `packages/desktop/src/main/platform-drivers.ts`（子 Agent A 交付）
纯数据 + 纯函数，便于单测：
```ts
export const DRIVERS: Record<string, {
  name: string; homeUrl: string; loginUrlHint: string;
  fileInput: string[]; titleInput: string[]; contentInput: string[];
  submitButton: string[]; successHint: string[]; loggedInCookies?: string[];
}>
export function buildContent(content: string, tags?: string[]): string   // 正文 + 空格 + '#tag1 #tag2'
export function clampTitle(platform: string, title?: string): string    // 抖音 30 / 小红书 20 / 视频号 16 字截断
```

## 3. IPC（我负责接线，子 Agent 只需按此签名提供 PlatformManager）
| 通道 | 入参 | 返回 |
| --- | --- | --- |
| `platform:status` | `{ platform?: string }` | `PlatformStatus[]` |
| `platform:login` | `{ platform }` | `PlatformStatus` |
| `platform:logout` | `{ platform }` | `{ ok: true }` |
| `platform:publish` | `PublishInput` | `PublishResult` |
| `platform:open-debug` | `{ platform }` | `{ ok: true }` |

## 4. 员工工具（本机执行拦截）
工具名：`platform_publish`、`platform_status`、`platform_stats`（stats 可先只返回「暂未实现」）。
- 服务端 `packages/server/src/capabilities/capabilities/platform-tools.ts` 只提供 **descriptor**，handler 直接抛 `BadRequestException("平台发布需要在桌面端（本机）执行，请在客户端登录平台后再试")`。
- 桌面主进程 `api()` 拦截 `/capabilities/run`：name 命中上面三个时，本机执行并返回 `{ success: true, data }` / `{ success: false, error }`，**不发网络请求**。
- 云执行器（生产 worker）调用这三个会拿到上面那句中文错误，模型应据此向用户说明需要打开客户端。

## 5. 渲染层页面
`packages/desktop/src/renderer/src/pages/PlatformPublish.tsx`：三张平台卡（登录状态 / 扫码登录 / 打开调试窗口）+ 发布表单（平台、类型、标题、正文、标签、素材路径选择）+ 结果区（步骤列表 + 截图路径）。侧栏 🧠 记忆 下方新增「📤 平台发布」。

## 6. 文件边界
- 子 Agent A：只新建 `packages/desktop/src/main/platform.ts`、`packages/desktop/src/main/platform-drivers.ts`、`scripts/smoke-p24-platform-drivers.mjs`（纯函数单测，用 node 跑，不依赖 electron）。
- 子 Agent B：只新建 `packages/server/src/capabilities/capabilities/platform-tools.ts`、`scripts/smoke-p24-platform-tools.mjs`（descriptor 校验）。
- 禁止改动：`main/index.ts`、`preload/index.ts`、`executor.ts`、`Shell.tsx`、`capability.service.ts`、`worker/tool-loop.mjs`、`verify.ps1`、任何 `package.json`（接线由我做）。
