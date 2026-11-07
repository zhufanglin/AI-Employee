
const key = "33d2bc7851b04bc7806de7b2c98f7540";
const r = await fetch("https://www.runninghub.ai/openapi/v2/query", { method:"POST", headers:{ "content-type":"application/json", authorization:"Bearer "+key }, body: JSON.stringify({ taskId: "2118361198026379266" }) });
console.log(r.status, (await r.text()).slice(0,900));
const r2 = await fetch("https://www.runninghub.ai/openapi/v2/query", { method:"POST", headers:{ "content-type":"application/json", authorization:"Bearer "+key }, body: JSON.stringify({ taskId: "2118360875496988674" }) });
console.log("clone:", r2.status, (await r2.text()).slice(0,400));
