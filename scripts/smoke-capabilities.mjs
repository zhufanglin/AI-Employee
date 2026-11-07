import { createRequire } from "node:module";
import { lookup } from "node:dns/promises";
const require2 = createRequire("C:/Users/30290/Desktop/fcmediaagent-replica/packages/server/package.json");
const { PrismaClient } = require2("@prisma/client");
const prisma = new PrismaClient();

const API = process.env.FCM_API || "http://127.0.0.1:3000/api";
const phone = "139" + String(Date.now()).slice(-8);
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log("PASS " + name + (extra ? " " + JSON.stringify(extra) : "")); }
  else { fail++; console.log("FAIL " + name + " " + JSON.stringify(extra)); }
}
async function j(path, init = {}) {
  const res = await fetch(API + path, init);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
const post = (p, token, obj) => j(p, { method: "POST", headers: { "content-type": "application/json", authorization: token ? "Bearer " + token : "" }, body: JSON.stringify(obj) });

const sent = await post("/auth/sms/send", "", { phone });
const login = await post("/auth/sms/login", "", { phone, code: sent.body?.devCode });
const token = login.body?.accessToken || login.body?.token;
const userId = login.body?.user?.id;
check("login", !!token, { phone });

const list = await j("/capabilities", { headers: { authorization: "Bearer " + token } });
check("capability list", list.status === 200 && list.body?.total >= 7, { total: list.body?.total, names: (list.body?.items || []).map((x) => x.name) });

const unauth = await post("/capabilities/run", "", { name: "web_extract", params: { url: "https://example.com" } });
check("capability requires auth", unauth.status === 401, { status: unauth.status });

const web = await post("/capabilities/run", token, { name: "web_extract", params: { url: "https://example.com" } });
const resolved = await lookup('example.com', { all: true });
const fakeIpDns = resolved.length > 0 && resolved.every(x => /^(198\.18|198\.19)\./.test(x.address));
if (fakeIpDns && web.body?.success === false && /禁止访问/.test(web.body?.error || '')) console.log('SKIP public web extraction: VPN fake-IP DNS is intentionally blocked');
else check("web_extract ok", web.body?.success === true && String(web.body?.data?.text || "").length > 10, { title: web.body?.data?.title, len: web.body?.data?.length });
check("web_extract bad url", (await post("/capabilities/run", token, { name: "web_extract", params: { url: "ftp://x" } })).body?.success === false);
for (const address of ['http://127.0.0.1:3000/api/health', 'http://169.254.169.254/', 'http://[::1]/', 'http://[::ffff:7f00:1]:3000/api/health', 'http://[::ffff:a9fe:a9fe]/', 'http://10.0.0.1/']) {
  const denied = await post('/capabilities/run', token, { name: 'web_extract', params: { url: address } });
  check('web_extract rejects private address ' + address, denied.body?.success === false && /禁止访问/.test(denied.body?.error || ''));
}

const save = await post("/capabilities/run", token, { name: "content_save", params: { title: "能力层冒烟素材", contentSummary: "这是一条由 capability 写入的素材", category: "短视频", mustUse: true } });
check("content_save ok", save.body?.success === true && !!save.body?.data?.id, { id: save.body?.data?.id });
const query = await post("/capabilities/run", token, { name: "content_query", params: { category: "短视频" } });
check("content_query ok", query.body?.success === true && query.body?.data?.length === 1, { n: query.body?.data?.length });

const cust = await post("/capabilities/run", token, { name: "customer_save", params: { company: "冒烟科技有限公司", wechatNickname: "smoke_wx", industry: "口腔" } });
check("customer_save ok", cust.body?.success === true && !!cust.body?.data?.id);
const cq = await post("/capabilities/run", token, { name: "customer_query", params: { industry: "口腔" } });
check("customer_query ok", cq.body?.success === true && cq.body?.data?.length === 1);

const dist = await post("/capabilities/run", token, { name: "distribution_save", params: { summaryContent: "今日分发：小红书 1 条、视频号 1 条" } });
check("distribution_save ok", dist.body?.success === true && !!dist.body?.data?.id);

const bad = await post("/capabilities/run", token, { name: "no_such_capability", params: {} });
check("unknown capability rejected", bad.status === 400 || bad.status === 404, { status: bad.status });

const missing = await post("/capabilities/customer_save", token, {});
check("missing params reported", missing.body?.success === false && /company/.test(String(missing.body?.error)), { error: missing.body?.error });

const llm = await post("/capabilities/run", token, { name: "llm_text", params: { instruction: "只回复两个字：能力", input: "测试" } });
check("llm_text ok", llm.body?.success === true && String(llm.body?.data?.text || "").length > 0, { text: String(llm.body?.data?.text || "").slice(0, 40) });

// 清理
const dbPhone = phone;
await prisma.contentCollection.deleteMany({ where: { phone: dbPhone } });
await prisma.potentialCustomer.deleteMany({ where: { phone: dbPhone } });
await prisma.dailyDistribution.deleteMany({ where: { phone: dbPhone } });
await prisma.$disconnect();
console.log("CAPABILITY RESULT: " + (fail === 0 ? "ALL PASS" : fail + " FAILED") + " (" + (pass + fail) + " checks)");
process.exit(fail === 0 ? 0 : 1);
