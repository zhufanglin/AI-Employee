/**
 * 微信公众号「消息加解密方案」纯实现（只用 node:crypto，不引入第三方库）
 *
 * 协议来源（官方文档）：
 * - 公众号 → 开发 → 消息管理 → 消息加解密说明
 *   https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Message_encryption_and_decryption_instructions.html
 * - 接入指南（服务器配置 / 签名校验）
 *   https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/Access_Overview.html
 *
 * 算法要点（与企业微信同源，但 receiveid 是公众号 AppID）：
 * 1. EncodingAESKey 43 位 Base64，补 "=" 后解码得到 32 字节 AESKey；
 * 2. AES-256-CBC，IV = AESKey 前 16 字节，PKCS#7 块大小 32；
 * 3. 明文 = random(16) + msg_len(4，大端) + msg + appid；
 * 4. 安全模式签名 = sha1(sort([token, timestamp, nonce, Encrypt]).join(""));
 *    明文模式签名 = sha1(sort([token, timestamp, nonce]).join(""))。
 */

import * as crypto from "node:crypto";

/** PKCS#7 填充块大小：公众号官方示例固定为 32 */
export const AES_BLOCK_SIZE = 32;
export const RANDOM_PREFIX_LEN = 16;

/** EncodingAESKey(43 位 Base64) → 32 字节 AESKey */
export function parseEncodingAesKey(encodingAesKey: string): Buffer {
  const raw = String(encodingAesKey || "").trim();
  if (raw.length !== 43) {
    throw new Error("EncodingAESKey 长度必须为 43 位（公众号后台「随机生成」的值）");
  }
  const key = Buffer.from(raw + "=", "base64");
  if (key.length !== 32) {
    throw new Error("EncodingAESKey 非法：Base64 解码后必须是 32 字节");
  }
  return key;
}

/** PKCS#7 填充（块大小默认 32） */
export function pkcs7Encode(buf: Buffer, blockSize: number = AES_BLOCK_SIZE): Buffer {
  const pad = blockSize - (buf.length % blockSize);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

/** PKCS#7 去填充（块大小默认 32） */
export function pkcs7Decode(buf: Buffer, blockSize: number = AES_BLOCK_SIZE): Buffer {
  if (!buf.length) throw new Error("PKCS7 去填充失败：内容为空");
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > blockSize || pad > buf.length) {
    throw new Error("PKCS7 去填充失败：填充字节非法");
  }
  return buf.subarray(0, buf.length - pad);
}

/**
 * 签名
 * - 安全模式：signature(token, timestamp, nonce, encrypt)
 * - 明文模式：signature(token, timestamp, nonce)
 */
export function signature(token: string, timestamp: string, nonce: string, encrypt?: string): string {
  const parts = [String(token ?? ""), String(timestamp ?? ""), String(nonce ?? "")];
  if (encrypt !== undefined && encrypt !== null && encrypt !== "") parts.push(String(encrypt));
  return crypto.createHash("sha1").update(parts.sort().join("")).digest("hex");
}

/** 生成指定长度随机字符串（默认 16 个字母数字） */
export function randomStr(length = RANDOM_PREFIX_LEN): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(Math.max(1, length));
  let out = "";
  for (let i = 0; i < length; i += 1) out += chars[bytes[i] % chars.length];
  return out;
}

/**
 * 加密：明文 → Base64 密文
 * @param receiveId 公众号 AppID
 */
export function encrypt(text: string, receiveId: string, encodingAesKey: string): string {
  const key = parseEncodingAesKey(encodingAesKey);
  const iv = key.subarray(0, 16);
  const random = crypto.randomBytes(RANDOM_PREFIX_LEN);
  const msg = Buffer.from(String(text ?? ""), "utf8");
  const msgLen = Buffer.alloc(4);
  msgLen.writeUInt32BE(msg.length, 0);
  const plain = Buffer.concat([random, msgLen, msg, Buffer.from(String(receiveId ?? ""), "utf8")]);

  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(pkcs7Encode(plain)), cipher.final()]);
  return encrypted.toString("base64");
}

/**
 * 解密：Base64 密文 → 明文，并校验 receiveid（AppID）
 */
export function decrypt(cipherBase64: string, receiveId: string, encodingAesKey: string): string {
  const key = parseEncodingAesKey(encodingAesKey);
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([
    decipher.update(Buffer.from(String(cipherBase64 ?? ""), "base64")),
    decipher.final(),
  ]);
  const plain = pkcs7Decode(padded);

  if (plain.length < RANDOM_PREFIX_LEN + 4) throw new Error("密文长度不足，无法解析消息头");
  const msgLen = plain.readUInt32BE(RANDOM_PREFIX_LEN);
  const msgStart = RANDOM_PREFIX_LEN + 4;
  const msgEnd = msgStart + msgLen;
  if (msgEnd > plain.length) throw new Error("密文长度与消息长度字段不一致");
  const msg = plain.subarray(msgStart, msgEnd).toString("utf8");
  const fromReceiveId = plain.subarray(msgEnd).toString("utf8");

  if (String(receiveId ?? "") !== "" && fromReceiveId !== String(receiveId)) {
    throw new Error("receiveid 不匹配：期望 " + receiveId + "，实际 " + fromReceiveId);
  }
  return msg;
}
