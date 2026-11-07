<#
  release-desktop.ps1 —— 一条命令构建 Windows 安装包（NSIS）与自动更新清单
  用法：powershell -ExecutionPolicy Bypass -File scripts\release-desktop.ps1 [-SkipApp]
  产物：packages\desktop\release\<productName>-<version>-win-x64.exe / .blockmap / latest.yml
#>
param([switch]$SkipApp)
$ErrorActionPreference = "Stop"
# 支持两种调用：-File 直接跑（有 $PSCommandPath）或 scriptblock 方式（无 $PSCommandPath，回落到脚本所在目录/当前目录）
if ($PSCommandPath) {
  $repo = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
} elseif ((Split-Path -Leaf (Get-Location).Path) -eq "scripts") {
  $repo = Split-Path -Parent (Get-Location).Path
} else {
  $repo = (Get-Location).Path
}
$node = "C:\Users\30290\Desktop\REA逆向\toolchain\node-v24.22.1-win-x64\node.exe"
if (-not (Test-Path $node)) { $node = (Get-Command node).Source }

# 国内网络必需：electron 与 electron-builder 的二进制都走镜像
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"

$desktop = Join-Path $repo "packages\desktop"
Push-Location $desktop
try {
  if (-not $SkipApp) {
    Write-Host "==> electron-vite build" -ForegroundColor Cyan
    & $node (Join-Path $repo "node_modules\electron-vite\bin\electron-vite.js") build
    if ($LASTEXITCODE -ne 0) { throw "electron-vite build failed" }
  }
  Write-Host "==> electron-builder --win nsis" -ForegroundColor Cyan
  & $node (Join-Path $repo "node_modules\electron-builder\out\cli\cli.js") --win nsis --config electron-builder.yml
  if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }
}
finally { Pop-Location }

$rel = Join-Path $desktop "release"
$arts = Get-ChildItem $rel -File | Where-Object { $_.Name -match '\.exe$|\.blockmap$|^latest\.yml$' }
Write-Host ""
Write-Host "构建产物：" -ForegroundColor Green
foreach ($a in $arts) { Write-Host ("  {0}  ({1:N1} MB)" -f $a.Name, ($a.Length / 1MB)) }
$version = (Get-Content (Join-Path $desktop "package.json") -Raw -Encoding utf8 | ConvertFrom-Json).version
Write-Host ""
Write-Host "下一步：把上面 3 个文件上传到 https://updates.fcmediaagent.com/desktop/latest/ （文件名保持不变）" -ForegroundColor Yellow
Write-Host "当前版本：$version；客户端启动 15 秒后会自动检查更新" -ForegroundColor Yellow
