// 供冒烟脚本复用：从 packages/server/.env 补齐 DATABASE_URL 等变量（不覆盖已有值）
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export function loadServerEnv() {
  const envPath = fileURLToPath(new URL("../packages/server/.env", import.meta.url));
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
