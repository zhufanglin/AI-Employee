#!/usr/bin/env node
/**
 * P44 WP3 生产回归检查（Node 24 纯内置，零依赖）
 *
 * 目标：每天在生产机跑一次「只读 / 低成本」的接口回归，结果落
 *   /opt/fcmediaagent/logs/regression.json（结构化，供 monitor.mjs 第 7 项读取）
 *   /opt/fcmediaagent/logs/regression.log（每次一行摘要 + systemd 标准输出）
 *
 * 检查项（固定顺序）：
 *   1. health         GET  /api/health              HTTP 200 且 db=up
 *   2. sms_login      POST /api/auth/sms/send       仅对 DEV_SMS_ALLOWLIST 命中的测试号，
 *                     POST /api/auth/sms/login      拿 devCode 登录，校验 accessToken
 *   3. employees      GET  /api/employees/mine      返回 items 数组 / total 数字
 *   4. capabilities   GET  /api/capabilities        total>=1 且 items 为数组
 *   5. memory_stats   GET  /api/memory/stats        total 为数字
 *   6. credits        GET  /api/credits/balance     balance 为数字
 *
 * 明确不做：不创建员工任务、不发媒体任务、不写业务数据、不触发真实短信。
 * 登录检查只走 devCode 路径：号码必须先在 /opt/fcmediaagent/app/.env 的
 * DEV_SMS_ALLOWLIST 里命中；名单里没有就跳过并判失败，绝不猜测验证码。
 *
 * 用法：
 *   node prod-regression.mjs --once                 跑一次并写结果（默认，timer 用）
 *   node prod-regression.mjs --dry-run              只打印计划，不联网、不写文件
 *   node prod-regression.mjs --base-url <url>       覆盖目标地址（默认 http://127.0.0.1:3000）
 *   node prod-regression.mjs --out <path>           覆盖 regression.json 路径
 *   node prod-regression.mjs --json                 stdout 输出完整 JSON（仍写文件）
 *   node prod-regression.mjs --quiet                成功时不打印，失败只打错误（systemd 用）
 *   node prod-regression.mjs --env-file <path>      覆盖读取 DEV_SMS_ALLOWLIST 的 .env
 *   node prod-regression.mjs --phone <num>          覆盖测试手机号（必须仍在 allowlist 内）
 *   node prod-regression.mjs --help
 *
 * 退出码：0 全部通过；1 存在失败项或写结果失败；2 参数错误。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const DEFAULT_OUT = '/opt/fcmediaagent/logs/regression.json';
const DEFAULT_ENV_FILE = '/opt/fcmediaagent/app/.env';
const DEFAULT_PHONE = '13900000002';
const DEFAULT_TIMEOUT_MS = 5000;

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
    '  node prod-regression.mjs --env-file <path>     读取 DEV_SMS_ALLOWLIST 的文件（默认 ' + DEFAULT_ENV_FILE + '）',
    '  node prod-regression.mjs --phone <num>         覆盖测试手机号（必须命中 allowlist）',
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
  const envMap = readEnvFile(args.envFile);
  const allow = String(envMap.DEV_SMS_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const requested = String(args.phone || '').trim();
  const candidate = requested || DEFAULT_PHONE;
  if (allow.includes(candidate) || allow.includes('*')) {
    return { ok: true, phone: candidate, allowlist: allow, source: requested ? '参数/环境变量覆盖' : '默认测试号' };
  }
  const fallback = allow.find((p) => p !== '*' && /^1\d{10}$/.test(p));
  if (!requested && fallback) {
    return { ok: true, phone: fallback, allowlist: allow, source: 'allowlist 首个测试号' };
  }
  return {
    ok: false,
    phone: '',
    allowlist: allow,
    source: 'none',
    error: '测试号 ' + candidate + ' 不在 ' + args.envFile + ' 的 DEV_SMS_ALLOWLIST 中（' +
      (allow.length ? '当前名单：' + allow.join(',') : '名单为空或文件不可读') +
      '）；为避免触发真实短信，跳过登录检查',
  };
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
  if (!ctx.phone.ok) return failCheck(name, label, Date.now() - started, ctx.phone.error, { phone: '', allowlistSize: ctx.phone.allowlist.length });
  const phone = ctx.phone.phone;
  const detail = { phone: maskPhone(phone), source: ctx.phone.source };
  let sendRes;
  try {
    sendRes = await request(ctx.baseUrl, 'POST', '/api/auth/sms/send', {
      body: { phone: phone, purpose: 'login' },
      timeoutMs: ctx.timeoutMs,
    });
  } catch (err) {
    return failCheck(name, label, Date.now() - started, '发送验证码请求失败：' + describeError(err), detail);
  }
  detail.sendStatus = sendRes.status;
  detail.sendMs = sendRes.ms;
  // Nest 的 POST 默认返回 201，这里接受任意 2xx。
  if (!sendRes.ok) {
    return failCheck(name, label, Date.now() - started, '发送验证码失败：HTTP ' + sendRes.status + '：' + serverMessage(sendRes), detail);
  }
  const devCode = sendRes.json && sendRes.json.devCode;
  if (!devCode) {
    // 没有 devCode 说明服务端没走 allowlist 分支；绝不能猜验证码，更不能再触发一次真实短信。
    return failCheck(name, label, Date.now() - started,
      '服务端未返回 devCode（号码未命中服务端 DEV_SMS_ALLOWLIST 或短信配置异常），已跳过登录',
      detail);
  }
  detail.devCode = 'received';
  let loginRes;
  try {
    loginRes = await request(ctx.baseUrl, 'POST', '/api/auth/sms/login', {
      body: { phone: phone, code: devCode },
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
    '测试号登录成功（send ' + sendRes.ms + 'ms / login ' + loginRes.ms + 'ms）', detail);
}

async function checkAuthed(ctx, name, label, route, validate, describeOk) {
  const started = Date.now();
  if (!ctx.token) {
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
  const names = failed.map((c) => c.name).join(',');
  return {
    ok: failed.length === 0,
    total: checks.length,
    failed: failed.length,
    failedNames: names,
  };
}

function formatSummaryLine(result, summary) {
  const s = summary || summarize(result.checks);
  return '[' + result.at + '] 回归检查' + (s.ok ? '通过' : '失败') + '：共 ' + s.total + ' 项，失败 ' + s.failed +
    (s.failedNames ? '（' + s.failedNames + '）' : '');
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
    const allow = String(envMap.DEV_SMS_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
    const plan = {
      dryRun: true,
      baseUrl: args.baseUrl,
      out: args.out,
      log: args.log,
      envFile: args.envFile,
      phone: args.phone || DEFAULT_PHONE,
      phoneInAllowlist: allow.includes(args.phone || DEFAULT_PHONE) || allow.includes('*'),
      allowlistSize: allow.length,
      checks: CHECKS.map((c) => ({ name: c.name, label: c.label })),
      notes: [
        '只读/低成本：GET health、短信验证码走 devCode、GET employees/mine、capabilities、memory/stats、credits/balance',
        '不创建员工任务、不发媒体任务、不触发真实短信、不写业务数据',
      ],
    };
    if (args.json) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log('[regression] dry-run：只打印计划，不联网、不写文件');
      console.log('[regression] 目标地址：' + plan.baseUrl);
      console.log('[regression] 结果文件：' + plan.out);
      console.log('[regression] 摘要日志：' + plan.log);
      console.log('[regression] 环境文件：' + plan.envFile + '（allowlist ' + plan.allowlistSize + ' 个，默认测试号命中：' + (plan.phoneInAllowlist ? '是' : '否') + '）');
      for (let i = 0; i < plan.checks.length; i++) {
        console.log('  ' + (i + 1) + '. ' + plan.checks[i].name + '：' + plan.checks[i].label);
      }
      console.log('[regression] dry-run 结束：未做任何请求与写入');
    }
    return 0;
  }

  const ctx = {
    baseUrl: args.baseUrl,
    timeoutMs: args.timeoutMs,
    phone: pickPhone(args),
    token: '',
  };

  const startedAt = Date.now();
  const checks = await runChecks(ctx);
  const result = {
    at: new Date().toISOString(),
    ok: checks.every((c) => c.ok),
    total: checks.length,
    failed: checks.filter((c) => !c.ok).length,
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
      const tag = c.ok ? '[  OK ]' : '[FAIL]';
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
