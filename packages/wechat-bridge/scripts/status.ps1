<#  个人微信网桥状态自检（随时可跑）：powershell -File status.ps1  #>
$Root = Join-Path $env:LOCALAPPDATA 'FCMediaAgent\wechat-bridge'
$EnvFile = Join-Path $Root 'bridge.env'
function Line([string]$k, [string]$v) { '{0,-18} {1}' -f $k, $v }

Write-Host '==== 进程 ===='
$ps = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*wechat_bridge*' -or $_.CommandLine -like '*supervisor.ps1*' -or ($_.Name -eq 'ssh.exe' -and $_.CommandLine -like '*wxbridge@*') }
if ($ps) { $ps | ForEach-Object { Line $_.Name ('pid=' + $_.ProcessId) } } else { Write-Host '  (没有相关进程在跑)' }

Write-Host '==== 端口 ===='
$conn = Get-NetTCPConnection -LocalPort 8600 -State Listen -ErrorAction SilentlyContinue
if ($conn) { $conn | ForEach-Object { Line '8600 LISTEN' ($_.LocalAddress + ' pid=' + $_.OwningProcess) } } else { Write-Host '  8600 未监听' }

Write-Host '==== 本地接口 ===='
try {
  $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8600/healthz' -TimeoutSec 4
  Line '/healthz' ($h | ConvertTo-Json -Compress)
} catch { Line '/healthz' ('失败: ' + $_.Exception.Message) }

Write-Host '==== 配置 ===='
if (Test-Path $EnvFile) {
  Get-Content $EnvFile | Where-Object { $_ -and -not $_.StartsWith('#') } | ForEach-Object {
    $i = $_.IndexOf('=')
    $k = $_.Substring(0,$i); $v = $_.Substring($i+1)
    if ($k -eq 'WECHAT_BRIDGE_TOKEN') { $v = $v.Substring(0,4) + '****' }
    Line $k $v
  }
} else { Write-Host ('  缺少 ' + $EnvFile) }

Write-Host '==== 最近日志 ===='
foreach ($f in @('supervisor.log','bridge.err.log','tunnel.err.log')) {
  $p = Join-Path $Root $f
  if (Test-Path $p) {
    Write-Host ('-- ' + $f)
    Get-Content $p -Tail 8 | ForEach-Object { '   ' + $_ }
  }
}
