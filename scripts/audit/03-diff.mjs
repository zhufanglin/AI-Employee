// scripts/audit/03-diff.mjs — 表/字段、模块路由、IPC 前缀 三张 diff 表
import fs from 'node:fs';
const OUT='scripts/audit/out';
const rd=f=>JSON.parse(fs.readFileSync(OUT+'/'+f,'utf8'));
const o=rd('original-schema.json'), r=rd('replica-schema.json');
const or=rd('original-routes.json').routes, rr=rd('replica-routes.json').routes;
const ri=rd('replica-ipc.json').handles;
// ---------- 表 diff ----------
const om=new Map(o.models.map(m=>[m.name,m])), rm=new Map(r.models.map(m=>[m.name,m]));
const tableDiff=[];
for(const [name,m] of om){
  const t=rm.get(name);
  const of=m.fields.map(f=>f.name);
  if(!t){ tableDiff.push({table:name,status:'MISSING_TABLE',origFields:of.length,repFields:0,missingFields:of,extraFields:[],typeMismatch:[]}); continue; }
  const rf=new Map(t.fields.map(f=>[f.name,f]));
  const missing=of.filter(n=>!rf.has(n));
  const extra=t.fields.map(f=>f.name).filter(n=>!of.includes(n));
  const tm=[];
  for(const f of m.fields){ const g=rf.get(f.name); if(!g) continue;
    if(g.type!==f.type || !!g.list!==!!f.list || !!g.optional!==!!f.optional) tm.push({field:f.name,orig:f.type+(f.list?'[]':'')+(f.optional?'?':''),rep:g.type+(g.list?'[]':'')+(g.optional?'?':'')});
  }
  tableDiff.push({table:name,status: missing.length||tm.length ? 'PARTIAL':'OK', origFields:of.length, repFields:t.fields.length, missingFields:missing, extraFields:extra, typeMismatch:tm});
}
for(const [name] of rm) if(!om.has(name)) tableDiff.push({table:name,status:'EXTRA_TABLE',origFields:0,repFields:rm.get(name).fields.length,missingFields:[],extraFields:rm.get(name).fields.map(f=>f.name),typeMismatch:[]});
// ---------- 模块路由 diff ----------
const routeKey = r => {
  const route = r.path.replace(/\/+$/, '') || '/';
  return r.method.toUpperCase() + ' ' + route;
};
const origRouteKeys = new Set(or.map(routeKey)), repRouteKeys = new Set(rr.map(routeKey));
const routeMissing = [...origRouteKeys].filter(route => !repRouteKeys.has(route)).sort();
const routeExtra = [...repRouteKeys].filter(route => !origRouteKeys.has(route)).sort();
const routeModule = r => r.path.split('/').filter(Boolean)[0] || 'root';
const mods=[...new Set([...or.map(routeModule),...rr.map(routeModule)])].sort();
const moduleDiff=mods.map(module=>{
  const original=or.filter(r=>routeModule(r)===module), replica=rr.filter(r=>routeModule(r)===module);
  const oset=new Set(original.map(routeKey)), rset=new Set(replica.map(routeKey));
  const matched=[...oset].filter(route=>rset.has(route)).length;
  const missing=oset.size-matched, extra=rset.size-matched;
  const status=!original.length?'EXTRA':missing===0&&extra===0?'OK':matched===0?'MISSING':'PARTIAL';
  return {module,orig:original.length,rep:replica.length,matched,missing,extra,status};
});
// ---------- IPC 前缀 diff ----------
const ipcBase=fs.readFileSync('contracts/ipc_handles_147.tsv','utf8').split(/\r?\n/).filter(Boolean).map(l=>l.split('\t')[0]);
const repCh=new Set(ri.map(h=>h.channel));
const groups={}; for(const c of ipcBase){const g=c.split(':')[0]; groups[g]=groups[g]||{orig:0,rep:0,repChannels:[]}; groups[g].orig++; if(repCh.has(c)){groups[g].rep++; groups[g].repChannels.push(c);}}
const ipcDiff=Object.entries(groups).sort((a,b)=>b[1].orig-a[1].orig).map(([g,v])=>({prefix:g,orig:v.orig,rep:v.rep,repChannels:v.repChannels}));
// ---------- 汇总 ----------
const summ={
  tables:{orig:om.size, repTotal:r.models.length, repM:tableDiff.filter(t=>t.status!=='MISSING_TABLE'&&t.status!=='EXTRA_TABLE').length, missing:tableDiff.filter(t=>t.status==='MISSING_TABLE').map(t=>t.table), extra:tableDiff.filter(t=>t.status==='EXTRA_TABLE').map(t=>t.table)},
  fields:{orig:o.models.reduce((a,m)=>a+m.fields.length,0), rep:r.models.reduce((a,m)=>a+m.fields.length,0), missingOnShared:tableDiff.filter(t=>t.status!=='MISSING_TABLE').reduce((a,t)=>a+t.missingFields.length,0)},
  routes:{orig:or.length, rep:rr.length, exactMatched:origRouteKeys.size-routeMissing.length, missing:routeMissing.length, extra:routeExtra.length, missingRoutes:routeMissing, extraRoutes:routeExtra, missingModules:moduleDiff.filter(m=>m.status==='MISSING').map(m=>m.module)},
  ipcChannels:{orig:ipcBase.length, repExact:ipcBase.filter(c=>repCh.has(c)).length, repTotal:ri.length, repExtra:ri.map(h=>h.channel).filter(c=>!ipcBase.includes(c))},
};
fs.writeFileSync(OUT+'/diff.json', JSON.stringify({summary:summ,tableDiff,moduleDiff,ipcDiff},null,1));
console.log(JSON.stringify(summ,null,1));
console.log('--- MISSING TABLES ---'); console.log(tableDiff.filter(t=>t.status==='MISSING_TABLE').map(t=>t.table+'('+t.origFields+'字段)').join(' '));
console.log('--- MODULE DIFF ---');
for(const m of moduleDiff) console.log([m.module,m.orig,m.rep,m.status].join('\t'));
console.log('--- IPC ---'); for(const g of ipcDiff) console.log([g.prefix,g.orig,g.rep].join('\t'));
