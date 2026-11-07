import fs from "node:fs";
import crypto from "node:crypto";
const cands = JSON.parse(fs.readFileSync("C:/Users/30290/Desktop/fcmediaagent-replica/_tmp/oss/cands.json", "utf8")).filter((c) => c.user.includes("@"));
const bucket = "zhongke001";
async function req(url, ak, sk, method = "GET") {
  for (let i = 0; i < 4; i++) {
    const date = new Date().toUTCString();
    const u = new URL(url);
    const resource = "/" + bucket + (u.pathname === "/" ? "/" : u.pathname);
    const str = method + "\n\n\n" + date + "\n" + resource;
    const sig = crypto.createHmac("sha1", sk).update(str).digest("base64");
    try {
      const r = await fetch(url, { method, headers: { Date: date, Authorization: "OSS " + ak + ":" + sig } });
      return { status: r.status, text: await r.text() };
    } catch (e) { if (i === 3) return { status: 0, text: e.message }; }
  }
}
for (const c of cands) {
  const r = await req("https://" + bucket + ".oss-cn-beijing.aliyuncs.com/?acl", c.ak, c.sk);
  console.log(c.user, "ACL ->", r.status, r.text.replace(/\s+/g, " ").slice(0, 300));
}
