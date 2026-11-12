#!/usr/bin/env node
// =============================================================================
// fcmediaagent 备份文件上传阿里云 OSS（P44 运维保障 / WP1）
//
// 用法：
//   node oss-upload.mjs <备份文件...> [--prefix backups/mysql] [--dry-run] [--help]
//
// 设计：
//   - 用 createRequire 从 /opt/fcmediaagent/app 解析 ali-oss（生产机 app/node_modules 已装）；
//     解析不到就打印中文提示并以退出码 2 结束，不抛崩溃栈。
//   - 凭据从 /opt/fcmediaagent/app/.env 读 OSS_*（不硬编码、不从命令行传密码）。
//   - secure: true；key = <prefix>/<文件名>，默认 prefix = backups/mysql。
//   - 文件大于 8MB 走 multipartUpload（partSize 8MB、并行 3）；不超过 8MB 时走 put，
//     因为 ali-oss 的 multipartUpload 对小文件没有收益、部分版本还会直接报错。
//   - 上传后 head(key) 校验远端大小，避免“看起来成功其实截断”。
//
// 退出码：0 全部成功；1 上传/校验失败；2 依赖或配置缺失（含非生产环境）
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const APP_DIR = process.env.APP_DIR || '/opt/fcmediaagent/app';
const ENV_FILE = process.env.ENV_FILE || path.join(APP_DIR, '.env');
const DEFAULT_PREFIX = 'backups/mysql';
const PART_SIZE = 8 * 1024 * 1024;
const PROD_HINT = '需要生产环境：请在装有 /opt/fcmediaagent/app/node_modules/ali-oss 的生产机上执行';
const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_CONFIG = 2;

function usage() {
  const lines = [
    '用法: node oss-upload.mjs <备份文件...> [--prefix backups/mysql] [--dry-run] [--help]',
    '',
    '  <备份文件...>  要上传的本地文件（通常是 /opt/fcmediaagent/backups/mysql/fcmediaagent-*.sql.gz）',
    '  --prefix DIR   OSS key 前缀，默认 backups/mysql；最终 key = <prefix>/<文件名>',
    '  --dry-run      只打印计划，不连接 OSS（本机也能跑）',
    '  --help         显示本帮助',
    '',
    '退出码：0 全部成功；1 上传/校验失败；2 依赖或配置缺失（含非生产环境）',
  ];
  console.log(lines.join('\n'));
}

function fail(msg, code) {
  console.error('[错误] ' + msg);
  process.exit(typeof code === 'number' ? code : EXIT_FAIL);
}

function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return (index === 0 ? String(value) : value.toFixed(1)) + units[index];
}

function loadEnvFile(file) {
  const env = {};
  if (!fs.existsSync(file)) {
    return env;
  }
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.indexOf('#') === 0) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value.charAt(0);
      const last = value.charAt(value.length - 1);
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    env[key] = value;
  }
  return env;
}

function loadAliOss() {
  const bases = [path.join(APP_DIR, 'package.json'), path.join(APP_DIR, 'index.js')];
  const tried = [];
  for (const base of bases) {
    try {
      const req = createRequire(pathToFileURL(base).href);
      const mod = req('ali-oss');
      return mod && mod.default ? mod.default : mod;
    } catch (e) {
      tried.push(base + ' -> ' + (e && e.message ? e.message : String(e)));
    }
  }
  const err = new Error('无法从 ' + APP_DIR + ' 解析 ali-oss（已尝试 package.json 与 index.js 两个基准路径）');
  err.tried = tried;
  throw err;
}

function uploadKey(file, prefix) {
  const name = path.basename(file);
  const cleanPrefix = String(prefix || '').replace(/^\/+/, '').replace(/\/+$/, '');
  return cleanPrefix ? path.posix.join(cleanPrefix, name) : name;
}

function makeProgress(file) {
  const label = path.basename(file);
  let lastPct = -20;
  return function onProgress(p) {
    const pct = Math.min(100, Math.floor((Number(p) || 0) * 100));
    if (pct >= lastPct + 20 || pct === 100) {
      lastPct = pct;
      console.log('[上传] ' + label + ' ' + pct + '%');
    }
  };
}

function parseArgs(argv) {
  const out = { files: [], prefix: DEFAULT_PREFIX, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      out.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--prefix') {
      i += 1;
      if (i >= argv.length) {
        fail('--prefix 缺少参数', EXIT_CONFIG);
      }
      out.prefix = argv[i];
    } else if (arg.indexOf('--') === 0) {
      fail('未知参数：' + arg, EXIT_CONFIG);
    } else {
      out.files.push(arg);
    }
  }
  out.prefix = String(out.prefix || '').replace(/^\/+/, '').replace(/\/+$/, '');
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return EXIT_OK;
  }
  if (args.files.length === 0) {
    console.error('[错误] 没有指定要上传的文件');
    usage();
    return EXIT_CONFIG;
  }

  const missingFiles = args.files.filter((f) => !fs.existsSync(f) || !fs.statSync(f).isFile());
  if (missingFiles.length > 0) {
    fail('文件不存在或不是普通文件：' + missingFiles.join(', '), EXIT_CONFIG);
  }

  const env = loadEnvFile(ENV_FILE);
  const config = {
    region: env.OSS_REGION,
    accessKeyId: env.OSS_ACCESS_KEY_ID,
    accessKeySecret: env.OSS_ACCESS_KEY_SECRET,
    bucket: env.OSS_BUCKET,
    endpoint: env.OSS_ENDPOINT || undefined,
  };
  const missingEnv = ['region', 'accessKeyId', 'accessKeySecret', 'bucket'].filter((k) => !config[k]);

  if (args.dryRun) {
    console.log('[dry-run] 只打印计划，不连接 OSS');
    console.log('[dry-run] 环境文件：' + ENV_FILE + (fs.existsSync(ENV_FILE) ? '（已找到）' : '（未找到）'));
    console.log('[dry-run] secure=true，key 前缀：' + args.prefix + '，partSize=' + humanSize(PART_SIZE));
    for (const file of args.files) {
      const stat = fs.statSync(file);
      console.log('[dry-run] 上传 ' + file + ' -> oss://' + (config.bucket || '<bucket>') + '/' + uploadKey(file, args.prefix) + '（' + humanSize(stat.size) + '）');
    }
    if (missingEnv.length > 0) {
      console.log('[dry-run] 提示：.env 里缺少 ' + missingEnv.join(', ') + '，真实上传会以退出码 2 失败');
    }
    try {
      const OSS = loadAliOss();
      console.log('[dry-run] ali-oss 解析成功：' + (OSS && OSS.name ? OSS.name : 'ali-oss'));
    } catch (e) {
      console.error('[错误] ' + PROD_HINT);
      console.error('    详情：' + e.message);
      if (e.tried) {
        for (const item of e.tried) {
          console.error('    尝试：' + item);
        }
      }
      return EXIT_CONFIG;
    }
    console.log('[dry-run] 结束：未上传任何文件');
    return EXIT_OK;
  }

  if (missingEnv.length > 0) {
    fail(
      '环境文件 ' + ENV_FILE + ' 缺少 OSS 配置：' + missingEnv.join(', ') +
        '（需要 OSS_REGION / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_BUCKET）',
      EXIT_CONFIG,
    );
  }

  let OSS;
  try {
    OSS = loadAliOss();
  } catch (e) {
    console.error('[错误] ' + PROD_HINT);
    console.error('    详情：' + e.message);
    if (e.tried) {
      for (const item of e.tried) {
        console.error('    尝试：' + item);
      }
    }
    return EXIT_CONFIG;
  }

  const client = new OSS({
    region: config.region,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    bucket: config.bucket,
    endpoint: config.endpoint,
    secure: true,
    timeout: 600000,
  });

  let failed = 0;
  for (const file of args.files) {
    const key = uploadKey(file, args.prefix);
    const size = fs.statSync(file).size;
    const startedAt = Date.now();
    console.log('[开始] ' + path.basename(file) + '（' + humanSize(size) + '）-> oss://' + config.bucket + '/' + key);
    try {
      if (size > PART_SIZE) {
        await client.multipartUpload(key, file, {
          partSize: PART_SIZE,
          parallel: 3,
          mime: 'application/gzip',
          progress: makeProgress(file),
        });
      } else {
        await client.put(key, file, { mime: 'application/gzip' });
      }
      const head = await client.head(key);
      const headers = (head && head.res && head.res.headers) || (head && head.headers) || {};
      const remoteSize = Number(headers['content-length'] || (head && head.size) || 0);
      if (remoteSize > 0 && remoteSize !== size) {
        throw new Error('远端大小与本地不一致（本地 ' + size + '，远端 ' + remoteSize + '）');
      }
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log('[成功] oss://' + config.bucket + '/' + key + '（' + humanSize(size) + '，' + seconds + 's）');
    } catch (e) {
      failed += 1;
      console.error('[失败] ' + path.basename(file) + '：' + (e && e.message ? e.message : String(e)));
      if (e && e.code) {
        console.error('    错误码：' + e.code);
      }
    }
  }

  if (failed > 0) {
    console.error('[错误] 有 ' + failed + ' 个文件上传失败');
    return EXIT_FAIL;
  }
  console.log('[完成] 共上传 ' + args.files.length + ' 个文件到 oss://' + config.bucket + '/' + args.prefix + '/');
  return EXIT_OK;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((e) => {
    console.error('[错误] 上传过程异常：' + (e && e.message ? e.message : String(e)));
    if (process.env.DEBUG && e && e.stack) {
      console.error(e.stack);
    }
    process.exit(EXIT_FAIL);
  });
