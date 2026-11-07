<#
  中科元晟 AI员工 —— 个人微信网桥 Windows 一键安装（家里/办公室常开机器）
  用法（在目标机 PowerShell 里跑一行）：
    powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -UseBasicParsing https://updates.fcmediaagent.com/bridge/setup-windows.ps1 -OutFile $env:TEMP\setup-win.ps1; & $env:TEMP\setup-win.ps1"
  可选参数：-SkipDeps（跳过 pip 安装）、-ZipUrl <url>

  2026-11-07 更新（重要）：
  * 微信 3.9.x 已被腾讯停止登录 ⇒ 真实模式只能走微信 4.x。
  * 驱动首选 wechatauto-replica（GUI 自动化 + OCR，不依赖 UIA，实测兼容微信 4.1.15）；
    wxauto4 只对 <=4.1.8.107 有效（4.1.15 起主窗口 UIA 树为空），作为回退保留。
  * 两个驱动都要求 Python 3.12（wxauto4 是 cp312 编译版），所以本脚本会自动建
    独立 venv：%LOCALAPPDATA%\FCMediaAgent\wechat-bridge\venv，不污染系统 Python。
  做完会打印：SSH 公钥（发给我加白名单）+ 网桥 Token（我配到服务端）
#>
param(
  [string]$ZipUrl = 'https://updates.fcmediaagent.com/bridge/wechat-bridge.zip',
  [switch]$SkipDeps
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$Root = Join-Path $env:LOCALAPPDATA 'FCMediaAgent\wechat-bridge'
$AppDir = Join-Path $Root 'app'
$ScriptsDir = Join-Path $AppDir 'scripts'
$EnvFile = Join-Path $Root 'bridge.env'
$VenvDir = Join-Path $Root 'venv'
$VenvPy = Join-Path $VenvDir 'Scripts\python.exe'
$KeyPath = Join-Path $env:USERPROFILE '.ssh\wxbridge_ed25519'
$Pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')

function Say([string]$m) { Write-Host $m }
function Step([string]$m) { Write-Host ''; Write-Host ('== ' + $m) -ForegroundColor Cyan }
function Warn([string]$m) { Write-Host ('!! ' + $m) -ForegroundColor Yellow }
function Ok([string]$m) { Write-Host ('   ' + $m) -ForegroundColor Gray }

Say '====================================================='
Say ' 中科元晟 AI员工 —— 个人微信网桥安装'
Say '====================================================='

Step '1/8 检查系统环境'
$os = Get-CimInstance Win32_OperatingSystem
Say ('系统: ' + $os.Caption + ' ' + $os.Version)

$sshExe = (Get-Command ssh.exe -ErrorAction SilentlyContinue)
if (-not $sshExe) {
  Warn '未找到 OpenSSH 客户端：设置 > 应用 > 可选功能 > 添加功能 > OpenSSH 客户端，装完重跑。'
  exit 3
}
Say ('ssh: ' + $sshExe.Source)

# ---- 找 Python：wxauto4 41.x 只支持 3.12（cp312 编译），优先 3.12 ----
$pyBase = $null; $pyPre = @(); $pyVer = $null
$pySpecs = @(
  @{ Exe = (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'); Pre = @() },
  @{ Exe = 'py'; Pre = @('-3.12') },
  @{ Exe = (Join-Path $env:ProgramFiles 'Python312\python.exe'); Pre = @() },
  @{ Exe = 'python'; Pre = @() }
)
foreach ($spec in $pySpecs) {
  $exe = $spec.Exe
  if ($exe -eq 'py' -or $exe -eq 'python') {
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
  } else {
    if (-not (Test-Path $exe)) { continue }
  }
  try {
    $a = @($spec.Pre) + @('-c', "import sys;print('%d.%d' % sys.version_info[:2])")
    $v = & $exe @a 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $v) { continue }
    $v = ($v | Out-String).Trim()
    $parts = $v.Split('.')
    $maj = [int]$parts[0]; $min = [int]$parts[1]
    if ($maj -eq 3 -and $min -eq 12) {
      $pyBase = $exe; $pyPre = $spec.Pre; $pyVer = $v
      break
    } else {
      Ok ('跳过 Python ' + $v + '（' + $exe + '）：wxauto4 41.x 需要 3.12')
    }
  } catch { }
}
if (-not $pyBase) {
  Warn '没有找到 Python 3.12（微信 4.x 驱动 wxauto4 41.x 只能跑 3.12）。请先安装：'
  Say '    winget install -e --id Python.Python.3.12'
  Say '  或手工安装 https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe'
  Say '  装完重跑本脚本。'
  exit 2
}
Say ('Python: ' + $pyVer + '  (' + $pyBase + ' ' + ($pyPre -join ' ') + ')')

$wxFound = $null
foreach ($p in @(
  (Join-Path $env:ProgramFiles 'Tencent\Weixin\Weixin.exe'),
  (Join-Path $Pf86 'Tencent\Weixin\Weixin.exe'),
  (Join-Path $env:LOCALAPPDATA 'Tencent\Weixin\Weixin.exe')
)) { if (Test-Path $p) { $wxFound = $p; break } }
if ($wxFound) {
  $wxVer = (Get-Item $wxFound).VersionInfo.ProductVersion
  Say ('微信 4.x: ' + $wxFound + '  ' + $wxVer)
  if ($wxVer -like '4.0.*') { Warn ('检测到微信 ' + $wxVer + '：驱动按 4.1.x 适配，建议升级到 4.1.8+') }
  if ($wxVer -notlike '4.1.*') { Warn ('微信版本 ' + $wxVer + ' 不在实测范围（建议 4.1.15.x）；如连接失败先升级微信') }
} else {
  Warn '未找到微信 4.x（C:\Program Files\Tencent\Weixin\Weixin.exe）。请安装微信 PC 4.1.x 并登录专用小号。'
}
$oldWx = Join-Path $env:ProgramFiles 'Tencent\WeChat\WeChat.exe'
if (Test-Path $oldWx) { Ok ('另检测到 3.9.x（' + $oldWx + '）：该分支已被腾讯停止登录，不要使用。') }

Step '2/8 准备 Python 3.12 虚拟环境'
if (Test-Path $VenvPy) {
  Say ('复用已有 venv：' + $VenvDir)
} else {
  Say ('创建 venv：' + $VenvDir)
  & $pyBase @pyPre -m venv $VenvDir
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $VenvPy)) {
    Warn '创建 venv 失败。请确认已安装 Python 3.12 的完整组件（含 venv）后重试。'
    exit 2
  }
}
$vInfo = ((& $VenvPy -c "import sys,platform;print(sys.version.split()[0], platform.machine(), '32bit' if sys.maxsize < 2**32 else '64bit')" | Out-String).Trim())
Say ('venv Python: ' + $vInfo)

Step '3/8 下载网桥程序'
if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
New-Item -ItemType Directory -Force -Path $Root | Out-Null
$zip = Join-Path $env:TEMP 'wechat-bridge.zip'
Say ('下载 ' + $ZipUrl)
Invoke-WebRequest -UseBasicParsing -Uri $ZipUrl -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $AppDir -Force
if (-not (Test-Path (Join-Path $AppDir 'wechat_bridge'))) { Warn '压缩包结构异常：缺少 wechat_bridge 目录'; exit 4 }
Say ('已解压到 ' + $AppDir)

Step '4/8 安装依赖（首次约 2-4 分钟）'
if ($SkipDeps) {
  Say '已跳过（-SkipDeps）'
} else {
  # 全局 ErrorActionPreference=Stop 时，pip 往 stderr 写 WARNING 会被当终止性错误炸流程；
  # 这段临时降为 Continue；不要用 2>&1；关掉脚本路径警告。
  $eapPrev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
  $env:PIP_NO_INPUT = '1'
  $idxList = @('https://pypi.tuna.tsinghua.edu.cn/simple', 'https://mirrors.aliyun.com/pypi/simple/')

  & $VenvPy -m pip install --upgrade pip --quiet --disable-pip-version-check --no-warn-script-location
  if ($LASTEXITCODE -ne 0) { Warn 'pip 升级失败（不影响后续，继续）' }

  $okBase = $false
  foreach ($i in $idxList) {
    Say ('安装基础依赖（fastapi / uvicorn / pydantic，源 ' + $i + '）…')
    & $VenvPy -m pip install --disable-pip-version-check 'fastapi==0.143.0' 'uvicorn==0.54.0' 'pydantic==2.14.0' --no-warn-script-location -i $i
    if ($LASTEXITCODE -eq 0) { $okBase = $true; break }
    Warn '基础依赖安装失败，换源重试…'
  }
  if (-not $okBase) {
    Say '仍失败，尝试不锁版本安装…'
    foreach ($i in $idxList) {
      & $VenvPy -m pip install --disable-pip-version-check --no-warn-script-location fastapi uvicorn pydantic -i $i
      if ($LASTEXITCODE -eq 0) { $okBase = $true; break }
      Warn '换源重试…'
    }
  }
  if (-not $okBase) {
    Warn '基础依赖安装失败：请检查网络（或代理）后重跑本脚本。'
    exit 5
  }
  Say '基础依赖 OK。'

  # 微信驱动：首装 wechatauto-replica（GUI+OCR，兼容微信 4.1.15，2026-11 实测可用），
  # wxauto4 只对 <=4.1.8.107 有效，作为可选回退；两个都装失败才算致命。
  Say '安装微信驱动 wechatauto-replica==1.2.9（微信 4.1.x，含 opencv/numpy，约 2-4 分钟）…'
  $okDriver = $false
  foreach ($i in $idxList) {
    & $VenvPy -m pip install --disable-pip-version-check --no-warn-script-location 'wechatauto-replica==1.2.9' -i $i
    if ($LASTEXITCODE -eq 0) { $okDriver = $true; break }
    Warn 'wechatauto-replica 安装失败，换源重试…'
  }
  if ($okDriver) {
    $imp = ((& $VenvPy -c "import wechatauto;print('wechatauto import OK')" 2>&1 | Out-String).Trim())
    Say ('  ' + $imp)
  } else {
    Warn 'wechatauto-replica 安装失败。请手工执行：'
    Say  ('  ' + $VenvPy + ' -m pip install wechatauto-replica==1.2.9 -i https://pypi.tuna.tsinghua.edu.cn/simple')
  }

  Say '安装回退驱动 wxauto4==41.1.7（仅微信 <=4.1.8.107 有效，编译版）…'
  $okWx4 = $false
  foreach ($i in $idxList) {
    & $VenvPy -m pip install --disable-pip-version-check --no-warn-script-location 'wxauto4==41.1.7' -i $i
    if ($LASTEXITCODE -eq 0) { $okWx4 = $true; break }
    Warn 'wxauto4 安装失败，换源重试…'
  }
  if ($okWx4) {
    $imp = ((& $VenvPy -c "import wxauto4;print('wxauto4 import OK')" 2>&1 | Out-String).Trim())
    Say ('  ' + $imp)
  } else {
    Warn 'wxauto4 安装失败（仅影响 <=4.1.8.107 的回退，wechatauto 可用则无妨）'
  }
  if (-not $okDriver -and -not $okWx4) {
    Warn '两个微信驱动都没装上：真实模式无法连接微信，请检查网络/代理后重跑。'
  }
  $ErrorActionPreference = $eapPrev
}

Step '5/8 生成隧道密钥'
New-Item -ItemType Directory -Force -Path (Join-Path $env:USERPROFILE '.ssh') | Out-Null
if (Test-Path $KeyPath) {
  Say ('已存在密钥，复用：' + $KeyPath)
} else {
  $bat = Join-Path $env:TEMP 'wx_genkey.cmd'
  $line = 'ssh-keygen -t ed25519 -N "" -C "wxbridge@' + $env:COMPUTERNAME + '" -f "' + $KeyPath + '" -q'
  Set-Content -Path $bat -Value ('@echo off' + [Environment]::NewLine + $line) -Encoding ascii
  cmd /c $bat | Out-Null
  if (-not (Test-Path $KeyPath)) { Warn ('密钥生成失败，请手动执行：ssh-keygen -t ed25519 -f ' + $KeyPath); exit 6 }
  Say ('已生成：' + $KeyPath)
}

Step '6/8 写配置'
# 重跑时保留已有 Token：否则服务端 .env 里的 WECHAT_UIA_TOKEN 会失效（要人工同步）。
$token = $null
if (Test-Path $EnvFile) {
  $old = Get-Content $EnvFile -Encoding UTF8 | Where-Object { $_ -like 'WECHAT_BRIDGE_TOKEN=*' } | Select-Object -First 1
  if ($old) { $token = ($old -replace '^WECHAT_BRIDGE_TOKEN=', '').Trim() }
}
if ($token) {
  Say ('复用已有 Token（' + $token.Substring(0, 4) + '…）')
} else {
  $bytes = New-Object 'byte[]' 16
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
}
$envLines = @(
  '# 中科元晟 AI员工 —— 个人微信网桥配置（本机专用，勿外传）',
  'WECHAT_BRIDGE_HOST=127.0.0.1',
  'WECHAT_BRIDGE_PORT=8600',
  ('WECHAT_BRIDGE_TOKEN=' + $token),
  'WECHAT_BRIDGE_MOCK=0',
  'WECHAT_BRIDGE_BACKEND=auto',
  ('WECHAT_BRIDGE_PYTHON=' + $VenvPy),
  ('WECHAT_BRIDGE_SSH_KEY=' + $KeyPath)
)
# 必须 UTF-8 带 BOM：PS 5.1 读无 BOM 的 UTF-8 会按 GBK 解释（中文会吃掉引号）。
[IO.File]::WriteAllText($EnvFile, ($envLines -join [Environment]::NewLine) + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($true)))
Say ('配置：' + $EnvFile)

Step '7/8 Python 自检'
Push-Location $AppDir
try {
  & $VenvPy -m wechat_bridge.selftest
  if ($LASTEXITCODE -ne 0) { Warn ('自检未通过（见上方输出），可稍后手动重跑：' + $VenvPy + ' -m wechat_bridge.selftest') }
} finally { Pop-Location }

Step '8/8 设置开机自启并启动'
$startup = [Environment]::GetFolderPath('Startup')
Copy-Item -Force (Join-Path $ScriptsDir 'FCMediaBridge.vbs') (Join-Path $startup 'FCMediaBridge.vbs')
Say ('已加入启动项：' + (Join-Path $startup 'FCMediaBridge.vbs'))
Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',(Join-Path $ScriptsDir 'supervisor.ps1')) -WindowStyle Hidden
Start-Sleep -Seconds 8
$bridgeOk = $false
try {
  $resp = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8600/healthz' -TimeoutSec 5
  $bridgeOk = ($resp.StatusCode -eq 200)
} catch { $bridgeOk = $false }
if ($bridgeOk) {
  Say '网桥已在本机 127.0.0.1:8600 监听 OK'
} else {
  Warn '网桥未监听 8600，请看日志：'
  Warn ('  ' + (Join-Path $Root 'bridge.err.log'))
  Warn ('  ' + (Join-Path $Root 'supervisor.log'))
}

$pubkey = (Get-Content -Path ($KeyPath + '.pub') -Raw).Trim()
Say ''
Say '====================================================='
Say ' 安装完成，请把下面两块内容发给我'
Say '====================================================='
Say ''
Say '【1】SSH 公钥（加服务器白名单用）：'
Say $pubkey
Say ''
Say '【2】网桥 Token（配服务端用）：'
Say $token
Say ''
Say ('日志目录：' + $Root)
