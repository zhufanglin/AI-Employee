param(
  [switch]$NoServer,
  [switch]$Build
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Set-Location $repo
$node = "C:\Users\30290\Desktop\REA逆向\toolchain\node-v24.22.1-win-x64\node.exe"

Write-Host "== 1/4 确保 Docker 可用 ==" -ForegroundColor Cyan
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "启动 Docker Desktop（约 40-60s）..."
  Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  $ok = $false
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 2
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { $ok = $true; break }
  }
  if (-not $ok) { throw "Docker 未能启动" }
}

Write-Host "== 2/4 启动 MySQL 容器 ==" -ForegroundColor Cyan
docker start fcm-mysql *> $null
$up = $false
for ($i = 0; $i -lt 60; $i++) {
  $t = Test-NetConnection -ComputerName 127.0.0.1 -Port 3306 -WarningAction SilentlyContinue -InformationLevel Quiet
  if ($t) { $up = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $up) { throw "MySQL 3306 不可达" }
Start-Sleep -Seconds 3
Write-Host "MySQL OK (127.0.0.1:3306, db=fcmediaagent_v2)" -ForegroundColor Green

if ($NoServer) { Write-Host "跳过服务端启动（-NoServer）"; exit 0 }

if ($Build) {
  Write-Host "== 3/4 编译服务端 ==" -ForegroundColor Cyan
  Push-Location "packages\server"
  & $node "..\..\node_modules\typescript\bin\tsc" -p tsconfig.json
  $c = $LASTEXITCODE
  Pop-Location
  if ($c -ne 0) { throw "tsc 失败" }
}

Write-Host "== 3/4 启动服务端 ==" -ForegroundColor Cyan
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*dist/main.js*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$out = Join-Path $repo "_srv_out.log"
$err = Join-Path $repo "_srv_err.log"
$p = Start-Process -FilePath $node -ArgumentList "dist/main.js" -WorkingDirectory (Join-Path $repo "packages\server") -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden
Write-Host "server pid=$($p.Id) logs=_srv_out.log/_srv_err.log"

Write-Host "== 4/4 等待 /api/health ==" -ForegroundColor Cyan
$healthy = $false
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 3
    if ($r.status -eq "ok") { $healthy = $true; break }
  } catch { }
}
if ($healthy) {
  Write-Host "服务端就绪：http://127.0.0.1:3000/api  （Swagger /api/docs）" -ForegroundColor Green
  exit 0
} else {
  Write-Host "服务端未就绪，看 _srv_err.log：" -ForegroundColor Red
  Get-Content $err -Tail 30 -ErrorAction SilentlyContinue
  exit 1
}
