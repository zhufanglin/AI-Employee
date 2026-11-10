# P36：platform:status 报 TypeError: Object has been destroyed

> 0.1.20 修复。用户报错原文（2026-11-10）：
> `Error invoking remote method 'platform:status': TypeError: Object has been destroyed`

## 1. 现象

客户端「平台发布」页刷登录态时，界面上直接弹出 Electron 原始英文错误。这是主进程抛出的异常
原样穿过 IPC 到渲染层 —— 界面上不应该出现这种错误。

## 2. 代码路径与可疑点

`packages/desktop/src/main/platform.ts`

- `status(platform?, opts)`（约 :614）：`ids.map` 并行，每个平台 `runExclusive(id, () => this.checkStatus(id))`，
  外层只有 `Promise.all(jobs)`，**没有任何 try/catch** ⇒ `checkStatus` 抛什么，IPC 就收到什么。
- `checkStatusFresh`（约 :1494）整段有 try/catch，但 **finally 里是裸调用**：
  `if (driver.needsVisibleWindow && win) win.hide(); this.closeWindow(win)`。
  `finally` 里抛出的异常会**覆盖已 return 的结果**并一路冒到 IPC。
  对已销毁的 BrowserWindow 调 `hide()` / `showInactive()` / `isVisible()`，Electron 抛的正是
  `TypeError: Object has been destroyed`。
- `evalPage`（约 :1351）直接访问 `win.webContents.debugger`，没先判 `isDestroyed()`。
- 同类裸调用散布在 `stats()`、`comments()`、`replyComment()`、`doPublish()` 的 finally 里。

## 3. 复现尝试（未能稳定复现，如实记录）

新增两个探针：`_probe/expr-status-force.mjs`（调 `window.fcm.platform.status({force:true})` 并记录
耗时/异常）、`_probe/expr-close-self.mjs`（在平台页 `window.close()`）。
流程：开 9222 → `openDebug({platform:'shipinhao'})` → 后台发起 status → 3 秒后在平台页面 target 上执行
`window.close()`。**新旧构建都返回了正常结果**（诊断里 shipinhao 只是「页面没有响应」）：
页面 `window.close()` 只关掉了页面 target，BrowserWindow 本体没有被销毁，所以 finally 的 `hide()` 不会抛。

结论：触发点大概率是「用户点窗口的 X / 应用退出时 disposeAll 销毁了常驻窗口，而 status 还在飞」这种
**主进程侧真正 destroy 窗口**的竞态，用渲染层探针复现不出来。既然触发点无法稳定复现，就把修复做成
**无论哪条路径都不许把未处理的 Electron 异常冒到界面**，同时在后台留下堆栈，下次真发生能直接定位。

## 4. 修复

### 4.1 platform.ts
1. 新增 `private safeShowInactive(win)` / `private safeHide(win)`：先判 `isDestroyed()`，再整体 try/catch。
   把所有裸的 `win.hide()` / `win.showInactive()` / `win.isVisible() && win.hide()` 全部替换掉
   （stats / comments / replyComment / checkStatus / doPublish / mouseClickAt / openDebug 的 focus）。
2. `status()`：每个平台的 job 外面加 try/catch，异常降级成
   `{loggedIn:false, error:'登录态检查失败：…'}`，并写日志 `[id] 登录态检查异常：…`、清掉该平台缓存。
3. `evalPage()`：入口先 `if (!win || win.isDestroyed()) throw new Error('窗口已关闭')`，
   把 Electron 英文 TypeError 换成项目自己的中文错误（上层 `.catch(() => null)` 就能按预期处理）。

### 4.2 index.ts（最后的兜底）
新增 `guardPlatform(name, fn)`，包住全部 `platform:*` IPC（warm/status/login/logout/publish/stats/
comments/reply-comment/open-debug）：出错先往 `<userData>/platform-logs/run.log` 追一行
`[ipc] <name> 失败：<stack>`，再把错误换成人话：
`平台窗口已关闭或渲染进程已退出（…），请点「刷新登录状态」重试`。

### 4.3 顺带修掉的真 bug：抖音永远显示「未登录」
排查中发现 `sessionCookieNames()` 里写的是 `session.fromPartition(this.partition(platform))`，
而类里根本没有 `partition()` 方法（只有 `partitionOf()`）⇒ 每次抛 TypeError 被 catch 吞掉，
返回空数组；再叠加 P35 引入的「cookie 权威」判定，**抖音只要被查到就判未登录**。
run.log 里留有实证：
```
2026-11-10T05:24:48.532Z [douyin] 读取分区 cookie 失败：this.partition is not a function
```
修法：
- `session.fromPartition(this.partitionOf(platform))`
- `judgeLoginAsync` 中「cookie 读到 0 条」不再当成「没有会话 cookie」，退回页面文案判定
  （分区还没起来/读失败时不会再误判未登录）。

修复后真机 `platform.status({force:true})`：
```
douyin      loggedIn=true                     ← 修前恒为 false
xiaohongshu loggedIn=true  nickname=创作服务平台
shipinhao   loggedIn=false error=未检测到登录态，请扫码登录…   ← 会话本身过期，需用户重新扫码
```

## 5. 验证

- 真机 `platform.status({force:true})` 正常返回三平台结果（不是抛错）。
- 真机 `platform.login({platform:'nope'})` → 中文错误「未知平台：nope（只支持 douyin / xiaohongshu / shipinhao）」；
  `status({platform:'nope'})` → 降级对象（不抛）。
- 回归：`smoke-p24-platform-drivers` 67 / `check-desktop-p24` 95（新增 4 项守卫断言）/
  `check-desktop-p32` 40 / `smoke-p32-comments` 47 / `check-desktop-p13` 3 全 PASS；
  全量 `scripts/verify.ps1 -Smoke` GREEN。

## 6. 遗留

- 视频号会话已过期，需要用户客户端重新扫码登录一次（抖音、小红书当前都是已登录）。
- 若再出现同类报错：`%APPDATA%\中科元晟 AI员工\platform-logs\run.log` 里会有 `[ipc] <name> 失败：<堆栈>` 一行，
  直接看堆栈就能定位到具体是哪次调用。
