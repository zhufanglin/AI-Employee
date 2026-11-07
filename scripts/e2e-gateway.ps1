
$ErrorActionPreference = "Continue"
$log = "C:\Users\30290\Desktop\fcmediaagent-replica\_e2e_gateway.log"
"=== $(Get-Date -Format o) start ===" | Out-File -Encoding utf8 $log
try { $h = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 5; "server: $($h | ConvertTo-Json -Compress)" | Out-File -Append -Encoding utf8 $log } catch { "server DOWN: $($_.Exception.Message)" | Out-File -Append -Encoding utf8 $log; exit 1 }

# 1) login via sms
$send = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3000/api/auth/sms/send" -ContentType "application/json" -Body (@{phone="13900139003"} | ConvertTo-Json) -TimeoutSec 10
$dev = $send.devCode
$login = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3000/api/auth/sms/login" -ContentType "application/json" -Body (@{phone="13900139003";code=$dev} | ConvertTo-Json) -TimeoutSec 10
$jwt = $login.accessToken
"jwt len=$($jwt.Length)" | Out-File -Append -Encoding utf8 $log
$pt = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3000/api/volcengine/proxy-token" -Headers @{ Authorization = "Bearer $jwt" } -TimeoutSec 10
$proxy = if ($pt.token) { $pt.token } else { $pt.proxyToken }
"proxy token: $($proxy.Substring(0,20))..." | Out-File -Append -Encoding utf8 $log

$homeDir = "C:\Users\30290\AppData\Roaming\中科元晟 AI员工\openclaw"
$token = (Get-Content "$homeDir\gateway-token.txt" -Raw).Trim()
$env:ELECTRON_RUN_AS_NODE="1"
$env:OPENCLAW_HOME=$homeDir
$env:OPENCLAW_STATE_DIR="$homeDir\state"
$env:OPENCLAW_CONFIG_DIR=$homeDir
$env:OPENCLAW_CONFIG_PATH="$homeDir\openclaw.json"
$env:OPENCLAW_GATEWAY_PORT="18789"
$env:OPENCLAW_GATEWAY_TOKEN=$token
$env:OPENCLAW_NO_RESPAWN="1"
$env:OPENCLAW_NO_ONBOARD="1"
$env:OPENCLAW_SKIP_ONBOARDING="1"
$env:FCM_PROXY_TOKEN=$proxy
$cfgPath = "$homeDir\openclaw.json"
$cfg = Get-Content -Raw -Encoding utf8 $cfgPath | ConvertFrom-Json
$cfg.models.providers.fcm.apiKey = $proxy
$cfg | ConvertTo-Json -Depth 20 | Out-File -Encoding utf8 $cfgPath
"config apiKey patched" | Out-File -Append -Encoding utf8 $log
$gwDir = "C:\Users\30290\Desktop\fcmediaagent-replica\packages\desktop\resources\openclaw"
$exe = "C:\Users\30290\Desktop\fcmediaagent-replica\node_modules\electron\dist\electron.exe"

$p = Start-Process -FilePath $exe -ArgumentList @("$gwDir\openclaw.mjs","gateway","--port","18789","--token",$token,"--allow-unconfigured") -WorkingDirectory $gwDir -RedirectStandardOutput "C:\Users\30290\Desktop\fcmediaagent-replica\_e2e_gw_out.log" -RedirectStandardError "C:\Users\30290\Desktop\fcmediaagent-replica\_e2e_gw_err.log" -PassThru -NoNewWindow
"gateway pid=$($p.Id)" | Out-File -Append -Encoding utf8 $log

$ok = $false
for ($i=0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 3
  try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:18789/health" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 3; if ($r.ok) { $ok = $true; "healthy after $($i*3)s" | Out-File -Append -Encoding utf8 $log; break } } catch {}
}
if (-not $ok) { "gateway never healthy" | Out-File -Append -Encoding utf8 $log; Get-Content "C:\Users\30290\Desktop\fcmediaagent-replica\_e2e_gw_out.log" -Tail 20 | Out-File -Append -Encoding utf8 $log; Stop-Process -Id $p.Id -Force; exit 1 }

"=== agent run ===" | Out-File -Append -Encoding utf8 $log
& $exe "$gwDir\openclaw.mjs" agent --to "+8613900139003" --message "只回复四个字：网关链路正常" --json *>&1 | Out-File -Append -Encoding utf8 $log
"AGENT_EXIT=$LASTEXITCODE" | Out-File -Append -Encoding utf8 $log

Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
"=== done ===" | Out-File -Append -Encoding utf8 $log