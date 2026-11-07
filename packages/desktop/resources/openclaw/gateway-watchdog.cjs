'use strict';
/**
 * Gateway Watchdog（保活看门狗 + 凭据自刷新）
 *
 * 由 Windows 计划任务每 5 分钟运行一次，独立于 Electron 与 gateway-launcher。
 *
 * 工作流程：
 * 0. 凭据自刷新：客户端关闭期间（心跳过期）且凭据文件超过 6 天未刷新时，
 *    走 /auth/refresh → /volcengine/proxy-token 刷新链路，更新
 *    auth-profiles.json 与 gateway-env.json，并重启 Gateway 加载新凭据。
 *    解决"客户端关闭 2h 后 JWT 过期 → 定时任务 LLM 调用 401"。
 * 1. 读取 ~/.openclaw/gateway-env.json 获取 Gateway 端口（fallback 18789）
 * 2. 对 Gateway 端口做 TCP + WebSocket 升级握手探测（Gateway 无 HTTP /health）
 * 3. 探测成功 → 清除 downSince 状态，退出
 * 4. 探测失败：
 *    a. 首次失败 → 记录 downSince，退出（宽限期：Gateway 可能正在启动，
 *       下一个周期再确认，避免登录后慢启动被误杀）
 *    b. 连续第二次失败（≥5 分钟不可用）→ 执行恢复：
 *       - Electron 客户端心跳新鲜（< 3 分钟）时跳过恢复（客户端自己在管理 Gateway）
 *       - 按 PID 文件 kill 卡死的 launcher/gateway 进程树
 *       - schtasks /End + /Run 重启 OpenClawGateway 计划任务
 *       - 重置 downSince
 *
 * 日志：~/.openclaw/logs/gateway-watchdog.log
 */
const { spawn, exec } = require('child_process');
const { existsSync, readFileSync, readdirSync, mkdirSync, appendFileSync, writeFileSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

const OPENCLAW_DIR = join(homedir(), '.openclaw');
const LOG_DIR = join(OPENCLAW_DIR, 'logs');
const ENV_FILE = join(OPENCLAW_DIR, 'gateway-env.json');
const STATE_FILE = join(OPENCLAW_DIR, 'gateway-watchdog-state.json');
const PID_FILE = join(OPENCLAW_DIR, 'gateway-launcher.pid');
const APP_HEARTBEAT_FILE = join(OPENCLAW_DIR, 'app-heartbeat');
const CREDENTIALS_FILE = join(OPENCLAW_DIR, 'gateway-credentials.json');
const LOG_FILE = join(LOG_DIR, 'gateway-watchdog.log');
const AGENTS_DIR = join(OPENCLAW_DIR, 'agents');

const GATEWAY_TASK_NAME = 'OpenClawGateway';
const DEFAULT_PORT = 18789;
/** 客户端心跳文件 mtime 超过该毫秒数视为客户端未运行 */
const APP_HEARTBEAT_MAX_AGE_MS = 3 * 60 * 1000;
/** 探测超时 */
const PROBE_TIMEOUT_MS = 8000;
/** 凭据文件超过该毫秒数未刷新则触发刷新（代理令牌 7 天有效，留 1 天余量） */
const CREDENTIALS_STALE_MS = 6 * 24 * 60 * 60 * 1000;
/** HTTP 请求超时 */
const HTTP_TIMEOUT_MS = 20000;

try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // ignore
}

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(LOG_FILE, line, 'utf-8');
  } catch {
    // ignore
  }
}

function readJson(file) {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  try {
    writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    log(`WARN: failed to write ${file}: ${err}`);
  }
}

function getGatewayPort() {
  const env = readJson(ENV_FILE);
  if (env && typeof env.port === 'number' && env.port > 0) return env.port;
  return DEFAULT_PORT;
}

/**
 * 简易 HTTP POST（Node 原生 http/https，无外部依赖）。
 * 返回 { ok, status, json }；网络错误/超时抛异常由调用方捕获。
 */
function httpPostJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(new Error(`invalid url: ${url}`));
      return;
    }
    const mod = parsed.protocol === 'https:' ? require('https') : require('http');
    const payload = JSON.stringify(body || {});
    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search || ''}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
        timeout: HTTP_TIMEOUT_MS,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, raw });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`timeout after ${HTTP_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * 更新所有 agent 的 auth-profiles.json 中 volcengine-plan 的 key。
 * 与 electron/utils/openclaw-auth.ts saveProviderKeyToOpenClaw 的 JSON 格式保持一致
 * （SQLite store 由客户端运行时维护，此处仅更新 legacy JSON 供 Gateway 读取）。
 */
function updateAuthProfilesKey(provider, newKey) {
  let updated = 0;
  let agentIds = ['main'];
  try {
    if (existsSync(AGENTS_DIR)) {
      const dirs = readdirSync(AGENTS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      if (dirs.length > 0) agentIds = dirs;
    }
  } catch {
    // ignore — fallback ['main']
  }

  for (const agentId of agentIds) {
    const filePath = join(AGENTS_DIR, agentId, 'agent', 'auth-profiles.json');
    try {
      let store = readJson(filePath) || {};
      if (typeof store !== 'object' || !store.profiles) {
        store = { version: 1, profiles: {} };
      }
      const profileId = `${provider}:default`;
      store.profiles[profileId] = { type: 'api_key', provider, key: newKey };
      if (!store.order) store.order = {};
      if (!store.order[provider]) store.order[provider] = [];
      if (!store.order[provider].includes(profileId)) {
        store.order[provider].push(profileId);
      }
      if (!store.lastGood) store.lastGood = {};
      store.lastGood[provider] = profileId;
      writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
      updated++;
    } catch (err) {
      log(`WARN: failed to update auth-profiles for agent "${agentId}": ${err}`);
    }
  }
  return updated;
}

/**
 * 更新 gateway-env.json forkEnv 中指定环境变量的值，
 * 使下次 Gateway 重启后子进程继承新凭据。
 */
function updateGatewayEnvKey(envVar, value) {
  try {
    const env = readJson(ENV_FILE);
    if (!env || typeof env.forkEnv !== 'object') return false;
    if (env.forkEnv[envVar] === value) return false; // 未变化，无需重启
    env.forkEnv[envVar] = value;
    writeFileSync(ENV_FILE, JSON.stringify(env, null, 2), 'utf-8');
    return true;
  } catch (err) {
    log(`WARN: failed to update gateway-env.json: ${err}`);
    return false;
  }
}

/**
 * 凭据自刷新：客户端关闭期间凭据过期会导致定时任务 LLM 调用 401。
 * 链路：refreshToken → /auth/refresh → JWT → /volcengine/proxy-token → 代理令牌
 * → 更新 auth-profiles.json + gateway-env.json → 重启 Gateway 生效。
 *
 * 仅在客户端未运行时执行（客户端自身每 90min 刷新，并发刷新会竞争 token 轮换）。
 */
async function refreshCredentialsIfStale() {
  if (isAppAlive()) return false;

  const cred = readJson(CREDENTIALS_FILE);
  if (!cred || typeof cred.refreshToken !== 'string' || !cred.refreshToken || !cred.apiBase) {
    return false;
  }
  const updatedAt = typeof cred.updatedAt === 'number' ? cred.updatedAt : 0;
  if (Date.now() - updatedAt < CREDENTIALS_STALE_MS) return false;

  log(`Credentials stale (last refresh ${new Date(updatedAt).toISOString()}); refreshing`);

  // 1. 刷新 JWT（服务端可能轮换 refresh token，先写回文件保证 crash-safe）
  let authRes;
  try {
    authRes = await httpPostJson(`${cred.apiBase.replace(/\/+$/, '')}/auth/refresh`, {
      refreshToken: cred.refreshToken,
    });
  } catch (err) {
    log(`Credential refresh failed (auth/refresh network error): ${err}`);
    return false;
  }
  if (!authRes.ok || !authRes.json) {
    // refresh token 失效（如用户在其他设备重新登录）：只记录，不删凭据，
    // 客户端下次打开时走正常登录/刷新流程
    log(`Credential refresh failed (auth/refresh HTTP ${authRes.status}); leaving credentials untouched`);
    return false;
  }
  const authResult = authRes.json?.data !== undefined ? authRes.json.data : authRes.json;
  const accessToken = authResult?.accessToken;
  if (!accessToken) {
    log('Credential refresh returned no accessToken');
    return false;
  }
  const newRefreshToken = authResult?.refreshToken || cred.refreshToken;
  writeJson(CREDENTIALS_FILE, {
    refreshToken: newRefreshToken,
    apiBase: cred.apiBase,
    updatedAt: Date.now(),
  });

  // 2. 用新 JWT 换代理令牌（7 天有效）
  let proxyRes;
  try {
    proxyRes = await httpPostJson(
      `${cred.apiBase.replace(/\/+$/, '')}/volcengine/proxy-token`,
      {},
      { Authorization: `Bearer ${accessToken}` },
    );
  } catch (err) {
    log(`Proxy token fetch failed (network error): ${err}`);
    return false;
  }
  if (!proxyRes.ok || !proxyRes.json) {
    log(`Proxy token fetch failed (HTTP ${proxyRes.status}); JWT-only credentials kept`);
    return false;
  }
  const proxyResult = proxyRes.json?.data !== undefined ? proxyRes.json.data : proxyRes.json;
  const proxyToken = proxyResult?.token;
  if (typeof proxyToken !== 'string' || !proxyToken.startsWith('rrclaw-proxy-')) {
    log('Proxy token response missing valid token');
    return false;
  }

  // 3. 更新运行时凭据文件
  const updatedAgents = updateAuthProfilesKey('volcengine-plan', proxyToken);
  const envUpdated = updateGatewayEnvKey('VOLCENGINE_PLAN_API_KEY', proxyToken);
  log(`Credentials refreshed: auth-profiles updated for ${updatedAgents} agent(s), gateway-env ${envUpdated ? 'updated' : 'unchanged'}`);

  // 4. 重启 Gateway 加载新凭据（仅当 env 实际变化）
  if (envUpdated) {
    await recover();
  }
  return true;
}

/**
 * 探测 Gateway 是否存活：TCP 连接 + 发送 WebSocket 升级请求。
 * Gateway 无 HTTP /health 端点，但 WS 服务端会回应 101 或 4xx，
 * 任何 HTTP 响应行都证明进程响应正常；超时/连接拒绝视为宕机。
 */
function probeGateway(port) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok, reason) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve({ ok, reason });
    };

    const socket = require('net').connect({ port, host: '127.0.0.1' });
    socket.setTimeout(PROBE_TIMEOUT_MS);

    socket.on('connect', () => {
      // 发送 WebSocket 升级请求（最小握手），等待任何 HTTP 响应行
      const key = require('crypto').randomBytes(16).toString('base64');
      const req = [
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '', '',
      ].join('\r\n');
      socket.write(req);
    });

    socket.on('data', () => {
      // 收到任意响应（101/4xx 等）即证明进程在正常处理请求
      finish(true, 'handshake-response');
    });

    socket.on('timeout', () => finish(false, 'probe-timeout'));
    socket.on('error', (err) => finish(false, `probe-error: ${err.code || err.message}`));
    socket.on('close', () => finish(false, 'connection-closed'));
  });
}

/** 客户端（Electron）是否在运行：心跳文件 mtime 足够新 */
function isAppAlive() {
  try {
    if (!existsSync(APP_HEARTBEAT_FILE)) return false;
    const stat = require('fs').statSync(APP_HEARTBEAT_FILE);
    return Date.now() - stat.mtimeMs < APP_HEARTBEAT_MAX_AGE_MS;
  } catch {
    return false;
  }
}

/** 判断 PID 对应进程的镜像名是否匹配（防 PID 复用误杀无关进程） */
function pidMatchesExpectedImage(pid, expectedImageName) {
  return new Promise((resolve) => {
    if (!pid || pid <= 0 || !expectedImageName) return resolve(false);
    exec(
      `tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
      { timeout: 10000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(false);
        const line = String(stdout || '').trim();
        if (!line || line.startsWith('INFO:')) return resolve(false);
        const image = line.split('","')[0]?.replace(/^"*/, '').toLowerCase();
        resolve(image === expectedImageName.toLowerCase());
      },
    );
  });
}

function taskkillTree(pid) {
  return new Promise((resolve) => {
    exec(
      `taskkill /F /T /PID ${pid}`,
      { timeout: 15000, windowsHide: true },
      () => resolve(),
    );
  });
}

function runSchtasks(args) {
  return new Promise((resolve) => {
    exec(
      `schtasks ${args}`,
      { timeout: 15000, windowsHide: true },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }),
    );
  });
}

/**
 * 恢复动作：杀掉卡死进程树并重启计划任务。
 */
async function recover() {
  const env = readJson(ENV_FILE) || {};
  const expectedImage = env.electronExecPath
    ? String(env.electronExecPath).split('\\').pop()
    : null;

  // 1. 按 PID 文件杀掉 launcher + gateway 进程树（launcher 卡死但任务标记 running 的场景）
  const pids = readJson(PID_FILE) || {};
  for (const pid of [pids.gatewayPid, pids.launcherPid]) {
    if (!pid || pid <= 0) continue;
    if (expectedImage && !(await pidMatchesExpectedImage(pid, expectedImage))) {
      log(`SKIP kill pid=${pid}: image mismatch or process gone (expected=${expectedImage})`);
      continue;
    }
    log(`Killing stuck process tree pid=${pid}`);
    await taskkillTree(pid);
  }

  // 2. 结束并重启计划任务（launcher 已死时 /Run 直接生效）
  const endResult = await runSchtasks(`/End /TN "${GATEWAY_TASK_NAME}"`);
  if (endResult.err) {
    log(`schtasks /End: ${endResult.stderr || endResult.err.message} (may be already stopped)`);
  }
  const runResult = await runSchtasks(`/Run /TN "${GATEWAY_TASK_NAME}"`);
  if (!runResult.err) {
    log('Recovery: gateway task restarted via schtasks /Run');
    return true;
  }
  log(`schtasks /Run failed: ${runResult.stderr || runResult.err.message}`);

  // 3. Run-key 模式回退：直接分离拉起 launcher
  // （UAC 开启的机器上计划任务创建被拒，服务通过 HKCU Run key 自启；
  //   此时按 gateway-env.json 里的路径直接 spawn，与登录自启同一入口）
  if (env.electronExecPath && env.launcherPath && existsSync(env.launcherPath)) {
    try {
      const child = spawn(env.electronExecPath, [env.launcherPath], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      log(`Recovery: gateway launcher spawned directly (run-key mode, pid=${child.pid})`);
      return true;
    } catch (err) {
      log(`ERROR: direct launcher spawn failed: ${err}`);
      return false;
    }
  }

  log('ERROR: no fallback launch path available (missing electronExecPath/launcherPath in gateway-env.json)');
  return false;
}

async function main() {
  // 凭据自刷新（客户端关闭 + 凭据临期时触发；内部会按需重启 Gateway）
  try {
    await refreshCredentialsIfStale();
  } catch (err) {
    log(`WARN: credential refresh unexpected error: ${err}`);
  }

  const port = getGatewayPort();
  const probe = await probeGateway(port);

  const state = readJson(STATE_FILE) || { downSince: null };
  const now = Date.now();

  if (probe.ok) {
    if (state.downSince) {
      const downFor = Math.round((now - state.downSince) / 1000);
      log(`Gateway recovered on its own (was down ~${downFor}s), clearing state`);
    }
    writeJson(STATE_FILE, { downSince: null });
    return;
  }

  log(`Probe failed on port ${port}: ${probe.reason}`);

  if (!state.downSince) {
    // 首次失败：宽限期，下一周期再确认（容忍启动慢/瞬时抖动）
    log('First failure; entering grace period (will re-check next cycle)');
    writeJson(STATE_FILE, { downSince: now });
    return;
  }

  const downFor = Math.round((now - state.downSince) / 1000);
  log(`Gateway down for ~${downFor}s (consecutive failures)`);

  if (isAppAlive()) {
    log('Electron client heartbeat is fresh; client manages Gateway itself, skipping recovery');
    return;
  }

  log('Client not running; attempting recovery');
  await recover();
  // 无论恢复成败都重置 downSince，避免下个周期立即重复恢复；
  // 若仍宕机，下个周期重新进入宽限→确认流程
  writeJson(STATE_FILE, { downSince: null });
}

main().catch((err) => {
  log(`FATAL: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
