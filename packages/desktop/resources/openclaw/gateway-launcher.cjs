'use strict';
/**
 * Gateway 独立启动器（supervisor 模式）
 *
 * 由 Windows 计划任务在用户登录时启动，独立于 Electron 运行。
 * 通过 ELECTRON_RUN_AS_NODE=1 用 Electron 内置 Node.js runtime 运行。
 *
 * 工作流程：
 * 1. 读取 ~/.openclaw/gateway-env.json 获取环境变量和启动参数
 * 2. 用 child_process.spawn 启动 openclaw.mjs
 * 3. 监听子进程退出：非 0 退出码时等 5s 重启（supervisor 循环）
 * 4. 正常退出（code=0）或收到 SIGTERM/SIGINT 时停止
 *
 * 信号处理：
 * - SIGTERM/SIGINT：转发给子进程，等待退出后自身退出
 *
 * 日志：写入 ~/.openclaw/logs/gateway-launcher.log
 */
const { spawn } = require('child_process');
const { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

const OPENCLAW_DIR = join(homedir(), '.openclaw');
const LOG_DIR = join(OPENCLAW_DIR, 'logs');
const ENV_FILE = join(OPENCLAW_DIR, 'gateway-env.json');
const LOG_FILE = join(LOG_DIR, 'gateway-launcher.log');
const PID_FILE = join(OPENCLAW_DIR, 'gateway-launcher.pid');

// 确保 logs 目录存在
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

function loadEnvFile() {
  if (!existsSync(ENV_FILE)) {
    log(`FATAL: env file not found at ${ENV_FILE}`);
    return null;
  }
  try {
    const raw = readFileSync(ENV_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    log(`FATAL: failed to parse env file: ${err}`);
    return null;
  }
}

/**
 * 维护 PID 文件（launcher + 当前 gateway 子进程），
 * 供 gateway-watchdog.cjs 在恢复时精确 kill 卡死的进程树。
 */
function writePidFile(gatewayPid) {
  try {
    writeFileSync(PID_FILE, JSON.stringify({
      launcherPid: process.pid,
      gatewayPid: gatewayPid || null,
      updatedAt: Date.now(),
    }, null, 2), 'utf-8');
  } catch {
    // ignore — watchdog 有 schtasks /End 兜底
  }
}

function startGateway(envData) {
  const { entryScript, openclawDir, gatewayArgs, forkEnv, electronExecPath } = envData;

  if (!existsSync(entryScript)) {
    log(`FATAL: entry script not found at ${entryScript}`);
    return null;
  }

  // 构造子进程环境变量
  // ELECTRON_RUN_AS_NODE=1 让 Electron 以纯 Node.js 模式运行
  const childEnv = {
    ...forkEnv,
    ELECTRON_RUN_AS_NODE: '1',
  };

  log(`Starting Gateway: exec=${electronExecPath}, entry=${entryScript}, args=${gatewayArgs.join(' ')}, cwd=${openclawDir}`);

  const child = spawn(electronExecPath, [entryScript, ...gatewayArgs], {
    cwd: openclawDir,
    env: childEnv,
    stdio: 'pipe',
    windowsHide: true,
  });

  child.stdout?.on('data', (data) => {
    const raw = data.toString();
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) log(`[gateway stdout] ${trimmed}`);
    }
  });

  child.stderr?.on('data', (data) => {
    const raw = data.toString();
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) log(`[gateway stderr] ${trimmed}`);
    }
  });

  return child;
}

function main() {
  log('=== Gateway Launcher starting ===');
  writePidFile(null);

  const envData = loadEnvFile();
  if (!envData) {
    log('Exiting: cannot load env file');
    process.exit(1);
  }

  let child = null;
  let shouldRestart = true;
  let isShuttingDown = false;

  const RESTART_DELAY_MS = 5000;
  const MAX_RESTART_ATTEMPTS = 10;
  let restartAttempts = 0;
  const RESET_ATTEMPTS_INTERVAL = 60000; // 1 分钟内无崩溃则重置计数

  function spawnGateway() {
    child = startGateway(envData);
    if (!child) {
      log('Failed to spawn Gateway, will retry in 5s');
      setTimeout(() => {
        if (shouldRestart && !isShuttingDown) spawnGateway();
      }, RESTART_DELAY_MS);
      return;
    }

    const pid = child.pid;
    log(`Gateway process started (pid=${pid})`);
    writePidFile(pid);

    // 重置崩溃计数（如果距离上次崩溃超过 1 分钟）
    const sinceLastExit = Date.now() - (lastExitTime || 0);
    if (sinceLastExit > RESET_ATTEMPTS_INTERVAL) {
      restartAttempts = 0;
    }

    child.on('exit', (code, signal) => {
      lastExitTime = Date.now();
      log(`Gateway process exited (pid=${pid}, code=${code}, signal=${signal})`);

      child = null;
      writePidFile(null);

      if (isShuttingDown) {
        log('Shutting down launcher, not restarting');
        return;
      }

      // code=0 表示正常退出（如用户主动 shutdown），不重启
      if (code === 0) {
        log('Gateway exited normally (code=0), not restarting');
        shouldRestart = false;
        return;
      }

      // 非正常退出，尝试重启
      restartAttempts++;
      if (restartAttempts > MAX_RESTART_ATTEMPTS) {
        log(`Max restart attempts (${MAX_RESTART_ATTEMPTS}) exceeded, giving up`);
        shouldRestart = false;
        process.exit(1);
        return;
      }

      log(`Scheduling restart in ${RESTART_DELAY_MS}ms (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})`);
      setTimeout(() => {
        if (shouldRestart && !isShuttingDown) {
          // 重新读取 env 文件（可能已更新）
          const freshEnv = loadEnvFile();
          if (freshEnv) {
            envData = freshEnv;
            log('Reloaded env file before restart');
          }
          spawnGateway();
        }
      }, RESTART_DELAY_MS);
    });

    child.on('error', (err) => {
      log(`Gateway process error: ${err}`);
      child = null;
    });
  }

  let lastExitTime = 0;

  // 信号处理：转发给子进程
  function gracefulShutdown(signal) {
    log(`Received ${signal}, forwarding to Gateway child`);
    isShuttingDown = true;
    shouldRestart = false;

    if (child && child.pid) {
      try {
        // Windows 上不支持 SIGTERM，用 tree-kill
        if (process.platform === 'win32') {
          const { exec } = require('child_process');
          exec(`taskkill /F /PID ${child.pid} /T`, { timeout: 5000, windowsHide: true }, () => {
            log('Gateway child terminated via taskkill');
            process.exit(0);
          });
        } else {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (child) {
              try {
                child.kill('SIGKILL');
              } catch {
                // ignore
              }
            }
            process.exit(0);
          }, 5000);
        }
      } catch (err) {
        log(`Failed to kill child: ${err}`);
        process.exit(0);
      }
    } else {
      process.exit(0);
    }
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // Windows 计划任务停止时发送的事件
  if (process.platform === 'win32') {
    process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
  }

  // 首次启动
  spawnGateway();

  // 保持进程运行
  log('Launcher supervisor loop is running');
}

main();
