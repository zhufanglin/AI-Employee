const API="http://127.0.0.1:3100/api";
const j=async(p,i={})=>{const r=await fetch(API+p,i);const t=await r.text();return {s:r.status,b:t.slice(0,400)};};
(async()=>{
const phone="139"+String(Date.now()).slice(-8);
const s=await j("/auth/sms/send",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phone})});
console.log("send",s.s,s.b);
const code=JSON.parse(s.b).devCode;
const l=await j("/auth/sms/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phone,code})});
console.log("login",l.s,l.b);
})();
