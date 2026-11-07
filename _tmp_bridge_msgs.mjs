const r=await fetch('http://127.0.0.1:8600/api/v1/chat/messages?chat_name='+encodeURIComponent('朱方林'),{headers:{authorization:'Bearer 706fefd65d21907a14cc8ed0200f0866'}});
const j=await r.json();
const items=(j.items||[]).slice();
console.log('total',items.length);
for(const m of items.slice(-10)) console.log(new Date(m.ts*1000).toISOString(), m.from, JSON.stringify(String(m.text).slice(0,80)));