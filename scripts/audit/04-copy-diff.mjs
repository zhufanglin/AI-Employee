// scripts/audit/04-copy-diff.mjs — 原版中文提示/错误文案 与复刻文案对照（F1）
import fs from 'node:fs';import path from 'node:path';
const EXTRACT='C:/Users/30290/Desktop/部署文件/_extract/server1027/dist';
const REPO='packages/server/src';
function walk(d,acc=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name); if(e.isDirectory())walk(p,acc); else if(e.name.endsWith('.js'))acc.push(p);} return acc;}
function walkTs(d,acc=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name); if(e.isDirectory())walkTs(p,acc); else if(/\.(ts|tsx)$/.test(e.name))acc.push(p);} return acc;}
const files=walk(EXTRACT);
const cn=/[\u4e00-\u9fa5]/;
const perFile={}; const all=new Set();
for(const f of files){ const s=fs.readFileSync(f,'utf8');
  const lits=s.match(/'[^'\n]{1,80}'|"[^"\n]{1,80}"/g)||[];
  const msgs=lits.map(x=>x.slice(1,-1)).filter(x=>cn.test(x));
  if(msgs.length){ const rel=path.relative(EXTRACT,f).replace(/\\/g,'/'); perFile[rel]=[...new Set(msgs)]; msgs.forEach(m=>all.add(m)); }
}
const repFiles=walkTs(REPO); const repCorpus=repFiles.map(f=>fs.readFileSync(f,'utf8')).join('\n');
const hit=[...all].filter(m=>repCorpus.includes(m));
// 分模块统计
const modStat={};
for(const [f,msgs] of Object.entries(perFile)){ const mod=f.split('/')[0]; const cur=modStat[mod]||(modStat[mod]={total:0,hit:0}); cur.total+=msgs.length; cur.hit+=msgs.filter(m=>repCorpus.includes(m)).length; }
const rows=Object.entries(modStat).sort((a,b)=>b[1].total-a[1].total);
const out={totalDistinct:[...all].length, hitInReplica:hit.length, perFile, modStat:Object.fromEntries(rows)};
fs.writeFileSync('scripts/audit/out/copy-diff.json', JSON.stringify(out,null,1));
console.log(JSON.stringify({totalDistinct:[...all].length,hitInReplica:hit.length,hitRatio:(hit.length/all.size).toFixed(3),files:Object.keys(perFile).length,repTsFiles:repFiles.length},null,1));
console.log('--- 模块级 ---'); for(const [k,v] of rows) console.log(k+'\t'+v.total+'\t'+v.hit);
console.log('--- 复刻已命中的文案（前40） ---'); console.log(hit.slice(0,40).join(' | '));
