const urls=["https://www.runninghub.cn/ai-apps","https://www.runninghub.cn/api/uc/openapi/ai-app/list?pageSize=20"];
(async()=>{for(const u of urls){try{const r=await fetch(u,{headers:{"user-agent":"Mozilla/5.0"}});const t=await r.text();console.log(u,r.status,t.length,t.slice(0,200).replace(/\s+/g," "));}catch(e){console.log(u,"ERR",e.message);}}})();
