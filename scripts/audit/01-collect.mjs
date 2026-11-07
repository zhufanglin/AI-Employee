// scripts/audit/01-collect.mjs - 采集原版/复刻两边基线，输出 scripts/audit/out/*.json
// 用法: node scripts/audit/01-collect.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNestDistControllers, parseTsControllers, parsePrismaSchema, uniqBy, sortRoutes } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });

const EXTRACT = 'C:/Users/30290/Desktop/部署文件/_extract';
const REPO = 'C:/Users/30290/Desktop/fcmediaagent-replica';

function save(name, obj) { fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj, null, 2), 'utf8'); }

// ---------- 原版 ----------
const dist = parseNestDistControllers(path.join(EXTRACT, 'server1027/dist'));
const origRoutes = uniqBy(sortRoutes(dist.routes), r => r.method + ' ' + r.path);

const origSchema = parsePrismaSchema(path.join(EXTRACT, 'server1027/prisma/schema.prisma'));

// 原版主进程已混淆；静态 ipcMain 正则会返回 0。147 handle 契约来自既有 mock-electron 动态导入产物。
const contractIpcPath = path.join(REPO, 'contracts/ipc_handles_147.tsv');
const origIpc = fs.readFileSync(contractIpcPath, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(line => {
  const [channel, arity] = line.split('\t');
  return { channel, arity: Number(arity), kind: 'handle', order: 'handle', file: 'contracts/ipc_handles_147.tsv', bundle: 'mock-electron dynamic import' };
});

save('original-routes.json', { count: origRoutes.length, controllers: dist.controllers.length, files: dist.files, routes: origRoutes });
save('original-schema.json', origSchema);
save('original-ipc.json', { count: origIpc.length, evidence: 'contracts/ipc_handles_147.tsv; mock-electron dynamic import', handles: origIpc, ons: null });

// ---------- 复刻 ----------
const repoSrc = path.join(REPO, 'packages/server/src');
const ts = parseTsControllers(repoSrc);
const repRoutes = uniqBy(sortRoutes(ts.routes), r => r.method + ' ' + r.path);
const repoSchema = parsePrismaSchema(path.join(REPO, 'packages/server/prisma/schema.prisma'));

// 复刻 IPC：主进程 TS 源码中的 ipcMain.handle
const ipcFiles = [path.join(REPO, 'packages/desktop/src/main')];
const repIpc = [];
for (const root of ipcFiles) {
  const st = fs.statSync(root);
  if (!st.isDirectory()) continue;
  for (const f of fs.readdirSync(root)) {
    if (!f.endsWith('.ts')) continue;
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    const re = /ipcMain\s*\.\s*(handle|on)\(\s*([\x60'"])([^\x60'"]+)\2/g;
    let m;
    while ((m = re.exec(src))) repIpc.push({ channel: m[3], order: m[1], file: 'packages/desktop/src/main/' + f });
    // 也统计 preload 暴露的 invoke 通道
  }
}
const preloadFile = path.join(REPO, 'packages/desktop/src/preload/index.ts');
let preloadChannels = [];
if (fs.existsSync(preloadFile)) {
  const src = fs.readFileSync(preloadFile, 'utf8');
  const re = /(?:invoke|send)\(\s*([\x60'"])([^\x60'"]+)\1/g;
  let m; while ((m = re.exec(src))) preloadChannels.push(m[2]);
}
const repIpcU = uniqBy(repIpc.filter(x => x.order === 'handle'), x => x.channel);

save('replica-routes.json', { count: repRoutes.length, controllers: ts.controllers.length, files: ts.files, routes: repRoutes });
save('replica-schema.json', repoSchema);
save('replica-ipc.json', { count: repIpcU.length, handles: repIpcU, preload: uniqBy(preloadChannels.map(c => ({ channel: c })), x => x.channel) });

// ---------- 基线自校验：与 contracts/ 三份基线对照 ----------
const contracts = path.join(REPO, 'contracts');
function lines(p) { return fs.readFileSync(p, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean); }
const cRoutesRaw = lines(path.join(contracts, 'http_routes_238.txt'));
const normalizeRoute = value => {
  const split = value.indexOf(' ');
  if (split < 0) return value;
  const method = value.slice(0, split), route = value.slice(split + 1).replace(/\/+$/, '') || '/';
  return method + ' ' + route;
};
const cRoutes = [...new Set(cRoutesRaw.map(normalizeRoute))];
const cIpc = lines(contractIpcPath).map(l => l.split('\t')[0]);
const mineRoutes = origRoutes.map(r => r.method + ' ' + r.path);
const setDiff = (a, b) => ({ onlyA: a.filter(x => !b.includes(x)), onlyB: b.filter(x => !a.includes(x)) });
const normalizedMineRoutes = [...new Set(mineRoutes.map(normalizeRoute))];
const rd = setDiff(normalizedMineRoutes, cRoutes);
const ipcEvidencePath = path.join(OUT, 'ipc-runtime-evidence.json');
const ipcEvidence = fs.existsSync(ipcEvidencePath) ? JSON.parse(fs.readFileSync(ipcEvidencePath, 'utf8')) : null;
save('baseline-check.json', {
  routes: { extracted: mineRoutes.length, contractRaw: cRoutesRaw.length, contractNormalizedUnique: cRoutes.length, onlyExtracted: rd.onlyA, onlyContract: rd.onlyB },
  ipc: { runtimeContract: origIpc.length, contract: cIpc.length, evidence: 'Mock-electron dynamic import capture; bundle string scan is separate evidence only', bundleStringScanFound: ipcEvidence?.foundInBundle ?? null, preloadStringScanFound: ipcEvidence?.preload ?? null },
  tables: { orig: origSchema.models.length, contractSchemaModels: (fs.readFileSync(path.join(contracts, 'schema_original_47.prisma'), 'utf8').match(/^model\s+\w+/gm) || []).length }
});

console.log(JSON.stringify({
  origRoutes: mineRoutes.length, origControllers: dist.controllers.length, origDistFiles: dist.files,
  origIpcHandles: origIpc.length, origIpcEvidence: 'mock-electron dynamic import contract',
  origTables: origSchema.models.length, origEnums: origSchema.enums.length,
  origFields: origSchema.models.reduce((a, m) => a + m.fields.length, 0),
  repRoutes: repRoutes.length, repControllers: ts.controllers.length,
  repIpc: repIpcU.length, repPreloadChannels: preloadChannels.length,
  repoTables: repoSchema.models.length, repoEnums: repoSchema.enums.length,
  repoFields: repoSchema.models.reduce((a, m) => a + m.fields.length, 0),
  routeBaselineDiff: rd, ipcBaselineEvidence: { runtimeContract: origIpc.length }
}, null, 2));
