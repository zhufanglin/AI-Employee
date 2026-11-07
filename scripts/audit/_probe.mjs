import fs from 'node:fs';
const or=JSON.parse(fs.readFileSync('scripts/audit/out/original-routes.json','utf8')).routes;
for(const x of or) if(['auth','compute','credits','site','volcengine','volcengine-proxy/v3','sms','redemption','payments'].includes(x.controller)) console.log(x.method,x.path,'['+x.controller+']');
