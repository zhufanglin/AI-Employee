
$ErrorActionPreference='Stop'
$stage = Join-Path $env:TEMP 'p13stage'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -Recurse 'packages\server\dist' (Join-Path $stage 'dist')
Copy-Item 'packages\worker\tool-loop.mjs' (Join-Path $stage 'tool-loop.mjs')
$tgz = Join-Path $env:TEMP 'p13.tgz'
if (Test-Path $tgz) { Remove-Item -Force $tgz }
& tar.exe -czf $tgz -C $stage dist tool-loop.mjs
"TGZ=$((Get-Item $tgz).Length)"
scp -i $env:USERPROFILE\.ssh\fcmediaagent_deploy -o StrictHostKeyChecking=no $tgz root@47.85.46.165:/opt/fcmediaagent/p13.tgz
"SCP_EXIT=$LASTEXITCODE"
