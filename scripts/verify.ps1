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
