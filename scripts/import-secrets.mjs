import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DUMP = "C:/Users/30290/Desktop/部署文件/_extract/config-dump";
const REPO = "C:/Users/30290/Desktop/fcmediaagent-replica";
const ENV = path.join(REPO, "packages/server/.env");
const SECRETS = path.join(REPO, "packages/server/secrets");

const ENC = process.env.FCM_ENC_KEY || "";
if (!ENC) { console.error("missing FCM_ENC_KEY"); process.exit(2); }
const KEY = crypto.scryptSync(ENC.trim().replace(/^["']|["']$/g, ""), "salt", 32);

function unesc(v) {
  if (v === "NULL") return null;
  return v.replace(/\\(.)/g, (m, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c));
}
function readTable(name) {
  const p = path.join(DUMP, name + ".tsv");
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const header = lines[0].split("\t");
  const row = lines[1].split("\t");
  const o = {};
  header.forEach((h, i) => (o[h] = unesc(row[i] ?? "")));
  return o;
}
const isEnc = (v) => typeof v === "string" && /^[0-9a-f]{32}:/.test(v);
const failures = [];
function dec(v, label = "") {
  if (!v) return v;
  if (!isEnc(v)) return v;
  try {
    const i = v.indexOf(":");
    const iv = Buffer.from(v.slice(0, i), "hex");
    const data = Buffer.from(v.slice(i + 1), "hex");
    const d = crypto.createDecipheriv("aes-256-cbc", KEY, iv);
    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  } catch (e) {
    failures.push(label + " (" + e.code + ", len=" + v.length + ")");
    return null;
  }
}
const mask = (s) => (!s ? "(empty)" : s.length <= 8 ? s.slice(0,2) + "***" : s.slice(0, 4) + "***" + s.slice(-2) + " (len=" + s.length + ")");

const sms = readTable("SmsConfig");
const oss = readTable("OssConfig");
const pay = readTable("WechatPayConfig");

fs.mkdirSync(SECRETS, { recursive: true });
const pk = dec(pay?.privateKey, "WECHAT_PAY_PRIVATE_KEY");
const pub = dec(pay?.publicKey, "WECHAT_PAY_PUBLIC_KEY");
let pkPath = null, pubPath = null;
if (pk) { pkPath = path.join(SECRETS, "apiclient_key.pem"); fs.writeFileSync(pkPath, pk.trim() + "\n"); }
if (pub) {
  pubPath = path.join(SECRETS, pub.includes("BEGIN CERTIFICATE") ? "wechat_platform_cert.pem" : "wechat_platform_pub.pem");
  fs.writeFileSync(pubPath, pub.trim() + "\n");
}

const vals = {
  ALIYUN_SMS_ACCESS_KEY_ID: dec(sms?.secretId, "ALIYUN_SMS_ACCESS_KEY_ID"),
  ALIYUN_SMS_ACCESS_KEY_SECRET: dec(sms?.secretKey, "ALIYUN_SMS_ACCESS_KEY_SECRET"),
  ALIYUN_SMS_SIGN_NAME: sms?.signName,
  ALIYUN_SMS_TEMPLATE_CODE: sms?.templateCode,
  ALIYUN_SMS_REGION: sms?.region || "cn-hangzhou",
  OSS_ACCESS_KEY_ID: dec(oss?.accessKeyId, "OSS_ACCESS_KEY_ID"),
  OSS_ACCESS_KEY_SECRET: dec(oss?.accessKeySecret, "OSS_ACCESS_KEY_SECRET"),
  OSS_BUCKET: oss?.bucketName,
  OSS_REGION: oss?.region || "oss-cn-beijing",
  OSS_ENDPOINT: oss?.endpoint || "oss-cn-beijing.aliyuncs.com",
  WECHAT_PAY_APP_ID: pay?.appId,
  WECHAT_PAY_MCH_ID: pay?.mchId,
  WECHAT_PAY_API_V3_KEY: dec(pay?.apiV3Key, "WECHAT_PAY_API_V3_KEY"),
  WECHAT_PAY_SERIAL_NO: pay?.certSerialNo || "",
  WECHAT_PAY_PRIVATE_KEY_PATH: pkPath ? pkPath.replace(/\\/g, "/") : "",
  WECHAT_PAY_PLATFORM_CERT_PATH: pubPath ? pubPath.replace(/\\/g, "/") : "",
};

let env = fs.readFileSync(ENV, "utf8");
for (const [k, v] of Object.entries(vals)) {
  if (!v) continue;
  const line = k + "=" + v;
  const re = new RegExp("^" + k + "=.*$", "m");
  if (re.test(env)) env = env.replace(re, () => line);
  else env = env.replace(/\s*$/, "\n") + line + "\n";
}
// 数据库里存的是密钥池；复刻直接用 env，关闭 mock 之前的短信开发码
fs.writeFileSync(ENV, env, "utf8");

if (failures.length) console.log("解密失败字段：", failures.join(", "));
console.log("解密并写入 .env：");
console.log(" SMS AK        ", mask(vals.ALIYUN_SMS_ACCESS_KEY_ID));
console.log(" SMS SK        ", mask(vals.ALIYUN_SMS_ACCESS_KEY_SECRET));
console.log(" OSS AK/SK     ", mask(vals.OSS_ACCESS_KEY_ID), "/", mask(vals.OSS_ACCESS_KEY_SECRET));
console.log(" OSS bucket    ", vals.OSS_BUCKET, vals.OSS_REGION);
console.log(" WX APIv3Key   ", mask(vals.WECHAT_PAY_API_V3_KEY));
console.log(" WX serial_no  ", vals.WECHAT_PAY_SERIAL_NO || "(数据库为空)");
console.log(" WX privateKey ", pk ? "len=" + pk.length + " head=" + JSON.stringify(pk.slice(0, 31)) : "MISSING");
console.log(" WX platform   ", pub ? "len=" + pub.length + " -> " + path.basename(pubPath) + " head=" + JSON.stringify(pub.slice(0, 30)) : "MISSING");
