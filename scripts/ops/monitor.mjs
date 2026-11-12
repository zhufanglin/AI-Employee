#!/usr/bin/env node
/**
 * P44 WP2 生产监控告警（Node 24 纯内置，零依赖）
 *
 * 六项检查：
 *   1. api_health         GET http://127.0.0.1:3000/api/health，非 200 或 db!=up
 *   2. queue_backlog      docker exec fcm-mysql mysql 统计超时 queued 任务数
 *   3. worker_heartbeat   worker.log mtime 超过阈值分钟
 *   4. upstream_overdue   最近 N 行日志出现 AccountOverdueError
 *   5. resources          磁盘 / 使用率、可用内存
 *   6. backup_freshness   最新 *.sql.gz 超过阈值小时
 *
 * 用法：
 *   node monitor.mjs --once                 单跑一次（默认，供 systemd timer 调用）
 *   node monitor.mjs --dry-run              只打印，不写日志、不写 state、不推送
 *   node monitor.mjs --config <path>        指定配置文件
 *   node monitor.mjs --strict               有告警时退出码 1（默认 0）
 *
 * 输出：/opt/fcmediaagent/logs/monitor.log（每行一个 JSON：ts/check/level/message/detail）
 * 推送：环境变量 ALERT_WEBHOOK_URL（优先）或配置 alert.webhookUrl；
 *       同一 check 冷却期内只推一次，恢复时推一次「已恢复」。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const IS_LINUX = process.platform === 'linux';
const PROD_ENV_FILE = '/opt/fcmediaagent/app/.env';

const CHECK_ORDER = ['api_health', 'queue_backlog', 'worker_heartbeat', 'upstream_overdue', 'resources', 'backup_freshness'];

const CHECK_LABELS = {
  api_health: 'API 健康',
  queue_backlog: '队列积压',
  worker_heartbeat: 'worker 心跳',
  upstream_overdue: '上游欠费',
  resources: '磁盘/内存',
  backup_freshness: '备份新鲜度',
};

const DEFAULTS = {
  timeZone: 'Asia/Shanghai',
  apiHealth: {
    enabled: true,
    url: 'http://127.0.0.1:3000/api/health',
    timeoutMs: 3000,
  },
  queueBacklog: {
    enabled: true,
    staleMinutes: 30,
    threshold: 20,
    mysqlContainer: 'fcm-mysql',
    dockerBin: 'docker',
    envFile: PROD_ENV_FILE,
    timeoutMs: 20000,
  },
  workerHeartbeat: {
    enabled: true,
    logPath: '/opt/fcmediaagent/logs/worker.log',
    maxIdleMinutes: 10,
  },
  upstreamOverdue: {
    enabled: true,
    logPaths: ['/opt/fcmediaagent/logs/worker.log', '/opt/fcmediaagent/logs/api.log'],
    tailLines: 200,
    pattern: 'AccountOverdueError',
  },
  resources: {
    enabled: true,
    diskPath: '/',
    diskMaxUsedPercent: 85,
    memMinAvailableMB: 300,
  },
  backupFreshness: {
    enabled: true,
    backupDir: '/opt/fcmediaagent/backups/mysql',
    maxAgeHours: 26,
  },
  alert: {
    webhookUrl: '',
    cooldownMinutes: 60,
    stateFile: '/opt/fcmediaagent/monitor-state.json',
    logFile: '/opt/fcmediaagent/logs/monitor.log',
    webhookTimeoutMs: 5000,
  },
};

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

function safeExists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch (e) {
    return false;
  }
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function truncate(text, max) {
  const s = String(text === undefined || text === null ? '' : text);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function describeError(err) {
  if (!err) return '未知错误';
  if (err.name === 'TimeoutError') return '请求超时';
  if (err.name === 'AbortError') return '请求被中止';
  const code = err.code ? String(err.code) : '';
  const msg = err.message ? String(err.message) : String(err);
  return code && msg.indexOf(code) < 0 ? code + ' ' + msg : msg;
}

function redact(text, secret) {
  let s = String(text === undefined || text === null ? '' : text);
  if (secret) s = s.split(secret).join('***');
  return s;
}

function formatTime(date, timeZone) {
  const zone = timeZone || 'Asia/Shanghai';
  try {
    const fmt = new Intl.DateTimeFormat('sv-SE', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    return fmt.format(date) + ' (' + zone + ')';
  } catch (e) {
    return date.toISOString();
  }
}

/* ------------------------------------------------------------------ */
/* 参数与配置                                                          */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { once: true, dryRun: false, strict: false, help: false, configPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') args.once = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--strict') args.strict = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--config') {
      const v = argv[i + 1];
      if (!v) throw new Error('--config 需要一个文件路径参数');
      args.configPath = v;
      i++;
    } else if (a.indexOf('--config=') === 0) {
      const v = a.slice('--config='.length);
      if (!v) throw new Error('--config 需要一个文件路径参数');
      args.configPath = v;
    } else {
      throw new Error('未知参数：' + a + '（可用：--once、--dry-run、--config <path>、--strict、--help）');
    }
  }
  return args;
}

function printUsage() {
  const lines = [
    'fcmediaagent 生产监控告警（P44 WP2）',
    '',
    '用法：',
    '  node monitor.mjs --once              单跑一次并写日志（默认行为）',
    '  node monitor.mjs --dry-run           只打印结果，不写日志、不写 state、不推送',
    '  node monitor.mjs --config <path>     指定配置文件（默认找脚本同目录 monitor.config.json）',
    '  node monitor.mjs --strict            存在告警时退出码 1（默认恒为 0）',
    '  node monitor.mjs --help              显示本帮助',
    '',
    '退出码：0 正常运行；1 --strict 下有告警或日志写入失败；2 参数/配置错误。',
  ];
  console.log(lines.join('\n'));
}

function resolveConfigPath(explicitPath) {
  if (explicitPath) return path.resolve(explicitPath);
  const candidates = [];
  if (process.env.MONITOR_CONFIG) candidates.push(path.resolve(process.env.MONITOR_CONFIG));
  candidates.push(path.join(SCRIPT_DIR, 'monitor.config.json'));
  candidates.push('/opt/fcmediaagent/monitor.config.json');
  candidates.push(path.join('/opt/fcmediaagent/ops', 'monitor.config.json'));
  for (const p of candidates) {
    if (safeExists(p)) return p;
  }
  return path.join(SCRIPT_DIR, 'monitor.config.json');
}

function mergeConfig(base, override, prefix, warnings) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!override || typeof override !== 'object' || Array.isArray(override)) return out;
  for (const key of Object.keys(override)) {
    if (key.indexOf('_') === 0) continue; // 以下划线开头的是说明字段，忽略
    if (!(key in out)) {
      warnings.push('未知配置项：' + prefix + key + '（已忽略）');
      continue;
    }
    const bv = out[key];
    const ov = override[key];
    if (bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[key] = mergeConfig(bv, ov, prefix + key + '.', warnings);
    } else {
      out[key] = ov;
    }
  }
  return out;
}

function loadConfig(explicitPath) {
  const warnings = [];
  const file = resolveConfigPath(explicitPath);
  let user = null;
  let source = null;
  if (safeExists(file)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error('配置文件读取失败：' + file + '：' + describeError(err));
    }
    try {
      user = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (err) {
      throw new Error('配置文件不是合法 JSON：' + file + '：' + describeError(err));
    }
    source = file;
  }
  const config = mergeConfig(DEFAULTS, user || {}, '', warnings);
  config.alert = config.alert || {};
  config.alert.webhookUrl = String(config.alert.webhookUrl || '').trim();
  config.alert.cooldownMinutes = positiveNumber(config.alert.cooldownMinutes, 60);
  config.alert.webhookTimeoutMs = positiveNumber(config.alert.webhookTimeoutMs, 5000);
  return { config, source, warnings };
}

/* ------------------------------------------------------------------ */
/* 外部命令 / 文件读取                                                  */
/* ------------------------------------------------------------------ */

function runCmd(cmd, args, opts) {
  const options = opts || {};
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: describeError(err), timedOut: false });
      return;
    }
    let out = '';
    let errOut = '';
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (e) { /* 忽略 */ }
    }, options.timeoutMs || 15000);
    child.stdout.on('data', (d) => { if (out.length < 200000) out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { if (errOut.length < 200000) errOut += d.toString('utf8'); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const msg = err && err.code === 'ENOENT' ? '命令不存在：' + cmd : describeError(err);
      resolve({ ok: false, code: -1, stdout: out, stderr: msg, timedOut: timedOut });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderr = timedOut ? (errOut + '\n命令超时（' + (options.timeoutMs || 15000) + 'ms）') : errOut;
      resolve({ ok: code === 0 && !timedOut, code: code === null ? -1 : code, signal: signal || null, stdout: out, stderr: stderr, timedOut: timedOut });
    });
  });
}

function readEnvFile(file) {
  const map = Object.create(null);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return map;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.indexOf('#') === 0) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2) {
      const first = val.charAt(0);
      const last = val.charAt(val.length - 1);
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) val = val.slice(1, -1);
    }
    map[key] = val;
  }
  return map;
}

function parseDatabaseUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(String(raw));
    if (u.protocol !== 'mysql:' && u.protocol !== 'mariadb:') return null;
    const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (!u.username || !database) return null;
    const password = u.password ? decodeURIComponent(u.password) : '';
    return { user: decodeURIComponent(u.username), password: password, database: database, host: u.hostname, port: u.port || '3306' };
  } catch (e) {
    return null;
  }
}

async function tailLines(file, maxLines) {
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    const size = stat.size;
    const readSize = Math.min(size, 512 * 1024);
    if (readSize <= 0) return [];
    const start = size - readSize;
    const buf = Buffer.alloc(readSize);
    await handle.read(buf, 0, readSize, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    const lines = text.split(/\r?\n/);
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
  } finally {
    await handle.close();
  }
}

/* ------------------------------------------------------------------ */
/* 检查结果构造器                                                      */
/* ------------------------------------------------------------------ */

function pass(message, detail) {
  return { state: 'ok', message: message, detail: detail || {} };
}

function fail(message, detail) {
  return { state: 'fail', message: message, detail: detail || {} };
}

function skipped(message, detail) {
  return { state: 'skip', message: message, detail: detail || {} };
}

/* ------------------------------------------------------------------ */
/* 检查 1：API 健康                                                    */
/* ------------------------------------------------------------------ */

async function checkApiHealth(ctx) {
  const c = ctx.config.apiHealth || {};
  if (!c.enabled) return skipped('配置已禁用（apiHealth.enabled=false）');
  const timeoutMs = positiveNumber(c.timeoutMs, 3000);
  const url = String(c.url || DEFAULTS.apiHealth.url);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'cache-control': 'no-store' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - started;
    if (res.status !== 200) {
      return fail('健康检查返回 HTTP ' + res.status + '（期望 200）', { url: url, httpStatus: res.status, latencyMs: latencyMs });
    }
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch (e) {
      return fail('健康检查响应不是合法 JSON', { url: url, httpStatus: res.status, sample: truncate(text, 200) });
    }
    const db = body && typeof body.db === 'string' ? body.db : 'unknown';
    if (db !== 'up') {
      return fail('数据库不可用：db=' + db + '（期望 up）', { url: url, httpStatus: res.status, db: db, latencyMs: latencyMs });
    }
    return pass('HTTP 200，db=up（' + latencyMs + 'ms）', { url: url, httpStatus: res.status, db: db, latencyMs: latencyMs });
  } catch (err) {
    const reason = describeError(err);
    if (!IS_LINUX) return skipped('本机无生产环境（' + reason + '）：需要生产环境');
    return fail('健康检查请求失败：' + reason, { url: url, error: reason, timeoutMs: timeoutMs });
  }
}

/* ------------------------------------------------------------------ */
/* 检查 2：队列积压                                                    */
/* ------------------------------------------------------------------ */

async function checkQueueBacklog(ctx) {
  const c = ctx.config.queueBacklog || {};
  if (!c.enabled) return skipped('配置已禁用（queueBacklog.enabled=false）');
  const envFile = String(c.envFile || PROD_ENV_FILE);
  const envMap = readEnvFile(envFile);
  const creds = parseDatabaseUrl(envMap.DATABASE_URL);
  if (!creds) {
    const msg = '未能从 ' + envFile + ' 解析 DATABASE_URL';
    if (!IS_LINUX) return skipped('本机无生产环境：' + msg + '，需要生产环境');
    return fail(msg + '，无法查询队列积压', { envFile: envFile });
  }
  const staleMinutes = positiveNumber(c.staleMinutes, 30);
  const threshold = Number.isFinite(Number(c.threshold)) ? Number(c.threshold) : 20;
  const sql = "select count(*) from EmployeeTask where status='queued' and createdAt < (now() - interval " + staleMinutes + " minute)";
  const container = String(c.mysqlContainer || 'fcm-mysql');
  const args = ['exec', '-e', 'MYSQL_PWD', container, 'mysql', '-u' + creds.user, '-N', '-B', '-D', creds.database, '-e', sql];
  const env = Object.assign({}, process.env);
  env.MYSQL_PWD = creds.password;
  const r = await runCmd(String(c.dockerBin || 'docker'), args, { timeoutMs: positiveNumber(c.timeoutMs, 20000), env: env });
  const detail = { container: container, database: creds.database, staleMinutes: staleMinutes, threshold: threshold };
  if (!r.ok) {
    const errText = truncate(redact(r.stderr || r.stdout, creds.password).replace(/\s+/g, ' ').trim(), 300);
    if (!IS_LINUX) return skipped('本机无生产环境（docker 不可用：' + errText + '）：需要生产环境');
    if (errText.indexOf('命令不存在') >= 0) return fail('找不到 docker 命令，无法查询队列积压', detail);
    return fail('查询队列积压失败：' + errText, Object.assign({ error: errText }, detail));
  }
  const lines = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '');
  const last = lines.length ? lines[lines.length - 1] : '';
  const count = parseInt(last, 10);
  if (!Number.isFinite(count)) {
    return fail('无法解析队列条数（mysql 输出：' + truncate(last || '(空)', 120) + '）', Object.assign({ raw: truncate(r.stdout, 200) }, detail));
  }
  const fullDetail = Object.assign({ queuedCount: count }, detail);
  if (count > threshold) {
    return fail('早于 ' + staleMinutes + ' 分钟的 queued 任务 ' + count + ' 条（阈值 ' + threshold + '）', fullDetail);
  }
  return pass('早于 ' + staleMinutes + ' 分钟的 queued 任务 ' + count + ' 条（阈值 ' + threshold + '）', fullDetail);
}

/* ------------------------------------------------------------------ */
/* 检查 3：worker 心跳                                                 */
/* ------------------------------------------------------------------ */

async function checkWorkerHeartbeat(ctx) {
  const c = ctx.config.workerHeartbeat || {};
  if (!c.enabled) return skipped('配置已禁用（workerHeartbeat.enabled=false）');
  const logPath = String(c.logPath || DEFAULTS.workerHeartbeat.logPath);
  const maxIdle = positiveNumber(c.maxIdleMinutes, 10);
  let st;
  try {
    st = await fsp.stat(logPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      if (!IS_LINUX) return skipped('本机无生产环境：' + logPath + ' 不存在，需要生产环境');
      return fail('worker 日志不存在：' + logPath, { logPath: logPath });
    }
    return fail('无法读取 worker 日志状态：' + describeError(err), { logPath: logPath });
  }
  const idleMinutes = round1((Date.now() - st.mtimeMs) / 60000);
  const detail = {
    logPath: logPath,
    idleMinutes: idleMinutes,
    maxIdleMinutes: maxIdle,
    mtime: new Date(st.mtimeMs).toISOString(),
    sizeBytes: st.size,
  };
  if (idleMinutes > maxIdle) {
    return fail('worker 日志 ' + idleMinutes + ' 分钟未更新（阈值 ' + maxIdle + ' 分钟）', detail);
  }
  return pass('worker 日志 ' + idleMinutes + ' 分钟前更新（阈值 ' + maxIdle + ' 分钟）', detail);
}

/* ------------------------------------------------------------------ */
/* 检查 4：上游欠费                                                    */
/* ------------------------------------------------------------------ */

async function checkUpstreamOverdue(ctx) {
  const c = ctx.config.upstreamOverdue || {};
  if (!c.enabled) return skipped('配置已禁用（upstreamOverdue.enabled=false）');
  const paths = Array.isArray(c.logPaths) ? c.logPaths.map(String) : [];
  const tail = positiveNumber(c.tailLines, 200);
  const patternText = String(c.pattern || 'AccountOverdueError');
  let re;
  try {
    re = new RegExp(patternText, 'i');
  } catch (e) {
    re = new RegExp('AccountOverdueError', 'i');
  }
  let scanned = 0;
  let matched = 0;
  const samples = [];
  const missing = [];
  for (const p of paths) {
    try {
      const lines = await tailLines(p, tail);
      scanned += lines.length;
      for (const line of lines) {
        if (re.test(line)) {
          matched++;
          if (samples.length < 3) samples.push(truncate(line.trim(), 240));
        }
      }
    } catch (err) {
      missing.push(err && err.code === 'ENOENT' ? p : p + '（' + describeError(err) + '）');
    }
  }
  const detail = {
    scannedLines: scanned,
    matchedLines: matched,
    samples: samples,
    missingFiles: missing,
    pattern: patternText,
    tailLines: tail,
  };
  if (scanned === 0) {
    const msg = '未读到任何日志（缺失/不可读：' + (missing.join('、') || '无') + '）';
    if (!IS_LINUX) return skipped('本机无生产环境：' + msg + '，需要生产环境');
    return fail(msg + '，无法判断上游欠费', detail);
  }
  if (matched > 0) {
    return fail('最近日志出现上游欠费/余额告警 ' + matched + ' 处（匹配 ' + patternText + '）', detail);
  }
  return pass('最近 ' + scanned + ' 行日志未发现上游欠费', detail);
}

/* ------------------------------------------------------------------ */
/* 检查 5：磁盘 / 内存                                                 */
/* ------------------------------------------------------------------ */

async function checkResources(ctx) {
  const c = ctx.config.resources || {};
  if (!c.enabled) return skipped('配置已禁用（resources.enabled=false）');
  const diskMax = positiveNumber(c.diskMaxUsedPercent, 85);
  const memMin = positiveNumber(c.memMinAvailableMB, 300);
  const diskPath = String(c.diskPath || '/');
  const problems = [];
  const detail = {};
  let diskSkipped = false;

  if (!IS_LINUX && diskPath === '/') {
    diskSkipped = true;
    detail.disk = { skipped: '本机无 / 挂载点（需要生产环境）' };
  } else {
    try {
      const s = await fsp.statfs(diskPath);
      const bsize = Number(s.bsize) || 4096;
      const blocks = Number(s.blocks) || 0;
      const bfree = Number(s.bfree) || 0;
      const bavail = Number(s.bavail) || 0;
      const usedBytes = (blocks - bfree) * bsize;
      const availBytes = bavail * bsize;
      const denom = usedBytes + availBytes;
      const usedPercent = denom > 0 ? round1((usedBytes / denom) * 100) : 0;
      detail.disk = {
        path: diskPath,
        usedPercent: usedPercent,
        totalGB: round1((blocks * bsize) / 1073741824),
        availGB: round1(availBytes / 1073741824),
        maxUsedPercent: diskMax,
      };
      if (usedPercent > diskMax) problems.push('磁盘 ' + diskPath + ' 使用率 ' + usedPercent + '%（阈值 ' + diskMax + '%）');
    } catch (err) {
      if (!IS_LINUX) {
        diskSkipped = true;
        detail.disk = { skipped: '本机无生产环境：' + describeError(err) };
      } else {
        problems.push('无法读取磁盘使用率：' + describeError(err));
      }
    }
  }

  let availableMB = null;
  let memSource = null;
  try {
    const text = await fsp.readFile('/proc/meminfo', 'utf8');
    const m = text.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (m) {
      availableMB = Math.round(Number(m[1]) / 1024);
      memSource = '/proc/meminfo';
    }
  } catch (e) {
    /* 非 Linux 无 /proc，走 os.freemem() */
  }
  if (availableMB === null) {
    availableMB = Math.round(os.freemem() / 1048576);
    memSource = 'os.freemem()';
  }
  detail.memory = {
    availableMB: availableMB,
    minAvailableMB: memMin,
    totalMB: Math.round(os.totalmem() / 1048576),
    source: memSource,
  };
  if (availableMB < memMin) problems.push('可用内存 ' + availableMB + 'MB（阈值 ≥ ' + memMin + 'MB）');

  if (problems.length) return fail(problems.join('；'), detail);
  if (diskSkipped) return skipped('磁盘检查跳过（需要生产环境）；可用内存 ' + availableMB + 'MB', detail);
  return pass('磁盘 ' + detail.disk.usedPercent + '% / 可用内存 ' + availableMB + 'MB，均在阈值内', detail);
}

/* ------------------------------------------------------------------ */
/* 检查 6：备份新鲜度                                                  */
/* ------------------------------------------------------------------ */

async function checkBackupFreshness(ctx) {
  const c = ctx.config.backupFreshness || {};
  if (!c.enabled) return skipped('配置已禁用（backupFreshness.enabled=false）');
  const dir = String(c.backupDir || DEFAULTS.backupFreshness.backupDir);
  const maxAgeHours = positiveNumber(c.maxAgeHours, 26);
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      if (!IS_LINUX) return skipped('本机无生产环境：备份目录 ' + dir + ' 不存在，需要生产环境');
      return fail('备份目录不存在：' + dir, { backupDir: dir });
    }
    return fail('无法读取备份目录：' + describeError(err), { backupDir: dir });
  }
  const files = names.filter((n) => /\.sql\.gz$/i.test(n));
  if (!files.length) {
    if (!IS_LINUX) return skipped('本机无生产环境：备份目录下没有 *.sql.gz，需要生产环境');
    return fail('备份目录下没有任何 *.sql.gz：' + dir, { backupDir: dir, fileCount: 0 });
  }
  let newest = null;
  for (const n of files) {
    const full = path.join(dir, n);
    try {
      const st = await fsp.stat(full);
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { name: n, mtimeMs: st.mtimeMs, sizeBytes: st.size };
    } catch (e) {
      /* 单个文件读取失败不影响整体判断 */
    }
  }
  if (!newest) return fail('无法读取备份文件状态：' + dir, { backupDir: dir });
  const ageHours = round1((Date.now() - newest.mtimeMs) / 3600000);
  const detail = {
    backupDir: dir,
    newestFile: newest.name,
    ageHours: ageHours,
    maxAgeHours: maxAgeHours,
    sizeMB: round1(newest.sizeBytes / 1048576),
    mtime: new Date(newest.mtimeMs).toISOString(),
    fileCount: files.length,
  };
  if (ageHours > maxAgeHours) {
    return fail('最新备份 ' + newest.name + ' 已 ' + ageHours + ' 小时（阈值 ' + maxAgeHours + ' 小时）', detail);
  }
  return pass('最新备份 ' + newest.name + ' 距今 ' + ageHours + ' 小时（阈值 ' + maxAgeHours + ' 小时）', detail);
}

const CHECKS = {
  api_health: checkApiHealth,
  queue_backlog: checkQueueBacklog,
  worker_heartbeat: checkWorkerHeartbeat,
  upstream_overdue: checkUpstreamOverdue,
  resources: checkResources,
  backup_freshness: checkBackupFreshness,
};

/* ------------------------------------------------------------------ */
/* state / 日志 / webhook                                              */
/* ------------------------------------------------------------------ */

function defaultState() {
  return { version: 1, updatedAt: null, checks: {} };
}

async function loadState(file) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    return defaultState();
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && parsed.checks && typeof parsed.checks === 'object') {
      return parsed;
    }
    throw new Error('结构不合法');
  } catch (err) {
    try {
      await fsp.rename(file, file + '.broken-' + Date.now());
      console.error('[monitor] state 文件损坏，已另存备份并使用空状态：' + describeError(err));
    } catch (e) {
      /* 备份失败不影响运行 */
    }
    return defaultState();
  }
}

async function saveState(file, state) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, file);
}

async function appendLog(file, entry) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
}

function detectWebhookKind(url) {
  const u = String(url).toLowerCase();
  if (u.indexOf('dingtalk') >= 0) return 'dingtalk';
  if (u.indexOf('feishu') >= 0 || u.indexOf('larksuite') >= 0) return 'feishu';
  return 'wecom';
}

function buildWebhookPayload(url, markdown, title) {
  const kind = detectWebhookKind(url);
  if (kind === 'dingtalk') return { msgtype: 'markdown', markdown: { title: title, text: markdown } };
  if (kind === 'feishu') return { msg_type: 'text', content: { text: markdown.replace(/[*#>]/g, '') } };
  return { msgtype: 'markdown', markdown: { content: markdown } };
}

function maskWebhook(url) {
  try {
    const u = new URL(String(url));
    return u.protocol + '//' + u.host + '/***';
  } catch (e) {
    return '(无法解析的 webhook 地址)';
  }
}

async function postWebhook(url, markdown, title, timeoutMs) {
  const payload = buildWebhookPayload(url, markdown, title);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + '：' + truncate(text, 200));
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    /* 部分网关返回非 JSON，视为成功 */
  }
  const errcode = parsed && (parsed.errcode !== undefined ? parsed.errcode : parsed.code);
  if (errcode !== undefined && Number(errcode) !== 0) {
    throw new Error('机器人返回 errcode=' + errcode + '：' + truncate(String(parsed.errmsg || parsed.msg || ''), 200));
  }
  return { httpStatus: res.status, kind: detectWebhookKind(url) };
}

function briefDetail(detail) {
  if (!detail || typeof detail !== 'object') return '';
  const parts = [];
  const keys = Object.keys(detail);
  for (const k of keys) {
    if (k === 'durationMs' || k === 'suppressed' || k === 'cooldownUntil') continue;
    const v = detail[k];
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      parts.push(k + '=' + truncate(v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' | '), 160));
    } else if (typeof v === 'object') {
      parts.push(k + '=' + truncate(JSON.stringify(v), 160));
    } else {
      parts.push(k + '=' + truncate(String(v), 160));
    }
  }
  return truncate(parts.join('；'), 500);
}

function buildMarkdown(hostname, nowText, alertItems, recoveryItems) {
  const lines = [];
  if (alertItems.length) {
    lines.push('### 🔴 监控告警（' + alertItems.length + ' 项）');
    lines.push('> 主机：' + hostname + '　时间：' + nowText);
    for (const it of alertItems) {
      lines.push('');
      lines.push('**' + it.label + '**：' + it.message);
      const brief = briefDetail(it.detail);
      if (brief) lines.push('> ' + brief);
    }
  }
  if (recoveryItems.length) {
    if (lines.length) lines.push('');
    lines.push('### ✅ 监控恢复（' + recoveryItems.length + ' 项）');
    lines.push('> 主机：' + hostname + '　时间：' + nowText);
    for (const it of recoveryItems) {
      lines.push('');
      lines.push('**' + it.label + '**：已恢复正常，' + it.message);
    }
  }
  let text = lines.join('\n');
  if (text.length > 3500) text = text.slice(0, 3500) + '\n…（内容已截断）';
  return text;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error('[monitor] 参数错误：' + describeError(err));
    printUsage();
    return 2;
  }
  if (args.help) {
    printUsage();
    return 0;
  }

  let config;
  let source;
  let warnings;
  try {
    const loaded = loadConfig(args.configPath);
    config = loaded.config;
    source = loaded.source;
    warnings = loaded.warnings;
  } catch (err) {
    console.error('[monitor] 配置错误：' + describeError(err));
    return 2;
  }
  for (const w of warnings) console.error('[monitor] 配置警告：' + w);

  const dryRun = args.dryRun;
  const now = new Date();
  const nowText = formatTime(now, config.timeZone);
  const hostname = os.hostname();
  const logFile = String(config.alert.logFile || DEFAULTS.alert.logFile);
  const stateFile = String(config.alert.stateFile || DEFAULTS.alert.stateFile);
  const cooldownMs = config.alert.cooldownMinutes * 60000;

  if (dryRun) {
    console.log('[monitor] dry-run：只打印结果，不写日志、不写 state、不推送 webhook');
    console.log('[monitor] 配置文件：' + (source || '未找到（使用内置默认值）'));
    console.log('[monitor] 日志将写入：' + logFile + '；state：' + stateFile);
    if (!IS_LINUX) console.log('[monitor] 未检测到生产环境（当前平台 ' + process.platform + '）：不可用检查将标记 skipped，需要生产环境');
  }

  const ctx = { config: config, dryRun: dryRun, now: now, hostname: hostname, isLinux: IS_LINUX };

  const results = [];
  for (const name of CHECK_ORDER) {
    const started = Date.now();
    let r;
    try {
      r = await CHECKS[name](ctx);
    } catch (err) {
      r = fail('检查执行异常：' + describeError(err), { error: describeError(err) });
    }
    if (!r || !r.state) r = fail('检查未返回有效结果', {});
    results.push({ name: name, label: CHECK_LABELS[name], result: r, durationMs: Date.now() - started });
  }

  const state = await loadState(stateFile);
  const alertItems = [];
  const recoveryItems = [];
  const entries = [];

  for (const item of results) {
    const r = item.result;
    const prevRaw = state.checks[item.name];
    const prev = prevRaw && typeof prevRaw === 'object' ? prevRaw : { alerting: false, lastAlertAt: null, since: null };
    const level = r.state === 'fail' ? 'alert' : (r.state === 'ok' ? 'ok' : 'skipped');
    const detail = Object.assign({}, r.detail, { durationMs: item.durationMs });
    const entry = { ts: now.toISOString(), check: item.name, level: level, message: r.message, detail: detail };
    let push = null;

    if (r.state === 'fail') {
      const lastAlertMs = prev.lastAlertAt ? Date.parse(prev.lastAlertAt) : 0;
      const cooling = Boolean(prev.alerting && lastAlertMs && (now.getTime() - lastAlertMs < cooldownMs));
      const next = Object.assign({}, prev, {
        alerting: true,
        since: prev.alerting && prev.since ? prev.since : now.toISOString(),
        lastResult: 'alert',
        lastMessage: r.message,
      });
      if (!cooling) {
        next.lastAlertAt = now.toISOString();
        push = 'alert';
      } else {
        entry.detail.suppressed = true;
        entry.detail.cooldownUntil = new Date(lastAlertMs + cooldownMs).toISOString();
      }
      state.checks[item.name] = next;
      if (push === 'alert') {
        alertItems.push({ check: item.name, label: item.label, message: r.message, detail: r.detail });
      }
    } else if (r.state === 'ok') {
      const wasAlerting = Boolean(prev.alerting);
      const next = Object.assign({}, prev, {
        alerting: false,
        since: null,
        lastResult: 'ok',
        lastMessage: r.message,
        lastOkAt: now.toISOString(),
      });
      if (wasAlerting) {
        next.recoveredAt = now.toISOString();
        recoveryItems.push({ check: item.name, label: item.label, message: r.message, detail: r.detail });
      }
      state.checks[item.name] = next;
    } else {
      state.checks[item.name] = Object.assign({}, prev, { lastResult: 'skipped', lastMessage: r.message });
    }

    entries.push(entry);
    const tag = level === 'alert' ? '[ALERT]' : (level === 'ok' ? '[  OK ]' : '[SKIP ]');
    console.log(tag + ' ' + item.name + '：' + r.message);
  }

  const counts = { ok: 0, alert: 0, skipped: 0 };
  for (const e of entries) {
    if (e.level === 'alert') counts.alert++;
    else if (e.level === 'ok') counts.ok++;
    else counts.skipped++;
  }
  const pendingPushes = alertItems.length + recoveryItems.length;
  const summary = {
    ts: now.toISOString(),
    check: 'run',
    level: counts.alert ? 'warn' : 'ok',
    message: '本轮完成：' + entries.length + ' 项，告警 ' + counts.alert + '，正常 ' + counts.ok + '，跳过 ' + counts.skipped + '，待推送 ' + pendingPushes + ' 项',
    detail: {
      dryRun: dryRun,
      platform: process.platform,
      hostname: hostname,
      configSource: source,
      counts: counts,
      pendingPushes: pendingPushes,
    },
  };

  let logWriteFailed = false;
  if (dryRun) {
    for (const e of entries.concat([summary])) console.log('[dry-run] ' + JSON.stringify(e));
  } else {
    try {
      for (const e of entries) await appendLog(logFile, e);
      await appendLog(logFile, summary);
    } catch (err) {
      logWriteFailed = true;
      console.error('[monitor] 写监控日志失败：' + describeError(err) + '（文件：' + logFile + '）');
    }
  }

  state.updatedAt = now.toISOString();
  if (!dryRun) {
    try {
      await saveState(stateFile, state);
    } catch (err) {
      console.error('[monitor] 写 state 失败：' + describeError(err) + '（文件：' + stateFile + '）');
    }
  }

  const envMap = readEnvFile(PROD_ENV_FILE);
  const webhookUrl = String(
    (process.env.ALERT_WEBHOOK_URL || '').trim() ||
    (config.alert.webhookUrl || '').trim() ||
    (envMap.ALERT_WEBHOOK_URL || '').trim() ||
    ''
  );

  if (pendingPushes === 0) {
    console.log('[monitor] 无需推送' + (counts.alert ? '（告警仍在冷却期内）' : '（全部正常）'));
  } else if (!webhookUrl) {
    console.log('[monitor] 有 ' + pendingPushes + ' 项待推送，但未配置 ALERT_WEBHOOK_URL（仅落日志）');
  } else {
    const markdown = buildMarkdown(hostname, nowText, alertItems, recoveryItems);
    const title = alertItems.length ? 'fcmediaagent 监控告警' : 'fcmediaagent 监控恢复';
    if (dryRun) {
      console.log('[dry-run] 将向 ' + maskWebhook(webhookUrl) + ' 推送 1 条汇总消息（含 ' + pendingPushes + ' 项，' + detectWebhookKind(webhookUrl) + '）：');
      console.log(markdown);
    } else {
      let pushEntry;
      try {
        const r = await postWebhook(webhookUrl, markdown, title, config.alert.webhookTimeoutMs);
        pushEntry = {
          ts: new Date().toISOString(),
          check: 'push',
          level: 'ok',
          message: '已推送 1 条汇总消息（含 ' + pendingPushes + ' 项，' + r.kind + '，HTTP ' + r.httpStatus + '）',
          detail: { target: maskWebhook(webhookUrl), alerts: alertItems.length, recoveries: recoveryItems.length },
        };
      } catch (err) {
        pushEntry = {
          ts: new Date().toISOString(),
          check: 'push',
          level: 'error',
          message: '推送失败（含 ' + pendingPushes + ' 项）：' + describeError(err),
          detail: { target: maskWebhook(webhookUrl), alerts: alertItems.length, recoveries: recoveryItems.length },
        };
        console.error('[monitor] ' + pushEntry.message);
      }
      try {
        await appendLog(logFile, pushEntry);
      } catch (err) {
        console.error('[monitor] 写推送记录失败：' + describeError(err));
      }
      if (pushEntry.level === 'ok') console.log('[monitor] ' + pushEntry.message);
    }
  }

  if (dryRun) console.log('[monitor] dry-run 结束：退出码 0');
  if (logWriteFailed) return 1;
  if (args.strict && counts.alert > 0) return 1;
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('[monitor] 未捕获异常：' + (err && err.stack ? err.stack : describeError(err)));
    process.exitCode = 2;
  });
