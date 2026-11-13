param(
  [switch]$Smoke,
  [switch]$SkipDesktop
)
$ErrorActionPreference = "Continue"
$repo = if ($PSCommandPath) { Split-Path -Parent (Split-Path -Parent $PSCommandPath) } else { (Get-Location).Path }
Set-Location $repo
$node = "C:\Users\30290\Desktop\REA逆向\toolchain\node-v24.22.1-win-x64\node.exe"
if (-not (Test-Path $node)) { $node = "C:\node.exe" }
$script:fail = 0
$script:code = 0
$script:steps = @()
# 把 packages\server\.env 注入当前进程（smoke 脚本直接读环境变量，如 DATABASE_URL）
$envFile = Join-Path $repo "packages\server\.env"
if (Test-Path $envFile) {
  foreach ($row in (Get-Content $envFile -Encoding utf8)) {
    $t = $row.Trim()
    if (-not $t -or $t.StartsWith("#") -or $t.IndexOf("=") -lt 1) { continue }
    $k = $t.Substring(0, $t.IndexOf("=")).Trim()
    $v = $t.Substring($t.IndexOf("=") + 1).Trim().Trim('"')
    if ($k -and -not [Environment]::GetEnvironmentVariable($k)) { Set-Item -Path ("Env:" + $k) -Value $v }
  }
}

function Step([string]$name, [scriptblock]$block) {
  Write-Host ""
  Write-Host "=== $name ===" -ForegroundColor Cyan
  $script:code = 0
  $sw = [Diagnostics.Stopwatch]::StartNew()
  & $block
  $sw.Stop()
  if ($script:code -eq 0) { Write-Host ("[OK]   {0} ({1}s)" -f $name, [int]$sw.Elapsed.TotalSeconds) -ForegroundColor Green }
  else { Write-Host ("[FAIL] {0} (exit {1}, {2}s)" -f $name, $script:code, [int]$sw.Elapsed.TotalSeconds) -ForegroundColor Red; $script:fail++ }
  $script:steps += [pscustomobject]@{ name = $name; ok = ($script:code -eq 0); exit = $script:code; seconds = [int]$sw.Elapsed.TotalSeconds }
}

Step "server tsc" {
  Push-Location "packages\server"
  & $node "..\..\node_modules\typescript\bin\tsc" -p tsconfig.json
  $script:code = $LASTEXITCODE
  Pop-Location
}

if (-not $SkipDesktop) {
  Step "desktop electron-vite build" {
    Push-Location "packages\desktop"
    & $node "..\..\node_modules\electron-vite\bin\electron-vite.js" build
    $script:code = $LASTEXITCODE
    Pop-Location
  }
}

if ($Smoke) {
  Step "server restart (fresh dist, kill stale :3000)" {
    $conns = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    $outLog = Join-Path $repo "_srv_out.log"
    $errLog = Join-Path $repo "_srv_err.log"
    # 冒烟用本地模拟支付（不触发真实微信下单）；仅对本进程启动的服务端生效
    $env:WECHAT_PAY_MOCK = "1"
    # 冒烟账号是随机手机号：全放开 dev 验证码（只对本进程启动的服务端生效，生产不用这套）
    $env:DEV_SMS_ALLOWLIST = "*"
    $env:DEV_RETURN_SMS_CODE = "true"
    Start-Process -FilePath $node -ArgumentList "dist/main.js" -WorkingDirectory (Join-Path $repo "packages\server") -RedirectStandardOutput $outLog -RedirectStandardError $errLog | Out-Null
    $healthy = $false
    for ($i = 0; $i -lt 45; $i++) {
      try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 2
        if ($resp.status -eq "ok") { $healthy = $true; break }
      } catch { }
      Start-Sleep -Seconds 2
    }
    if (-not $healthy) {
      Write-Host "server did not become healthy; stderr:" -ForegroundColor Red
      Get-Content $errLog -Encoding utf8 -Tail 40
      $script:code = 1
    }
  }

  Step "unit: 员工工具循环 JSON 容错" {
    Push-Location (Join-Path $repo "packages\worker")
    & $node "--test" "tool-loop-parse.test.mjs"
    $script:code = $LASTEXITCODE
    Pop-Location
  }
  Step "unit: web_extract SSRF 守卫" {
    & $node "--test" "packages\server\src\capabilities\capabilities\web-extract-guard.test.cjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: T-11 渠道加解密骨架" {
    & $node "scripts\smoke-channels.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: T-11 个人微信入站链路" {
    & $node "scripts\smoke-t11-personal-inbound.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: T-11 渠道结果回推" {
    & $node "scripts\smoke-t11-channel-push.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: T-11 长结果页（全文链接）" {
    & $node "scripts\smoke-t11-result-page.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: P45 合规文本（协议/隐私/AIGC 标识）" {
    & $node "scripts\smoke-legal.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: P45 同意记录（含跨境单独同意）" {
    & $node "scripts\smoke-p45-consent.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: P45-4 举报与投诉工单" {
    & $node "scripts\smoke-p45-report.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: P46 语音转写能力" {
    & $node "scripts\smoke-p46-asr.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: P46 团队编排能力" {
    & $node "scripts\smoke-p46-team.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: P46 并发调度" {
    & $node "scripts\smoke-p46-concurrency.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: P47 产物登记" {
    & $node "scripts\smoke-p47-artifacts.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: P47 渠道降级提示" {
    & $node "scripts\smoke-p47-channel-degrade.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: P47 toolapi 兜底标记" {
    & $node "scripts\smoke-p47-toolapi.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: P47 桌面体验修复" {
    & $node "scripts\smoke-p47-ui.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: P48 来源核对（可信引用）" {
    & $node "scripts\smoke-p48-source-check.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: P49 定价体系（成本驱动）" {
    & $node "scripts\smoke-p49-pricing.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: W2" {
    & $node "scripts\smoke-w2.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: W2 计费隔离" {
    & $node "scripts\smoke-w2-billing.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: M6.5" {
    & $node "scripts\smoke-m65.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: T-36 员工技能原文" {
    & $node "scripts\smoke-t36.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: P42 战略与人设" {
    & $node "scripts\smoke-p42-strategy.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: P43 逆向修复（计费/幂等/状态机/匿名市场）" {
    & $node "scripts\smoke-p43-p0p1.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: P43 对话持久化与会话列表" {
    & $node "scripts\smoke-p43-chat.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: P43 P1 剩余 7 条（配置接库/热更新/日志/驳回重跑）" {
    & $node "scripts\smoke-p43-p1.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: P43 员工到期自动扫描" {
    & $node "scripts\smoke-p43-expiry.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: T-12 支付与后台" {
    & $node "scripts\smoke-t12.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: T-08 套餐与订单" {
    & $node "scripts\smoke-t08.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: T-14 管理端扩展" {
    & $node "scripts\smoke-t14.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: T-29 运营后台" {
  & $node "scripts\smoke-admin-ui.mjs"
  $script:code = $LASTEXITCODE
}

Step "smoke: T-19 员工执行器" {
    & $node "scripts\smoke-t19.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: T-30 媒体编排" {
    & $node "scripts\smoke-t30.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: T-33 媒体成本护栏（模拟上游）" {
    & $node "scripts\smoke-t33.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: 媒体任务取消与退款" {
    & $node "scripts\smoke-media-cancel.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: T-32 员工多步执行（模拟模型和媒体）" {
    & $node "scripts\smoke-t32-loop.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-t32.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-t32-worker.mjs"
    $script:code = $LASTEXITCODE
  }
  Step "smoke: T-28 本地能力层" {
    & $node "scripts\smoke-web-safety.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-capabilities.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-p11-tools.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-p12-files.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-p16-web-tools.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-p16-doc-write.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-p16-media.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-p17-vision.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-p17-employee-tools.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-p18-memory.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-p19-memory-semantic.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-p20-memory.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-p21-memory-dedupe.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-p22-memory-cleanup.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-p23-memory-api.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\check-desktop-p23.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-p24-platform-drivers.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-p24-platform-tools.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\check-desktop-p24.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-p27-file-ops.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-p27-cron.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-p26-publish-queue.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\check-desktop-p26.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\check-desktop-p25.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-p30-platform-metrics.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\check-desktop-p30.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-p31-multi-platform-queue.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\check-desktop-p31.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\smoke-p32-comments.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\check-desktop-p32.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\check-desktop-p33.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\check-publish-resilience.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\check-desktop-p45.mjs"
    if ($LASTEXITCODE -ne 0) { $script:code = $LASTEXITCODE; return }
    & $node "scripts\check-desktop-p46.mjs"
    $script:code = $LASTEXITCODE
  }
}

$verifyPath = Join-Path $repo "docs\handoff\last-verify.json"
$payload = [pscustomobject]@{
  at = (Get-Date).ToString("o")
  ok = ($script:fail -eq 0)
  failed = $script:fail
  steps = $script:steps
}
$payload | ConvertTo-Json -Depth 5 | Set-Content -Path $verifyPath -Encoding utf8

Write-Host ""
if ($script:fail -eq 0) { Write-Host "VERIFY GREEN" -ForegroundColor Green; exit 0 }
else { Write-Host ("VERIFY RED ({0} step(s) failed)" -f $script:fail) -ForegroundColor Red; exit 1 }