
$ErrorActionPreference='Stop'
$stage = Join-Path $env:TEMP 'p13stage'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -Recurse 'packages\server\dist' (Join-Path $stage 'dist')
Copy-Item 'packages\worker\tool-loop.mjs' (Join-Path $stage 'tool-loop.mjs')
$tgz = Join-Path $env:TEMP 'p13.tgz'
if (Test-Path $tgz) { Remove-Item -Force $tgz }
& tar.exe -czf $tgz -C $stage dist tool-loop.mjs
scp -i $env:USERPROFILE\.ssh\fcmediaagent_deploy -o StrictHostKeyChecking=no $tgz root@47.85.46.165:/opt/fcmediaagent/p13.tgz
"SCP1=$LASTEXITCODE"
scp -i $env:USERPROFILE\.ssh\fcmediaagent_deploy -o StrictHostKeyChecking=no 'scripts\prod-verify-p13-public-url.mjs' root@47.85.46.165:/opt/fcmediaagent/v-p13.mjs
"SCP2=$LASTEXITCODE"
$bash = @'
set -e
TS=$(date +%s)
cd /opt/fcmediaagent
rm -rf p13x && mkdir -p p13x && tar -xzf p13.tgz -C p13x
mv app/dist app/dist.bak.$TS
cp -r p13x/dist app/dist
cp p13x/tool-loop.mjs worker/tool-loop.mjs
systemctl restart fcmediaagent-api fcmediaagent-worker
sleep 7
systemctl is-active fcmediaagent-api fcmediaagent-worker
curl -s -o /dev/null -w 'health=%{http_code}
' http://127.0.0.1:3000/api/health
grep -c ossPublicUrl app/dist/workspace/workspace.service.js
'@
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($bash))
ssh -i $env:USERPROFILE\.ssh\fcmediaagent_deploy -o StrictHostKeyChecking=no root@47.85.46.165 "echo $b64 | base64 -d > /tmp/p13b.sh && bash /tmp/p13b.sh"
"DEPLOY_EXIT=$LASTEXITCODE"
