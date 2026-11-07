// scripts/audit/lib.mjs - 忠实度审计公共解析库（只读原始物料/复刻源码；不联网、不写业务库）
import fs from 'node:fs';
import path from 'node:path';

export function walk(dir, filter, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(p, filter, out);
    } else if (filter(p, e.name)) out.push(p);
  }
  return out;
}

const HTTP_VERBS = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'All'];

// ---- 原版 NestJS 编译产物解析 ----
// @Controller('admin') -> (0, common_1.Controller)('admin') / (0, common_1.Controller)({ path: 'admin' })
// @Get('users/:id')    -> (0, common_1.Get)('users/:id')
export function parseNestDistControllers(distRoot) {
  const files = walk(distRoot, (_p, n) => n.endsWith('.controller.js'));
  const routes = [];
  const controllers = [];
  const re = new RegExp(
    'common_1\\.(' + HTTP_VERBS.join('|') + ')\\)\\(\\s*(?:[\\x60' + "'" + '"]([^\\x60' + "'" + '"]*)[\\x60' + "'" + '"])?',
    'g'
  );
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(distRoot, f).split(path.sep).join('/');
    const cm = src.match(/common_1\.Controller\)\(\s*(?:\{\s*path\s*:\s*(['"])([^'"]*)\1|(['"])([^'"]*)\3)/);
    let prefix = '';
    if (cm) prefix = cm[2] !== undefined ? cm[2] : cm[4];
    prefix = String(prefix || '').replace(/^\/+|\/+$/g, '');
    controllers.push({ prefix, file: rel });
    let m;
    while ((m = re.exec(src))) {
      const verb = m[1].toUpperCase();
      const sub = (m[2] || '').replace(/^\/+|\/+$/g, '');
      const full = ('/' + [prefix, sub].filter(Boolean).join('/')).replace(/\/+/g, '/');
      routes.push({ method: verb === 'ALL' ? 'ALL' : verb, path: full, controller: prefix, file: rel, source: 'dist' });
    }
  }
  return { routes, controllers, files: files.length };
}

// ---- 复刻 TS 源码解析（@Controller/@Get 装饰器）----
export function parseTsControllers(srcRoot) {
  const files = walk(srcRoot, (_p, n) => n.endsWith('.controller.ts'));
  const routes = [];
  const controllers = [];
  const re = /@(Get|Post|Put|Patch|Delete|All)\(\s*(?:([\x60'"])([^\x60'"]*)\2)?\s*\)/g;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(srcRoot, f).split(path.sep).join('/');
    // A source file may declare several controllers; parse each segment independently.
    const controllerRe = /@Controller\(\s*(?:\{\s*path\s*:\s*([\x60'"])([^\x60'"]*)\1|([\x60'"])([^\x60'"]*)\3)?/g;
    const controllersInFile = [];
    let cm;
    while ((cm = controllerRe.exec(src))) {
      const prefix = String(cm[2] !== undefined ? cm[2] : (cm[4] || '')).replace(/^\/+|\/+$/g, '');
      controllersInFile.push({ prefix, end: controllerRe.lastIndex, start: cm.index });
    }
    for (let i = 0; i < controllersInFile.length; i++) {
      const current = controllersInFile[i];
      const segment = src.slice(current.end, controllersInFile[i + 1]?.start ?? src.length);
      controllers.push({ prefix: current.prefix, file: rel });
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(segment))) {
        const verb = m[1].toUpperCase();
        const sub = (m[3] || '').replace(/^\/+|\/+$/g, '');
        const full = ('/' + [current.prefix, sub].filter(Boolean).join('/')).replace(/\/+/g, '/');
        routes.push({ method: verb === 'ALL' ? 'ALL' : verb, path: full, controller: current.prefix, file: rel, source: 'ts' });
      }
    }
  }
  return { routes, controllers, files: files.length };
}

// ---- Prisma schema 解析 ----
export function parsePrismaSchema(file) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  const models = [];
  const enums = [];
  let cur = null;
  let kind = null;
  for (const raw of lines) {
    const line = raw.replace(/\/\/.*$/, '');
    const mt = line.match(/^\s*(model|enum)\s+(\w+)\s*\{/);
    if (mt) {
      kind = mt[1];
      if (kind === 'model') { cur = { name: mt[2], table: mt[2], fields: [] }; models.push(cur); }
      else { cur = { name: mt[2] }; enums.push(mt[2]); }
      continue;
    }
    if (kind && /^\s*\}/.test(line)) { cur = null; kind = null; continue; }
    if (kind === 'model' && cur) {
      const mapm = line.match(/@@map\(\s*"([^"]+)"\s*\)/);
      if (mapm) { cur.table = mapm[1]; continue; }
      if (/^\s*@@/.test(line)) continue;
      const fm = line.match(/^\s*(\w+)\s+([A-Za-z_][\w]*(?:\([^)]*\))?)(\[\])?(\?)?\s*(.*)$/);
      if (fm) {
        const attrs = fm[5] || '';
        const fmaps = attrs.match(/@map\(\s*"([^"]+)"\s*\)/);
        cur.fields.push({
          name: fm[1], type: fm[2], list: !!fm[3], optional: !!fm[4], attrs,
          default: (attrs.match(/@default\(([^)]*)\)/) || [])[1] || null,
          dbName: fmaps ? fmaps[1] : null,
          isId: /@id\b/.test(attrs),
          unique: /@unique\b/.test(attrs),
        });
      }
    }
  }
  return { models, enums, file };
}

// ---- 原版 Electron IPC 解析 ----
export function parseElectronIpc(roots) {
  const handles = [];
  for (const { root, label } of roots) {
    const files = walk(root, (_p, n) => /\.(js|mjs|cjs)$/.test(n) && !/\.map$/.test(n));
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const rel = path.relative(root, f).split(path.sep).join('/');
      const re = /ipcMain\s*\.\s*(handle|handleOnce|on|once|removeHandler)\(\s*([\x60'"])([^\x60'"]+)\2/g;
      let m;
      while ((m = re.exec(src))) {
        if (m[1] === 'removeHandler') continue;
        handles.push({ channel: m[3], kind: m[1], order: (m[1] === 'handle' || m[1] === 'handleOnce') ? 'handle' : 'on', file: rel, bundle: label });
      }
    }
  }
  return handles;
}

export function uniqBy(arr, keyFn) {
  const seen = new Map();
  for (const a of arr) { const k = keyFn(a); if (!seen.has(k)) seen.set(k, a); }
  return [...seen.values()];
}

export function sortRoutes(routes) {
  return routes.slice().sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}
