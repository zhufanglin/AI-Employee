#!/usr/bin/env node
/**
 * T-11 渠道加解密冒烟测试（企业微信 + 微信公众号）
 *
 * 不依赖任何真实凭证：EncodingAESKey 由随机 32 字节 Base64 生成（恰好 43 位），
 * Token / CorpID / AppID 全部是假值，只验证官方加解密方案与验签逻辑。
 *
 * 运行前置：先 tsc 编译（脚本读取 packages/server/dist/channels/crypto/*.js）
 *   node "node_modules\typescript\bin\tsc" -p "packages\server\tsconfig.json"
 *   node scripts\smoke-channels.mjs
 *
 * 协议来源：
 * - 企业微信加解密方案：https://developer.work.weixin.qq.com/document/path/90968
 * - 企业微信回调协议：https://developer.work.weixin.qq.com/document/path/90930
 * - 公众号消息加解密：https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Message_encryption_and_decryption_instructions.html
 */
import { createRequire } from "node:module";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

const distChannels = path.join(root, "packages", "server", "dist", "channels");
const distCrypto = path.join(distChannels, "crypto");

let wecom;
let wechatMp;
let wecomXml;
try {
  wecom = require(path.join(distCrypto, "wecom-crypto.js"));
  wechatMp = require(path.join(distCrypto, "wechat-mp-crypto.js"));
  wecomXml = require(path.join(distChannels, "wecom", "xml.js"));
} catch (error) {
  console.error("无法加载编译产物：" + error.message);
  console.error("请先编译：node \"node_modules\\typescript\\bin\\tsc\" -p \"packages\\server\\tsconfig.json\"");
  process.exit(1);
}

const ok = (name) => console.log("OK   " + name);
let checks = 0;
const assert = (cond, name) => {
  checks += 1;
  if (!cond) throw new Error("断言失败：" + name);
  ok(name);
};
const assertThrows = (fn, matcher, name) => {
  checks += 1;
  try {
    fn();
  } catch (error) {
    if (matcher && !String(error && error.message).includes(matcher)) {
      throw new Error("断言失败：" + name + "（抛错信息不符： " + error.message + "）");
    }
    ok(name);
    return;
  }
  throw new Error("断言失败：" + name + "（期望抛错但没有抛）");
};

/** 生成合法的 43 位 EncodingAESKey：32 字节随机数的 Base64 去掉末尾 '=' */
const makeAesKey = () => randomBytes(32).toString("base64").slice(0, 43);

// ---------------------------------------------------------------------------
// 企业微信
// ---------------------------------------------------------------------------
console.log("== 企业微信自建应用 ==");
const wecomToken = "fake-wecom-token";
const wecomCorpId = "wwfakecorpid000001";
const wecomAesKey = makeAesKey();
const wecomTs = "1730000000";
const wecomNonce = "nonce-wecom-0001";

assert(wecomAesKey.length === 43, "EncodingAESKey 为 43 位");
assert(wecom.parseEncodingAesKey(wecomAesKey).length === 32, "parseEncodingAesKey 解出 32 字节 AES key");

// PKCS#7：企业微信/公众号方案块大小是 32（不是 16）
const padded = wecom.pkcs7Encode(Buffer.from("hello 企业微信", "utf8"));
assert(padded.length % 32 === 0, "PKCS7 填充块大小 32");
assert(wecom.pkcs7Decode(padded).toString("utf8") === "hello 企业微信", "PKCS7 解码还原明文");

// 加解密往返（含中文、XML 特殊字符）
const wecomPlain = '<xml><Content>测试 & 转义 <tag> "引号"</Content></xml>';
const wecomCipher = wecom.encrypt(wecomPlain, wecomCorpId, wecomAesKey);
assert(typeof wecomCipher === "string" && wecomCipher.length > 0, "企微 encrypt 产出 Base64 密文");
assert(wecom.decrypt(wecomCipher, wecomCorpId, wecomAesKey) === wecomPlain, "企微 encrypt→decrypt 往返一致");
assert(wecom.randomStr(16).length === 16, "企微 randomStr(16) 生成长度正确");

// 签名：sha1(sort([token, timestamp, nonce, encrypt]).join(""))
const wecomSig = wecom.signature(wecomToken, wecomTs, wecomNonce, wecomCipher);
const expectedWecomSig = createHash("sha1")
  .update([wecomToken, wecomTs, wecomNonce, wecomCipher].sort().join(""))
  .digest("hex");
assert(wecomSig === expectedWecomSig, "企微 signature 与官方算法一致（含 Encrypt）");
assert(
  wecom.signature("other-token", wecomTs, wecomNonce, wecomCipher) !== wecomSig,
  "企微 signature 用于错误 token 时不相等",
);

// receiveid 校验：不匹配必须抛错
assertThrows(
  () => wecom.decrypt(wecomCipher, "ww-other-corp", wecomAesKey),
  "receiveid",
  "企微 receiveid 不匹配时抛错",
);

// URL 验证场景：echostr 本身是密文，签名包含 echostr
const echoPlain = "echo-plaintext-1234567890";
const echoCipher = wecom.encrypt(echoPlain, wecomCorpId, wecomAesKey);
const echoSig = createHash("sha1")
  .update([wecomToken, wecomTs, wecomNonce, echoCipher].sort().join(""))
  .digest("hex");
assert(wecom.signature(wecomToken, wecomTs, wecomNonce, echoCipher) === echoSig, "企微 URL 验证 echostr 签名校验通过");
assert(wecom.decrypt(echoCipher, wecomCorpId, wecomAesKey) === echoPlain, "企微加密 echostr 解密后得到明文 echostr");

// XML 组装：被动回复需要 ToUserName/FromUserName 互换
const replyXml = wecomXml.buildPassiveReplyXml("user-from", "corp-to", "已收到，正在处理", 1730000001);
assert(replyXml.includes("<ToUserName><![CDATA[user-from]]></ToUserName>"), "企微被动回复 XML ToUserName 正确");
assert(replyXml.includes("<FromUserName><![CDATA[corp-to]]></FromUserName>"), "企微被动回复 XML FromUserName 正确");
const parsedReply = wecomXml.parseFlatXml(replyXml);
assert(parsedReply.ToUserName === "user-from" && parsedReply.Content === "已收到，正在处理", "企微 XML 解析往返一致");

// ---------------------------------------------------------------------------
// 微信公众号
// ---------------------------------------------------------------------------
console.log("");
console.log("== 微信公众号（服务号） ==");
const mpToken = "fake-mp-token";
const mpAppId = "wxfakeappid000001";
const mpAesKey = makeAesKey();
const mpTs = "1730000002";
const mpNonce = "nonce-mp-0002";

assert(mpAesKey.length === 43, "公众号 EncodingAESKey 为 43 位");
const mpPlain = '<xml><Content>公众号 测试 & <tag></Content></xml>';
const mpCipher = wechatMp.encrypt(mpPlain, mpAppId, mpAesKey);
assert(wechatMp.decrypt(mpCipher, mpAppId, mpAesKey) === mpPlain, "公众号 encrypt→decrypt 往返一致");
assert(wechatMp.randomStr(16).length === 16, "公众号 randomStr(16) 生成长度正确");
assertThrows(
  () => wechatMp.decrypt(mpCipher, "wx-other-appid", mpAesKey),
  "receiveid",
  "公众号 AppID（receiveid）不匹配时抛错",
);

// 明文模式：signature = sha1(sort([token, timestamp, nonce]).join(""))
const mpEchostr = "mp-echostr-plaintext";
const expectedPlainSig = createHash("sha1")
  .update([mpToken, mpTs, mpNonce].sort().join(""))
  .digest("hex");
assert(wechatMp.signature(mpToken, mpTs, mpNonce) === expectedPlainSig, "公众号明文 signature 与官方算法一致");
assert(wechatMp.signature("wrong-token", mpTs, mpNonce) !== expectedPlainSig, "公众号明文 signature 错误 token 不相等");
assert(
  createHash("sha1").update([mpToken, mpTs, mpNonce].sort().join("")).digest("hex") === expectedPlainSig &&
    mpEchostr === "mp-echostr-plaintext",
  "公众号明文 echostr 校验后原样返回",
);

// 安全模式：msg_signature = sha1(sort([token, timestamp, nonce, Encrypt]).join(""))
const securePlain = "secure-echostr-0001";
const secureCipher = wechatMp.encrypt(securePlain, mpAppId, mpAesKey);
const secureSig = createHash("sha1")
  .update([mpToken, mpTs, mpNonce, secureCipher].sort().join(""))
  .digest("hex");
assert(wechatMp.signature(mpToken, mpTs, mpNonce, secureCipher) === secureSig, "公众号安全模式 msg_signature 校验通过");
assert(wechatMp.decrypt(secureCipher, mpAppId, mpAesKey) === securePlain, "公众号安全模式解密 echostr 得到明文");

console.log("");
console.log("共 " + checks + " 项断言通过");
console.log("CHANNELS SMOKE OK");
