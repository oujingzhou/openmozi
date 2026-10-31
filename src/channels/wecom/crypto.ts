/**
 * 企业微信消息加解密工具
 * 实现 AES-256-CBC 加解密和签名验证
 */

import crypto from "crypto";
import { isFreshTimestamp, safeEqual } from "../common/signature.js";

export class WeComCrypto {
  private token: string;
  private encodingAESKey: string;
  private corpId: string;
  private aesKey: Buffer;

  constructor(token: string, encodingAESKey: string, corpId: string) {
    this.token = token;
    this.encodingAESKey = encodingAESKey;
    this.corpId = corpId;
    this.aesKey = Buffer.from(encodingAESKey + "=", "base64");
  }

  /** 验证签名：校验时间窗并做常量时间比较 */
  verifySignature(msgSignature: string, timestamp: string, nonce: string, echostr: string): boolean {
    if (!isFreshTimestamp(timestamp)) return false;
    return safeEqual(this.getSignature(timestamp, nonce, echostr), msgSignature);
  }

  /** 生成签名 */
  getSignature(timestamp: string, nonce: string, encryptedMsg: string): string {
    const arr = [this.token, timestamp, nonce, encryptedMsg].sort();
    const sha1 = crypto.createHash("sha1");
    sha1.update(arr.join(""));
    return sha1.digest("hex");
  }

  /** 解密消息 */
  decrypt(encrypted: string): { message: string; corpId: string } {
    const iv = this.aesKey.subarray(0, 16);
    const decipher = crypto.createDecipheriv("aes-256-cbc", this.aesKey, iv);
    decipher.setAutoPadding(false);

    let decrypted = Buffer.concat([
      decipher.update(encrypted, "base64"),
      decipher.final(),
    ]);

    // PKCS#7 去填充
    const pad = decrypted[decrypted.length - 1] ?? 0;
    decrypted = decrypted.subarray(0, decrypted.length - pad);

    // 去掉前 16 字节随机数
    const content = decrypted.subarray(16);

    // 读取消息长度 (4 字节 big-endian)
    const msgLen = content.readUInt32BE(0);
    const message = content.subarray(4, 4 + msgLen).toString("utf-8");
    const corpId = content.subarray(4 + msgLen).toString("utf-8");

    return { message, corpId };
  }

  /** 加密消息 */
  encrypt(message: string): string {
    const randomBytes = crypto.randomBytes(16);
    const msgBuf = Buffer.from(message, "utf-8");
    const msgLenBuf = Buffer.alloc(4);
    msgLenBuf.writeUInt32BE(msgBuf.length, 0);
    const corpIdBuf = Buffer.from(this.corpId, "utf-8");

    let plainBuf = Buffer.concat([randomBytes, msgLenBuf, msgBuf, corpIdBuf]);

    // PKCS#7 填充
    const blockSize = 32;
    const padLen = blockSize - (plainBuf.length % blockSize);
    const padBuf = Buffer.alloc(padLen, padLen);
    plainBuf = Buffer.concat([plainBuf, padBuf]);

    const iv = this.aesKey.subarray(0, 16);
    const cipher = crypto.createCipheriv("aes-256-cbc", this.aesKey, iv);
    cipher.setAutoPadding(false);

    const encrypted = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
    return encrypted.toString("base64");
  }

  /** 解密回调验证的 echostr */
  decryptEchoStr(echostr: string): string {
    const { message } = this.decrypt(echostr);
    return message;
  }
}
