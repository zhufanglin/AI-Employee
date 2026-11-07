const API="http://127.0.0.1:3000/api";
async function j(p,i={}){const r=await fetch(API+p,i);const t=await r.text();let b;try{b=JSON.parse(t)}catch{b=t}return{status:r.status,body:b}}
const phone=process.env.P; const WANT=process.env.TASK; const LIMIT=Number(process.env.LIMIT||150);
async function login(){
  for (let a=0;a<10;a++){
    const s=await j("/auth/sms/send",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phone})});
    if (s.body?.devCode){ const l=await j("/auth/sms/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phone,code:s.body.devCode})}); const t=l.body?.accessToken||l.body?.token; if(t) return t; }
    console.log("[wait] sms rate limited, retry in 65s");
    await new Promise(r=>setTimeout(r,65000));
  }
  return null;
}
const token=await login(); if(!token){console.log("LOGIN FAILED");process.exit(1)}
const H={"content-type":"application/json",authorization:"Bearer "+token};
for (let i=0;i<LIMIT;i++){
  const cv=await j("/compose-videos",{headers:H});
  const rows=Array.isArray(cv.body?.rows)?cv.body.rows:(Array.isArray(cv.body)?cv.body:(cv.body?.items||[]));
  const row=WANT?rows.find(r=>r.id===WANT):rows[0];
  console.log("[poll "+i+"]", row?JSON.stringify({id:row.id,s:row.status,v:row.videoUrl}):"none");
  if (row && !["composing","cloning_audio","pending"].includes(row.status)){ console.log("FINAL "+JSON.stringify(row).slice(0,900)); break; }
  await new Promise(r=>setTimeout(r,12000));
}
