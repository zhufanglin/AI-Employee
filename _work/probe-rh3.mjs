(async()=>{
const r=await fetch("https://www.runninghub.cn/ai-apps",{headers:{"user-agent":"Mozilla/5.0"}});
const html=await r.text();
const idx=[];let i=-1;
while((i=html.indexOf("混剪",i+1))!==-1)idx.push(i);
console.log("count 混剪",idx.length);
console.log(idx.slice(0,8).map(p=>html.slice(Math.max(0,p-200),p+120).replace(/\s+/g," ")).join("\n---\n"));
})();
