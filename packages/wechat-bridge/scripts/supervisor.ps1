<#
  个人微信网桥 + SSH 反向隧道 看护进程（常驻）
  - 由「启动」文件夹里的 FCMediaBridge.vbs 在用户登录时隐藏启动
  - 保持两个子进程存活：python -m wechat_bridge（:8600）与 ssh -N -R（回连生产机）
  - 任一退出即按退避重启；日志写 %LOCALAPPDATA%\FCMediaAgent\wechat-bridge\supervisor.log
#>
param(
  [string]$Root    = (Join-Path $env:LOCALAPPDATA 'FCMediaAgent\wechat-bridge'),
  [string]$EnvFile = (Join-Path $env:LOCALAPPDATA 'FCMediaAgent\wechat-bridge\bridge.env')
)

$ErrorActionPreference = 'Continue'
$LogFile = Join-Path $Root 'supervisor.log'
$MaxLogBytes = 5MB

function Write-Log([string]$Message) {
  try {
    if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt $MaxLogBytes)) {
      Move-Item -Force $LogFile "$LogFile.1"
    }
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
    Add-Content -Path $LogFile -Value $line -Encoding utf8
  } catch { }
}

function Import-EnvFile([string]$Path) {
  if (-not (Test-Path $Path)) { Write-Log "缺少配置文件 $Path"; return }
  foreach ($raw in Get-Content -Path $Path -Encoding utf8) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    $idx = $line.IndexOf('=')
    if ($idx -lt 1) { continue }
    $name = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim()
    if ($value.StartsWith('"') -and $value.EndsWith('"') -and $value.Length -ge 2) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
  }
}

function Test-LocalPort([int]$Port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $ar = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
    $ok = $ar.AsyncWaitHandle.WaitOne(1200)
    if ($ok -and $c.Connected) { $c.Close(); return $true }
    $c.Close(); return $false
  } catch { return $false }
}

Import-EnvFile $EnvFile

# 单实例守卫：pid 文件里那个进程还活着就不重复启动（避免开机自启 + 手动启动双份）
$PidFile = Join-Path $Root 'supervisor.pid'
if (Test-Path $PidFile) {
  $oldPidText = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  $oldPid = 0
  if ($oldPidText -and [int]::TryParse($oldPidText.Trim(), [ref]$oldPid)) {
    if ($oldPid -ne $PID) {
      $oldProc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
      if ($oldProc -and $oldProc.ProcessName -eq 'powershell') {
        $oldCmd = ''
        try { $oldCmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid" -ErrorAction SilentlyContinue).CommandLine } catch { }
        if ($oldCmd -and $oldCmd.Contains('supervisor.ps1')) {
          Write-Log ("已有 supervisor 实例 pid=" + $oldPid + "，本次退出")
          exit 0
        }
      }
    }
  }
}

$bridgePort = 8600
if ($env:WECHAT_BRIDGE_PORT) { $bridgePort = [int]$env:WECHAT_BRIDGE_PORT }
$bridgeDir = $env:WECHAT_BRIDGE_DIR
if (-not $bridgeDir) { $bridgeDir = Split-Path -Parent $PSScriptRoot }
$pythonExe = $env:WECHAT_BRIDGE_PYTHON
if (-not $pythonExe) { $pythonExe = 'python' }
$sshKey = $env:WECHAT_BRIDGE_SSH_KEY
if (-not $sshKey) { $sshKey = Join-Path $env:USERPROFILE '.ssh\wxbridge_ed25519' }
$sshTarget = 'wxbridge@47.85.46.165'
$remotePort = 8600

$bridgeOut = Join-Path $Root "bridge.out.log"
$bridgeErr = Join-Path $Root "bridge.err.log"
$tunnelErr = Join-Path $Root "tunnel.err.log"

function Start-Bridge {
  Write-Log "start bridge: $pythonExe -m wechat_bridge (cwd=$bridgeDir port=$bridgePort)"
  $a = @('-m','wechat_bridge','--port',"$bridgePort")
  return Start-Process -FilePath $pythonExe -ArgumentList $a -WorkingDirectory $bridgeDir 
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $bridgeOut -RedirectStandardError $bridgeErr
}

function Start-Tunnel {
  $spec = '127.0.0.1:{0}:127.0.0.1:{1}' -f $remotePort, $bridgePort
  Write-Log ('start tunnel: -R ' + $spec + ' ' + $sshTarget)
  $a = @('-N','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=no',
          '-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3',
          '-o','ExitOnForwardFailure=yes','-o','TCPKeepAlive=yes',
          '-i',$sshKey,'-R',$spec,$sshTarget)
  return Start-Process -FilePath 'ssh' -ArgumentList $a -WindowStyle Hidden -PassThru -RedirectStandardError $tunnelErr
}

Write-Log "=== supervisor 启动 pid=$PID python=$pythonExe dir=$bridgeDir ==="
$PidFile = Join-Path $Root 'supervisor.pid'
try { Set-Content -Path $PidFile -Value $PID -Encoding ascii } catch { }

$bridge = $null
$tunnel = $null
$nextTunnelTry = Get-Date

while ($true) {
  try {
    if (-not (Test-LocalPort $bridgePort)) {
      if ($bridge -and -not $bridge.HasExited) { Write-Log "bridge 进程在但端口不通，先结束"; try { $bridge.Kill() } catch { } }
      $bridge = Start-Bridge
      $deadline = (Get-Date).AddSeconds(45)
      while ((Get-Date) -lt $deadline -and -not (Test-LocalPort $bridgePort)) { Start-Sleep -Seconds 2 }
      if (Test-LocalPort $bridgePort) { Write-Log "bridge 就绪 :$bridgePort" }
      else { Write-Log "bridge 启动 45s 内未监听 :$bridgePort（详见 bridge.err.log）" }
    }

    if (-not $tunnel -or $tunnel.HasExited) {
      if ((Get-Date) -ge $nextTunnelTry) {
        if ($tunnel -and $tunnel.HasExited) {
          $ec = 'n/a'
          try { $tunnel.Refresh(); $ec = $tunnel.ExitCode } catch { }
          if (-not $ec) { $ec = 'n/a' }
          Write-Log ('tunnel 退出 code=' + $ec + '，重连；stderr 末行: ' + (Get-Content $tunnelErr -Tail 1 -ErrorAction SilentlyContinue))
        }
        $tunnel = Start-Tunnel
        $nextTunnelTry = (Get-Date).AddSeconds(10)
      } else {
        Start-Sleep -Seconds 3
      }
    }
  } catch {
    Write-Log "supervisor 异常: $($_.Exception.Message)"
    Start-Sleep -Seconds 5
  }
  Start-Sleep -Seconds 5
}
