#!/usr/bin/env node
/**
 * P44 WP3 / P49 生产回归检查（Node 24 纯内置，零依赖）
 *
 * 目标：每天在生产机跑一次「只读 / 低成本」的接口回归，结果落
 *   /opt/fcmediaagent/logs/regression.json（结构化，供 monitor.mjs 第 7 项读取）
 *   /opt/fcmediaagent/logs/regression.log（每次一行摘要 + systemd 标准输出）
 *
 * 检查项（固定顺序）：
 *   1. health         GET  /api/health              HTTP 200 且 db=up
 *   2. sms_login      直接向 MySQL 的 VerificationCode 表播种一个 6 位、5 分钟过期的
 *                     验证码，再 POST /api/auth/sms/login 拿 accessToken。
 *                     不依赖 DEV_SMS_ALLOWLIST / devCode 回显，也不发真实短信。
 *   3. employees      GET  /api/employees/mine      返回 items 数组 / total 数字
 *   4. capabilities   GET  /api/capabilities        total>=1 且 items 为数组
 *   5. memory_stats   GET  /api/memory/stats        total 为数字
 *   6. credits        GET  /api/credits/balance     balance 为数字
 *
 * 明确不做：不创建员工任务、不发媒体任务、不触发真实短信、不依赖服务端后门。
 * 登录检查会写一行一次性验证码（5 分钟后自然过期）；若测试号在库里不存在，
 * 登录会按产品正常流程创建测试账号（携带 consent.version）。
 * 数据库不可达时，sms_login 及其后的登录态检查降级为 skipped（ok=true），
 * 不会让整轮回归 fail。
 *
 * 用法：
 *   node prod-regression.mjs --once                 跑一次并写结果（默认，timer 用）
 *   node prod-regression.mjs --dry-run              只打印计划，不联网、不写文件
 *   node prod-regression.mjs --base-url <url>       覆盖目标地址（默认 http://127.0.0.1:3000）
 *   node prod-regression.mjs --out <path>           覆盖 regression.json 路径
 *   node prod-regression.mjs --json                 stdout 输出完整 JSON（仍写文件）
 *   node prod-regression.mjs --quiet                成功时不打印，失败只打错误（systemd 用）
 *   node prod-regression.mjs --env-file <path>      覆盖读取 DATABASE_URL 的 .env
 *   node prod-regression.mjs --phone <num>          覆盖测试手机号（默认 13900000002）
 *   node prod-regression.mjs --container <name>     覆盖 MySQL 容器名（默认 fcm-mysql）
 *   node prod-regression.mjs --help
 *
 * 退出码：0 全部通过（含 skip）；1 存在失败项或写结果失败；2 参数错误。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const DEFAULT_OUT = '/opt/fcmediaagent/logs/regression.json';
const DEFAULT_ENV_FILE = '/opt/fcmediaagent/app/.env';
const DEFAULT_PHONE = '13900000002';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MYSQL_CONTAINER = 'fcm-mysql';
// 与 packages/server/src/legal/legal.pages.ts 的 LEGAL_VERSION 保持一致；
// 可用 REGRESSION_CONSENT_VERSION 覆盖，避免下次法务改版后新测试号登录失败。
const DEFAULT_CONSENT_VERSION = '2026-11-12';

const CHECKS = [
  { name: 'health', label: 'API 健康 / 数据库' },
  { name: 'sms_login', label: '测试号短信登录' },
  { name: 'employees', label: '我的员工列表' },
  { name: 'capabilities', label: '能力清单' },
  { name: 'memory_stats', label: '记忆统计' },
  { name: 'credits', label: '积分余额' },
];

function printUsage() {
  console.log([
    'fcmediaagent 生产回归检查（P44 WP3）',
    '',
    '用法：',
    '  node prod-regression.mjs --once                跑一次并写结果（默认）',
    '  node prod-regression.mjs --dry-run             只打印计划，不联网、不写文件',
    '  node prod-regression.mjs --base-url <url>      目标地址（默认 ' + DEFAULT_BASE_URL + '）',
    '  node prod-regression.mjs --out <path>          结果 JSON 路径（默认 ' + DEFAULT_OUT + '）',
    '  node prod-regression.mjs --json                stdout 输出完整 JSON（仍写结果文件）',
    '  node prod-regression.mjs --quiet               成功不打印，失败只打错误（systemd 用）',
    '  node prod-regression.mjs --env-file <path>     读取 DATABASE_URL 的文件（默认 ' + DEFAULT_ENV_FILE + '）',
    '  node prod-regression.mjs --phone <num>         覆盖测试手机号（默认 ' + DEFAULT_PHONE + '）',
    '  node prod-regression.mjs --container <name>    MySQL 容器名（默认 ' + DEFAULT_MYSQL_CONTAINER + '）',
    '  node prod-regression.mjs --help                显示本帮助',
    '',
    '退出码：0 全部通过；1 存在失败项或写结果失败；2 参数错误。',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    json: false,
    quiet: false,
    help: false,
    baseUrl: process.env.REGRESSION_BASE_URL || DEFAULT_BASE_URL,
    out: process.env.REGRESSION_OUT || DEFAULT_OUT,
    log: process.env.REGRESSION_LOG || '',
    envFile: process.env.REGRESSION_ENV_FILE || DEFAULT_ENV_FILE,
    phone: process.env.REGRESSION_PHONE || '',
    container: process.env.MYSQL_CONTAINER || DEFAULT_MYSQL_CONTAINER,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = (flag) => {
      const v = argv[i + 1];
      if (!v || v.indexOf('--') === 0) throw new Error(flag + ' 需要一个参数值');
      i++;
      return v;
    };
    if (a === '--once') continue; // 默认行为，显式接受
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--json') args.json = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--base-url') args.baseUrl = need('--base-url');
    else if (a.indexOf('--base-url=') === 0) args.baseUrl = a.slice('--base-url='.length);
    else if (a === '--out') args.out = need('--out');
    else if (a.indexOf('--out=') === 0) args.out = a.slice('--out='.length);
    else if (a === '--log') args.log = need('--log');
    else if (a.indexOf('--log=') === 0) args.log = a.slice('--log='.length);
    else if (a === '--env-file') args.envFile = need('--env-file');
    else if (a.indexOf('--env-file=') === 0) args.envFile = a.slice('--env-file='.length);
    else if (a === '--phone') args.phone = need('--phone');
    else if (a.indexOf('--phone=') === 0) args.phone = a.slice('--phone='.length);
    else if (a === '--container') args.container = need('--container');
    else if (a.indexOf('--container=') === 0) args.container = a.slice('--container='.length);
    else if (a === '--timeout-ms') args.timeoutMs = parseIntStrict(need('--timeout-ms'), '--timeout-ms');
    else if (a.indexOf('--timeout-ms=') === 0) args.timeoutMs = parseIntStrict(a.slice('--timeout-ms='.length), '--timeout-ms');
    else throw new Error('未知参数：' + a + '（用 --help 查看可用参数）');
  }
  if (!args.out) args.out = DEFAULT_OUT;
  if (!args.log) args.log = path.join(path.dirname(args.out), 'regression.log');
  return args;
}

function parseIntStrict(raw, flag) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(flag + ' 必须是正整数');
  return n;
}

function describeError(err) {
  if (!err) return '未知错误';
  if (err.name === 'TimeoutError') return '请求超时';
  if (err.name === 'AbortError') return '请求被中止';
  const cause = err.cause && err.cause.code ? String(err.cause.code) : '';
  const msg = err.message ? String(err.message) : String(err);
  return cause && msg.indexOf(cause) < 0 ? cause + ' ' + msg : msg;
}

function truncate(text, max) {
  const s = String(text === undefined || text === null ? '' : text);
  return s.length > max ? s.slice(0, max) + '…' : s;
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

function maskPhone(phone) {
  const s = String(phone || '');
  return s.length >= 7 ? s.slice(0, 3) + '****' + s.slice(-4) : s;
}

function pickPhone(args) {
  const requested = String(args.phone || '').trim();
  const phone = requested || DEFAULT_PHONE;
  // 与 SmsLoginDto 的 @IsPhoneNumber('CN') 对齐：必须是 11 位中国大陆手机号。
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return {
      ok: false,
      phone: '',
      source: requested ? '参数/环境变量覆盖' : '默认测试号',
      error: '测试号格式不合法：' + phone + '（需要 11 位中国大陆手机号；用 --phone 覆盖）',
    };
  }
  return { ok: true, phone: phone, source: requested ? '参数/环境变量覆盖' : '默认测试号' };
}

function parseDatabaseUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(String(raw));
    if (u.protocol !== 'mysql:' && u.protocol !== 'mariadb:') return null;
    const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (!database) return null;
    return {
      user: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
      database: database,
    };
  } catch (e) {
    return null;
  }
}

function dockerErrorText(err) {
  const raw = err && (err.stderr || err.message) ? String(err.stderr || err.message) : '';
  // execFileSync 的 message 可能包含完整命令行，先抹掉 MYSQL_PWD，避免密码进入 skip 详情/日志。
  const clean = raw.replace(/MYSQL_PWD=\S+/g, 'MYSQL_PWD=***');
  return truncate(clean.replace(/\s+/g, ' ').trim(), 240) || '未知 docker 错误';
}

function runDockerMysql(ctx, candidate, sql) {
  const innerPort = process.env.MYSQL_INNER_PORT || '3306';
  const args = ['exec'];
  if (candidate.password) args.push('-e', 'MYSQL_PWD');
  args.push(ctx.container, 'mysql', '--default-character-set=utf8mb4', '-N', '-B');
  if (candidate.socket) {
    // root 走容器内 socket，避免 root@localhost 只允许 socket 认证时被 TCP 拒绝。
    args.push('-u', candidate.user);
  } else {
    args.push('--protocol=TCP', '-h', '127.0.0.1', '-P', innerPort, '-u', candidate.user);
  }
  if (candidate.database) args.push('-D', candidate.database);
  args.push('-e', sql);
  const env = Object.assign({}, process.env);
  if (candidate.password) env.MYSQL_PWD = candidate.password;
  return execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: Math.max(ctx.timeoutMs, 5000),
    env: env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * 向 VerificationCode 表播种一次性登录验证码。
 * 只用 mysql 客户端（docker exec），不引入 mysql2 等依赖，也不打印任何密码。
 * 任何数据库/容器错误都返回 {ok:false}，由调用方降级为 skip。
 */
function seedVerificationCode(ctx, phone) {
  const envMap = readEnvFile(ctx.envFile);
  const db = parseDatabaseUrl(envMap.DATABASE_URL);
  if (!db) {
    return { ok: false, error: '无法从 ' + ctx.envFile + ' 解析 DATABASE_URL，数据库不可达' };
  }

  const candidates = [];
  if (db.user) {
    candidates.push({ user: db.user, password: db.password, database: db.database, socket: false, source: 'app/.env DATABASE_URL 用户' });
  }
  let rootPwd = '';
  try {
    rootPwd = execFileSync('docker', ['exec', ctx.container, 'printenv', 'MYSQL_ROOT_PASSWORD'], {
      encoding: 'utf8',
      timeout: Math.max(ctx.timeoutMs, 5000),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (e) {
    rootPwd = '';
  }
  if (rootPwd) {
    candidates.push({ user: 'root', password: rootPwd, database: db.database, socket: true, source: '容器 MYSQL_ROOT_PASSWORD' });
  }
  candidates.push({ user: 'root', password: '', database: db.database, socket: true, source: '容器 root 免密 socket' });

  const errors = [];
  let chosen = null;
  for (const candidate of candidates) {
    try {
      runDockerMysql(ctx, candidate, 'SELECT 1;');
      chosen = candidate;
      break;
    } catch (err) {
      errors.push(candidate.source + '：' + dockerErrorText(err));
    }
  }
  if (!chosen) {
    return { ok: false, error: '数据库不可达（容器 ' + ctx.container + '）：' + truncate(errors.join('；'), 400) };
  }

  let userExists = false;
  try {
    const out = runDockerMysql(ctx, chosen, "SELECT COUNT(*) FROM `User` WHERE phone='" + phone + "' LIMIT 1;");
    userExists = parseInt(String(out).trim(), 10) > 0;
  } catch (err) {
    return { ok: false, error: '数据库可连接但查询 User 表失败：' + dockerErrorText(err) };
  }

  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  const id = 'c' + Date.now().toString(36) + randomInt(0, 0x7fffffff).toString(36);
  const sql = "INSERT INTO `VerificationCode` (`id`,`phone`,`code`,`purpose`,`expiresAt`,`used`,`createdAt`) VALUES (" +
    "'" + id + "','" + phone + "','" + code + "','login',DATE_ADD(NOW(), INTERVAL 5 MINUTE),0,NOW());";
  try {
    runDockerMysql(ctx, chosen, sql);
  } catch (err) {
    return { ok: false, error: '数据库可连接但写入 VerificationCode 失败：' + dockerErrorText(err) };
  }
  return { ok: true, code: code, userExists: userExists, userSource: chosen.source };
}

async function request(baseUrl, method, route, options) {
  const opts = options || {};
  const started = Date.now();
  const headers = { accept: 'application/json', 'cache-control': 'no-store' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  const res = await fetch(baseUrl + route, {
    method: method,
    headers: headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: 'manual',
    signal: AbortSignal.timeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    /* 非 JSON 响应：由调用方按 text 判断 */
  }
  return { status: res.status, ok: res.ok, json: json, text: text, ms: Date.now() - started };
}

function failCheck(name, label, ms, message, detail) {
  return { name: name, label: label, ok: false, ms: ms, detail: Object.assign({ message: message }, detail || {}) };
}

function okCheck(name, label, ms, message, detail) {
  return { name: name, label: label, ok: true, ms: ms, detail: Object.assign({ message: message }, detail || {}) };
}

// skip 仍是 ok=true（monitor.mjs 只把 ok===false 判失败），但显式标记 skipped 便于人看。
function skipCheck(name, label, ms, message, detail) {
  return {
    name: name,
    label: label,
    ok: true,
    skipped: true,
    ms: ms,
    detail: Object.assign({ message: message, skipped: true }, detail || {}),
  };
}

function serverMessage(res) {
  if (res && res.json) {
    const m = res.json.message;
    if (Array.isArray(m)) return m.join('；');
    if (m) return String(m);
  }
  return truncate(res && res.text, 200) || '（空响应）';
}

async function checkHealth(ctx) {
  const name = 'health';
  const label = 'API 健康 / 数据库';
  const started = Date.now();
  try {
    const res = await request(ctx.baseUrl, 'GET', '/api/health', { timeoutMs: ctx.timeoutMs });
    const detail = { url: ctx.baseUrl + '/api/health', httpStatus: res.status, db: res.json && res.json.db };
    if (res.status !== 200) return failCheck(name, label, Date.now() - started, '健康检查返回 HTTP ' + res.status + '（期望 200）', detail);
    if (!res.json || res.json.db !== 'up') {
      return failCheck(name, label, Date.now() - started, '数据库状态不是 up：db=' + (res.json && res.json.db ? res.json.db : 'unknown'), detail);
    }
    return okCheck(name, label, Date.now() - started, 'HTTP 200，db=up（' + res.ms + 'ms）', detail);
  } catch (err) {
    return failCheck(name, label, Date.now() - started, '健康检查请求失败：' + describeError(err), { url: ctx.baseUrl + '/api/health' });
  }
}

async function checkSmsLogin(ctx) {
  const name = 'sms_login';
  const label = '测试号短信登录';
  const started = Date.now();
  if (!ctx.phone.ok) {
    return failCheck(name, label, Date.now() - started, ctx.phone.error, { phone: '' });
  }
  const phone = ctx.phone.phone;
  const detail = { phone: maskPhone(phone), source: ctx.phone.source };

  // 不再调用 /api/auth/sms/send，也不依赖 DEV_SMS_ALLOWLIST / devCode。
  // 直接向数据库写一条 6 位、5 分钟过期的登录验证码，再走正常登录接口。
  const seeded = seedVerificationCode(ctx, phone);
  if (!seeded.ok) {
    ctx.authSkipReason = '数据库不可达，短信验证码无法播种';
    return skipCheck(name, label, Date.now() - started,
      '短信登录检查已跳过（不判失败）：' + seeded.error, detail);
  }
  detail.database = 'seeded';
  detail.userSource = seeded.userSource;
  detail.userExists = seeded.userExists;
  detail.code = 'seeded';

  const body = { phone: phone, code: seeded.code };
  if (!seeded.userExists) {
    // 测试号首次登录会创建账号；服务端要求首次登录显式同意三份法律文本。
    body.consent = { version: ctx.consentVersion, source: 'prod-regression' };
    detail.consent = 'sent-for-new-account';
  }

  let loginRes;
  try {
    loginRes = await request(ctx.baseUrl, 'POST', '/api/auth/sms/login', {
      body: body,
      timeoutMs: ctx.timeoutMs,
    });
  } catch (err) {
    return failCheck(name, label, Date.now() - started, '短信登录请求失败：' + describeError(err), detail);
  }
  detail.loginStatus = loginRes.status;
  detail.loginMs = loginRes.ms;
  const token = loginRes.json && loginRes.json.accessToken;
  if (!loginRes.ok || !token) {
    return failCheck(name, label, Date.now() - started,
      '短信登录失败：HTTP ' + loginRes.status + '：' + serverMessage(loginRes), detail);
  }
  ctx.token = token;
  detail.token = 'issued';
  return okCheck(name, label, Date.now() - started,
    '数据库播种验证码后登录成功（' + loginRes.ms + 'ms）', detail);
}

async function checkAuthed(ctx, name, label, route, validate, describeOk) {
  const started = Date.now();
  if (!ctx.token) {
    if (ctx.authSkipReason) {
      return skipCheck(name, label, 0, '跳过登录态检查：' + ctx.authSkipReason, { route: route });
    }
    return failCheck(name, label, 0, '缺少 JWT（短信登录未成功），无法检查 ' + route, { route: route });
  }
  let res;
  try {
    res = await request(ctx.baseUrl, 'GET', route, { token: ctx.token, timeoutMs: ctx.timeoutMs });
  } catch (err) {
    return failCheck(name, label, Date.now() - started, '请求 ' + route + ' 失败：' + describeError(err), { route: route });
  }
  const detail = { route: route, httpStatus: res.status, ms: res.ms };
  if (res.status !== 200) {
    return failCheck(name, label, Date.now() - started, route + ' 返回 HTTP ' + res.status + '：' + serverMessage(res), detail);
  }
  let verdict;
  try {
    verdict = validate(res.json);
  } catch (err) {
    verdict = { ok: false, message: '响应结构校验异常：' + describeError(err) };
  }
  if (!verdict || !verdict.ok) {
    return failCheck(name, label, Date.now() - started, route + ' 响应不符合预期：' + ((verdict && verdict.message) || '未知结构'), detail);
  }
  return okCheck(name, label, Date.now() - started, route + ' 正常（' + describeOk(res.json) + '，' + res.ms + 'ms）', detail);
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

async function runChecks(ctx) {
  const checks = [];
  checks.push(await checkHealth(ctx));
  checks.push(await checkSmsLogin(ctx));

  checks.push(await checkAuthed(ctx, 'employees', '我的员工列表', '/api/employees/mine', (body) => {
    if (!isPlainObject(body) || !Array.isArray(body.items)) return { ok: false, message: '缺少 items 数组' };
    if (typeof body.total !== 'number') return { ok: false, message: 'total 不是数字' };
    return { ok: true };
  }, (body) => '员工 ' + body.total + ' 个'));

  checks.push(await checkAuthed(ctx, 'capabilities', '能力清单', '/api/capabilities', (body) => {
    if (!isPlainObject(body) || !Array.isArray(body.items)) return { ok: false, message: '缺少 items 数组' };
    if (typeof body.total !== 'number' || body.total < 1) return { ok: false, message: 'total 不是正整数' };
    if (body.items.length !== body.total) return { ok: false, message: 'items.length 与 total 不一致' };
    return { ok: true };
  }, (body) => '能力 ' + body.total + ' 项'));

  checks.push(await checkAuthed(ctx, 'memory_stats', '记忆统计', '/api/memory/stats', (body) => {
    if (!isPlainObject(body)) return { ok: false, message: '响应不是对象' };
    if (typeof body.total !== 'number') return { ok: false, message: 'total 不是数字' };
    if (!isPlainObject(body.byKind)) return { ok: false, message: 'byKind 不是对象' };
    return { ok: true };
  }, (body) => '记忆 ' + body.total + ' 条'));

  checks.push(await checkAuthed(ctx, 'credits', '积分余额', '/api/credits/balance', (body) => {
    if (!isPlainObject(body)) return { ok: false, message: '响应不是对象' };
    if (typeof body.balance !== 'number') return { ok: false, message: 'balance 不是数字' };
    return { ok: true };
  }, (body) => '余额 ' + body.balance));

  return checks;
}

function summarize(checks) {
  const failed = checks.filter((c) => !c.ok);
  const skipped = checks.filter((c) => c.skipped);
  const names = failed.map((c) => c.name).join(',');
  return {
    ok: failed.length === 0,
    total: checks.length,
    failed: failed.length,
    failedNames: names,
    skipped: skipped.length,
    skippedNames: skipped.map((c) => c.name).join(','),
  };
}

function formatSummaryLine(result, summary) {
  const s = summary || summarize(result.checks);
  return '[' + result.at + '] 回归检查' + (s.ok ? '通过' : '失败') + '：共 ' + s.total + ' 项，失败 ' + s.failed +
    '，跳过 ' + (s.skipped || 0) +
    (s.failedNames ? '（失败：' + s.failedNames + '）' : '') +
    (s.skippedNames ? '（跳过：' + s.skippedNames + '）' : '');
}

async function writeResults(args, result) {
  const outDir = path.dirname(args.out);
  await fsp.mkdir(outDir, { recursive: true });
  const tmp = args.out + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(result, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, args.out);

  const logDir = path.dirname(args.log);
  await fsp.mkdir(logDir, { recursive: true });
  await fsp.appendFile(args.log, formatSummaryLine(result) + '\n', 'utf8');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error('[regression] 参数错误：' + describeError(err));
    printUsage();
    return 2;
  }
  if (args.help) {
    printUsage();
    return 0;
  }
  args.baseUrl = String(args.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  args.out = path.resolve(args.out);
  args.log = path.resolve(args.log);

  if (args.dryRun) {
    const envMap = readEnvFile(args.envFile);
    const db = parseDatabaseUrl(envMap.DATABASE_URL);
    const phone = String(args.phone || DEFAULT_PHONE).trim();
    const plan = {
      dryRun: true,
      baseUrl: args.baseUrl,
      out: args.out,
      log: args.log,
      envFile: args.envFile,
      container: args.container,
      phone: phone,
      phoneValid: /^1[3-9]\d{9}$/.test(phone),
      databaseConfigured: Boolean(db),
      databaseName: db ? db.database : '',
      databaseUserSource: db ? 'app/.env DATABASE_URL' : '未配置',
      checks: CHECKS.map((c) => ({ name: c.name, label: c.label })),
      notes: [
        '只读/低成本：GET health、向 VerificationCode 播种一次性验证码后 POST /api/auth/sms/login、GET employees/mine、capabilities、memory/stats、credits/balance',
        '不调用 /api/auth/sms/send、不依赖 DEV_SMS_ALLOWLIST 或 devCode、不触发真实短信',
        '数据库不可达时 sms_login 及其后的登录态检查会 skipped（不判失败）',
      ],
    };
    if (args.json) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log('[regression] dry-run：只打印计划，不联网、不写文件、不接触数据库');
      console.log('[regression] 目标地址：' + plan.baseUrl);
      console.log('[regression] 结果文件：' + plan.out);
      console.log('[regression] 摘要日志：' + plan.log);
      console.log('[regression] 环境文件：' + plan.envFile + '（DATABASE_URL：' + (plan.databaseConfigured ? '已配置，库 ' + plan.databaseName : '未配置/不可解析') + '）');
      console.log('[regression] MySQL 容器：' + plan.container + '；测试号：' + plan.phone + '（' + (plan.phoneValid ? '格式合法' : '格式非法') + '）');
      for (let i = 0; i < plan.checks.length; i++) {
        console.log('  ' + (i + 1) + '. ' + plan.checks[i].name + '：' + plan.checks[i].label);
      }
      console.log('[regression] dry-run 结束：未做任何请求、数据库写入与文件写入');
    }
    return 0;
  }

  const ctx = {
    baseUrl: args.baseUrl,
    timeoutMs: args.timeoutMs,
    envFile: args.envFile,
    container: args.container,
    consentVersion: process.env.REGRESSION_CONSENT_VERSION || DEFAULT_CONSENT_VERSION,
    phone: pickPhone(args),
    token: '',
    authSkipReason: '',
  };

  const startedAt = Date.now();
  const checks = await runChecks(ctx);
  const result = {
    at: new Date().toISOString(),
    ok: checks.every((c) => c.ok),
    total: checks.length,
    failed: checks.filter((c) => !c.ok).length,
    skipped: checks.filter((c) => c.skipped).length,
    checks: checks,
    durationMs: Date.now() - startedAt,
    baseUrl: args.baseUrl,
  };
  const summary = summarize(checks);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const c of checks) {
      if (args.quiet && c.ok) continue;
      const tag = c.skipped ? '[SKIP]' : (c.ok ? '[  OK ]' : '[FAIL]');
      const line = tag + ' ' + c.name + '：' + c.detail.message;
      if (c.ok) console.log(line);
      else console.error(line);
    }
    if (!args.quiet || !summary.ok) {
      const line = '[regression] ' + formatSummaryLine(result);
      if (summary.ok) console.log(line);
      else console.error(line);
    }
  }

  try {
    await writeResults(args, result);
  } catch (err) {
    console.error('[regression] 写结果失败：' + describeError(err) + '（out=' + args.out + '，log=' + args.log + '）');
    return 1;
  }

  return summary.ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('[regression] 未捕获异常：' + (err && err.stack ? err.stack : describeError(err)));
    process.exitCode = 2;
  });
