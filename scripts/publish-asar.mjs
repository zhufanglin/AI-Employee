#!/usr/bin/env node
/**
 * publish-asar.mjs —— 打包桌面端 asar 热更新包（P43 P1-6）
 *
 * 产物：packages/desktop/release/asar/
 *   fcmediaagent-ai-employee-<version>-asar.bin   app.asar 原样拷贝（ASCII 文件名）
 *   asar.json                                    客户端 asar-update:check 读取的清单
 *
 * 更新地址：https://updates.fcmediaagent.com/desktop/asar/asar.json
 * 服务器目录：/opt/fcmediaagent/updates/desktop/asar/（nginx 静态目录，与 latest/ 同级）
 *
 * 用法：
 *   node scripts/publish-asar.mjs                       # 只打包，生成本地文件，不传输
 *   node scripts/publish-asar.mjs --upload              # 打包后 scp 到更新服务器并校验
 *   node scripts/publish-asar.mjs --min-version=0.1.20  # 指定最低基线版本（可选）
 *   node scripts/publish-asar.mjs --dry-run --upload    # 只打印将执行的动作
 *
 * 注意：
 * - 客户端拿 asar.json 里的 version 跟 app.getVersion() 比较，所以 version 必须与
 *   packages/desktop/package.json 的 version 一致（打包前先改 package.json 并 electron-builder）。
 * - 清单里的 sha512 是 base64；客户端下载后会重算并比对，不匹配会删文件并报错。
 * - 服务端只允许 base 域名下的路径，清单里的 file 必须是纯文件名，不能带目录。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const DESKTOP = join(REPO, "packages", "desktop");
const SOURCE = join(DESKTOP, "release", "win-unpacked", "resources", "app.asar");
const OUT_DIR = join(DESKTOP, "release", "asar");
const HOST = process.env.FCM_DEPLOY_HOST || "root@47.85.46.165";
const KEY = process.env.FCM_DEPLOY_KEY || join(process.env.USERPROFILE || homedir(), ".ssh", "fcmediaagent_deploy");
const REMOTE_DIR = process.env.FCM_ASAR_DIR || "/opt/fcmediaagent/updates/desktop/asar";
const PUBLIC_BASE = process.env.FCM_ASAR_PUBLIC || "https://updates.fcmediaagent.com/desktop/asar";
const upload = process.argv.includes("--upload");
const dryRun = process.argv.includes("--dry-run");

function argValue(name) {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : "";
}

const minVersion = argValue("min-version").trim();
const version = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8").replace(/^\uFEFF/, "")).version;
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("[publish-asar] packages/desktop/package.json 的 version 不是 3 段数字：" + version);
  process.exit(1);
}
if (minVersion && !/^\d+\.\d+\.\d+$/.test(minVersion)) {
  console.error("[publish-asar] --min-version 必须是 3 段数字，例如 0.1.20");
  process.exit(1);
}

if (!existsSync(SOURCE)) {
  console.error("[publish-asar] 找不到 " + SOURCE);
  console.error("[publish-asar] 先跑 electron-builder 产出 win-unpacked，再执行本脚本");
  process.exit(1);
}

const file = `fcmediaagent-ai-employee-${version}-asar.bin`;
if (!/^[\x20-\x7e]+$/.test(file)) {
  console.error("[publish-asar] 产物名含非 ASCII 字符，URL 会 404：" + file);
  process.exit(1);
}

if (!dryRun) mkdirSync(OUT_DIR, { recursive: true });
const outFile = join(OUT_DIR, file);
const manifestPath = join(OUT_DIR, "asar.json");

if (!dryRun) {
  copyFileSync(SOURCE, outFile);
  const buf = readFileSync(outFile);
  const sha512 = createHash("sha512").update(buf).digest("base64");
  const size = buf.length;
  if (size <= 0 || size > 200 * 1024 * 1024) {
    console.error("[publish-asar] asar 大小异常：" + size + " 字节（客户端上限 200MB）");
    process.exit(1);
  }
  const manifest = {
    version,
    file,
    sha512,
    size,
    publishedAt: new Date().toISOString(),
    ...(minVersion ? { minVersion } : {})
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log("[publish-asar] 已生成 " + outFile + "（" + (size / 1024 / 1024).toFixed(1) + " MB）");
  console.log("[publish-asar] 已生成 " + manifestPath);
  console.log("[publish-asar] version=" + version + " sha512=" + sha512.slice(0, 24) + "…");
} else {
  const size = statSync(SOURCE).size;
  console.log("[publish-asar] [dry-run] 将把 " + SOURCE + "（" + size + " 字节）复制为 " + outFile);
  console.log("[publish-asar] [dry-run] 将写入清单 " + manifestPath + "（version=" + version + "）");
}

if (!upload) {
  console.log("[publish-asar] 默认只打包不传输。确认无误后加 --upload 上传到 " + HOST + ":" + REMOTE_DIR + "/");
  process.exit(0);
}

const sshBase = ["-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=20", "-i", KEY];
function run(cmd, args) {
  if (dryRun) {
    console.log("[dry-run] " + cmd + " " + args.join(" "));
    return "";
  }
  return execFileSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
}

run("ssh", [...sshBase, HOST, "mkdir -p " + REMOTE_DIR]);
run("scp", [...sshBase, outFile, manifestPath, HOST + ":" + REMOTE_DIR + "/"]);

if (!dryRun) {
  const check = execFileSync(
    "ssh",
    [
      ...sshBase,
      HOST,
      "ls -l " + REMOTE_DIR + " && curl -fsS -o /dev/null -w 'json=%{http_code} ' " + PUBLIC_BASE + "/asar.json && curl -fsS -r 0-1023 -o /dev/null -w 'bin=%{http_code}\n' " + PUBLIC_BASE + "/" + file
    ],
    { encoding: "utf8" }
  );
  process.stdout.write(check);
  console.log("[publish-asar] 完成：" + PUBLIC_BASE + "/asar.json");
  console.log("[publish-asar] 回滚：客户端同目录的 app.asar.bak-<时间戳>，或在 resources 下执行 Copy-Item app.asar.bak-* app.asar -Force 后重启。");
}
