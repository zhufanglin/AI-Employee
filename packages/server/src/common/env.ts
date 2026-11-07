import * as fs from "node:fs";
import * as path from "node:path";

/** 极简 .env 加载器：不覆盖已有环境变量，避免引入 dotenv 依赖 */
function loadEnvFile(file: string) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

let loaded = false;
export function ensureEnv() {
  if (loaded) return;
  loaded = true;
  loadEnvFile(path.resolve(process.cwd(), ".env"));
  loadEnvFile(path.resolve(process.cwd(), "../../.env"));
}

export function env(key: string, fallback = ""): string {
  ensureEnv();
  return process.env[key] ?? fallback;
}

export function envInt(key: string, fallback: number): number {
  const v = env(key, "");
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function envBool(key: string, fallback = false): boolean {
  const v = env(key, "").toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes";
}

export const JWT_SECRET = () => env("JWT_SECRET", "dev-only-change-me");
