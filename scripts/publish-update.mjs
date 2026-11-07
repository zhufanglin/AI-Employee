#!/usr/bin/env node
/**
 * publish-update.mjs —— 把桌面端安装包 + latest.yml 发布到更新服务器
 *
 * 更新地址：https://updates.fcmediaagent.com/desktop/latest/latest.yml
 * 服务器目录：/opt/fcmediaagent/updates/desktop/latest/（nginx 站点 updates.fcmediaagent.com）
 *
 * 用法：
 *   node scripts/publish-update.mjs            # 上传并校验
 *   node scripts/publish-update.mjs --dry-run  # 只打印将执行的动作
 *
 * 前置：packages/desktop/release/ 下已有 electron-builder 产物（latest.yml + exe）。
 * 认证：用 ~/.ssh/fcmediaagent_deploy 登录 root@47.85.46.165（可被 FCM_DEPLOY_HOST / FCM_DEPLOY_KEY 覆盖）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const RELEASE_DIR = join(REPO, "packages", "desktop", "release");
const HOST = process.env.FCM_DEPLOY_HOST || "root@47.85.46.165";
const KEY = process.env.FCM_DEPLOY_KEY || join(homedir(), ".ssh", "fcmediaagent_deploy");
const REMOTE_DIR = process.env.FCM_UPDATE_DIR || "/opt/fcmediaagent/updates/desktop/latest";
const PUBLIC_BASE = process.env.FCM_UPDATE_PUBLIC || "https://updates.fcmediaagent.com/desktop/latest";
const dryRun = process.argv.includes("--dry-run");

const ymlPath = join(RELEASE_DIR, "latest.yml");
if (!existsSync(ymlPath)) {
  console.error("[publish] 缺少 " + ymlPath + "，先跑 electron-builder");
  process.exit(1);
}
const yml = readFileSync(ymlPath, "utf8").replace(/^\uFEFF/, "");
const pathLine = /^path:\s*(.+)$/m.exec(yml);
if (!pathLine) {
  console.error("[publish] latest.yml 里没有 path 行");
  process.exit(1);
}
const artifact = pathLine[1].trim();
const artifactPath = join(RELEASE_DIR, artifact);
if (!existsSync(artifactPath)) {
  console.error("[publish] 缺少产物 " + artifactPath);
  process.exit(1);
}
if (/[^\x20-\x7e]/.test(artifact)) {
  console.error("[publish] 产物名含非 ASCII 字符，URL 需转义易 404；请在 electron-builder.yml 里配 ASCII artifactName：" + artifact);
  process.exit(1);
}
const version = (/^version:\s*(.+)$/m.exec(yml) || [, "?"])[1];

const sshBase = ["-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=20", "-i", KEY];
function run(cmd, args, opts = {}) {
  if (dryRun) {
    console.log("[dry-run] " + cmd + " " + args.join(" "));
    return "";
  }
  return execFileSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"], ...opts });
}

console.log("[publish] version=" + version + " artifact=" + artifact);
run("ssh", [...sshBase, HOST, "mkdir -p " + REMOTE_DIR]);
run("scp", [...sshBase, artifactPath, ymlPath, HOST + ":" + REMOTE_DIR + "/"]);

if (!dryRun) {
  const check = execFileSync(
    "ssh",
    [...sshBase, HOST, "ls -l " + REMOTE_DIR + " && curl -fsS -o /dev/null -w 'yml=%{http_code} ' " + PUBLIC_BASE + "/latest.yml && curl -fsS -r 0-1023 -o /dev/null -w 'exe=%{http_code}\n' " + PUBLIC_BASE + "/" + artifact],
    { encoding: "utf8" }
  );
  process.stdout.write(check);
  console.log("[publish] 完成：" + PUBLIC_BASE + "/latest.yml");
}
