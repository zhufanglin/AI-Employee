// 真机升级演练：安装 0.1.0 → 指向本地更新源 → CDP 驱动 check/download/install → 验收装出来的是 0.1.1
// 用法：node scripts/rehearse-upgrade.mjs
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const INSTALLER = join(ROOT, "_deploy", "upgrade", "v0.1.0.exe");
const WWW = join(ROOT, "_deploy", "upgrade", "www");
const FEED = "http://127.0.0.1:8899/desktop";
const PORT = 9222;
const EXPECT_INSTALLED = process.env.FCM_REHEARSE_EXPECT_INSTALLED || "0\\.1\\.1";
const EXPECT_SILENT = process.env.FCM_REHEARSE_EXPECT_SILENT === "1";
const log = (...args) => console.log(...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function installedExe() {
  const base = join(process.env.LOCALAPPDATA, "Programs");
  const candidates = [];
  for (const dir of readdirSync(base)) {
    for (const name of ["中科元晟 AI员工.exe", "中科元晟 AI 员工.exe", "fcmediaagent-ai-employee.exe"]) {
      const p = join(base, dir, name);
      if (existsSync(p)) candidates.push(p);
    }
  }
  return candidates;
}
function versionOf(exe) {
  const out = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-Item '" + exe + "').VersionInfo.ProductVersion"], { encoding: "utf8" });
  return String(out.stdout || "").trim();
}
async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}
async function cdpEvaluate(ws, expression, awaitPromise = true) {
  const id = ++cdpEvaluate.seq;
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise, returnByValue: true } }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP 超时：" + expression.slice(0, 60))), 120000);
    const onMessage = (event) => {
      const payload = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      if (payload.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      if (payload.error) reject(new Error(JSON.stringify(payload.error).slice(0, 300)));
      else resolve(payload.result?.result?.value);
    };
    ws.addEventListener("message", onMessage);
  });
}
cdpEvaluate.seq = 0;

const before = installedExe();
log("安装前已存在的安装：" + JSON.stringify(before));

// 1) 静默安装 0.1.0（已装 0.1.0 则跳过，省 3 分钟；FCM_REHEARSE_SKIP_INSTALL=1 完全跳过）
const existing = installedExe();
if (process.env.FCM_REHEARSE_SKIP_INSTALL === "1") {
  log("跳过安装步骤（FCM_REHEARSE_SKIP_INSTALL=1），当前版本=" + (existing.length ? versionOf(existing[0]) : "未安装"));
} else if (existing.length && /0\.1\.0/.test(versionOf(existing[0]))) {
  log("已安装 0.1.0，跳过安装步骤：" + existing[0]);
} else {
  log("安装 0.1.0 …");
  spawnSync(INSTALLER, ["/S"], { timeout: 300000, stdio: "ignore" });
  await sleep(8000);
}
const targets = installedExe();
if (!targets.length) throw new Error("安装后没找到 exe");
const exe = targets[0];
log("安装路径：" + exe + " 版本=" + versionOf(exe));

// 2) 启动并连 CDP
log("启动 0.1.0 并开启调试端口 …");
const child = spawn(exe, ["--remote-debugging-port=" + PORT], {
  env: { ...process.env, FCM_UPDATE_URL: FEED, FCM_UPDATE_CHANNEL: "latest", ELECTRON_ENABLE_LOGGING: "1" },
  stdio: ["ignore", "pipe", "pipe"]
});
const logs = [];
child.stdout.on("data", (b) => { const t = b.toString(); logs.push(t); process.stdout.write(t); });
child.stderr.on("data", (b) => { const t = b.toString(); logs.push(t); process.stdout.write(t); });

let target = null;
for (let i = 0; i < 60; i += 1) {
  await sleep(1000);
  try {
    const targets = await fetchJson("http://127.0.0.1:" + PORT + "/json");
    target = targets.find((t) => t.type === "page" && String(t.url).includes("index.html"));
    if (target) break;
  } catch {}
}
if (!target) throw new Error("CDP 未就绪");
log("CDP 目标：" + target.url);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); });
await cdpEvaluate(ws, "1", false);

// 3) 检查更新 → 下载 → 安装
const checked = await cdpEvaluate(ws, "(async () => (await window.fcm.update.check()))()");
log("check 结果：" + JSON.stringify(checked));
let state = checked;
for (let i = 0; i < 40 && state?.status !== "available"; i += 1) {
  await sleep(1000);
  state = await cdpEvaluate(ws, "(async () => (await window.fcm.update.status()))()");
}
if (state?.status !== "available") throw new Error("未发现新版本，实际状态：" + JSON.stringify(state));
log("发现新版本：" + state.version);

const downloading = await cdpEvaluate(ws, "(async () => (await window.fcm.update.download()))()");
log("download 触发：" + JSON.stringify(downloading));
state = downloading;
for (let i = 0; i < 120 && state?.status !== "downloaded"; i += 1) {
  await sleep(2000);
  state = await cdpEvaluate(ws, "(async () => (await window.fcm.update.status()))()");
}
if (state?.status !== "downloaded") throw new Error("下载未完成，实际状态：" + JSON.stringify(state));
log("下载完成：" + JSON.stringify(state));

// 4) 安装（会退出应用并静默执行安装包）
const installCall = cdpEvaluate(ws, "(async () => (await window.fcm.update.install()))()").catch(() => "connection closed");
log("install 调用：" + JSON.stringify(await installCall));
try { child.kill(); } catch {}

// 等安装器把文件换完：轮询目标 exe 的 ProductVersion（最多 8 分钟）
let upgraded = "";
for (let i = 0; i < 48; i += 1) {
  await sleep(10000);
  const candidates = installedExe();
  if (!candidates.length) continue;
  const v = versionOf(candidates[0]);
  if (new RegExp(EXPECT_INSTALLED).test(v)) { upgraded = v; break; }
  if (i % 6 === 5) log("等待安装完成… 当前版本=" + v);
}
log("安装完成后版本：" + upgraded);

// 5) 验收安装后的版本
const after = installedExe();
const version = after.length ? versionOf(after[0]) : "";
log("升级后版本：" + version);
const text = logs.join("");
log("日志里出现新版本下载：" + (text.includes("0.1.1") ? "是" : "否"));
if (!new RegExp(EXPECT_INSTALLED).test(version)) { console.log("UPGRADE REHEARSAL FAILED (version=" + version + ")"); process.exit(1); }
if (EXPECT_SILENT && !text.includes("isSilent: true")) { console.log("UPGRADE REHEARSAL FAILED (安装器未静默)"); process.exit(1); }
console.log("UPGRADE REHEARSAL OK (0.1.0 -> " + version + ")");
