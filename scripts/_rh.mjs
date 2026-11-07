const key = "33d2bc7851b04bc7806de7b2c98f7540";
const base = "https://www.runninghub.ai";
async function post(path, body) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  return { status: r.status, body: (await r.text()).slice(0, 300) };
}
console.log("query:", JSON.stringify(await post("/openapi/v2/query", { taskId: "probe-not-exist" })));
console.log("run  :", JSON.stringify(await post("/openapi/v2/run/ai-app/2031016553440878594", { nodeInfoList: [] })));
