// scripts/audit/02-verify-ipc.mjs - 用原版打包产物字面量校验 147 IPC 基线（主进程为 obfuscator 混淆，无法直接静态解析）
import fs from 'node:fs';
import path from 'node:path';
const EXTRACT = 'C:/Users/30290/Desktop/部署文件/_extract';
const REPO = 'C:/Users/30290/Desktop/fcmediaagent-replica';
const roots = [
  path.join(EXTRACT, '0.4.29/asar/dist-electron/main'),
  path.join(EXTRACT, '0.4.29/asar/dist-electron'),
  path.join(EXTRACT, '0.4.29/asar/dist-electron/preload')
];
const files = [];
function walk(d){ for(const e of fs.readdirSync(d,{withFileTypes:true})){ const p=path.join(d,e.name); if(e.isDirectory()) walk(p); else if(/\.js$/.test(e.name) && !/\.map$/.test(e.name)) files.push(p);} }
for (const r of roots) if (fs.existsSync(r)) walk(r);
const uniq = [...new Set(files)];
const corpus = uniq.map(f => fs.readFileSync(f,'utf8')).join('\n');
const channels = fs.readFileSync(path.join(REPO,'contracts/ipc_handles_147.tsv'),'utf8')
  .split(/\r?\n/).map(s=>s.trim()).filter(Boolean).map(l=>{const [c,a]=l.split('\t'); return {channel:c, arity:a};});
const missing = channels.filter(c => !corpus.includes(c.channel));
const preloadSource = fs.readFileSync(path.join(EXTRACT,'0.4.29/asar/dist-electron/preload/index.js'),'utf8');
const preloadOnly = channels.filter(c => {
  return preloadSource.includes(c.channel);
});
const evidence = {files: uniq.length, channels: channels.length, foundInBundle: channels.length - missing.length, missing: missing.map(m=>m.channel), preload: preloadOnly.length, note: 'String presence is not proof of runtime behavior; the handle list comes from the previously captured mock-electron dynamic import contract.'};
fs.writeFileSync(path.join(REPO,'scripts/audit/out/ipc-runtime-evidence.json'), JSON.stringify(evidence,null,2), 'utf8');
console.log(JSON.stringify(evidence, null, 2));
// 分类统计（按前缀），用于报告的表一/表三分组
const groups = {};
for (const c of channels) { const g = c.channel.split(':')[0]; groups[g] = (groups[g]||0)+1; }
console.log(JSON.stringify(groups, null, 2));
