set -e
cd /opt/fcmediaagent
rm -rf p20x
tar -xzf p20.tgz
test -f p20x/dist/main.js
TS=$(date +%Y%m%d%H%M%S)
mv app/dist app/dist.bak.$TS
cp -r p20x/dist app/dist
cp worker/tool-loop.mjs worker/tool-loop.mjs.bak.$TS
cp p20x/tool-loop.mjs worker/tool-loop.mjs
cp p20x/scripts/prod-verify-p20.mjs /opt/fcmediaagent/prod-verify-p20.mjs
systemctl restart fcmediaagent-api fcmediaagent-worker
sleep 5
echo "BUNDLE_OK=1 TS=$TS"
echo "API=$(systemctl is-active fcmediaagent-api) WORKER=$(systemctl is-active fcmediaagent-worker)"
curl -s -o /dev/null -w "HEALTH=%{http_code}\n" http://127.0.0.1:3000/api/health