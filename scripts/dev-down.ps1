param([switch]$StopDocker)
$repo = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Write-Host "停止服务端..." -ForegroundColor Cyan
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*dist/main.js*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -like "*fcmediaagent-replica*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if ($StopDocker) {
  Write-Host "停止 MySQL 容器..." -ForegroundColor Cyan
  docker stop fcm-mysql *> $null
}
Write-Host "已停止" -ForegroundColor Green
