const kw=["混剪","剪辑","卡点","成片","口播","数字人","带货","视频合成"];
(async()=>{
const r=await fetch("https://www.runninghub.cn/ai-apps",{headers:{"user-agent":"Mozilla/5.0"}});
const html=await r.text();
const re=/<a[^>]+href="([^"]*ai-detail[^"]*)"[^>]*>([\s\S]{0,300}?)<\/a>/g;
let m,hits=[];
while((m=re.exec(html))){const txt=m[2].replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();if(kw.some(k=>txt.includes(k)))hits.push(m[1]+" | "+txt.slice(0,120));}
console.log("anchors",hits.length);
console.log([...new Set(hits)].slice(0,40).join("\n"));
})();
