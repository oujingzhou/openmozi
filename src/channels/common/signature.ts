/**
 * 通道回调签名校验
 *
 * 所有通道共用：常量时间比较、时间窗防重放、未配置密钥时失败关闭。
 */

import crypto from "crypto";

/** 允许的时间偏差：超过即视为重放 */
export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

/** 常量时间字符串比较，避免按字节泄露签名前缀 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 校验回调时间戳是否在允许窗口内。
 * timestamp 可能是秒或毫秒，两种都接受。
 */
export function isFreshTimestamp(timestamp: string | number, windowMs = SIGNATURE_WINDOW_MS): boolean {
  const raw = typeof timestamp === "number" ? timestamp : Number(timestamp);
  if (!Number.isFinite(raw) || raw <= 0) return false;
  // 10 位数字视为秒级时间戳
  const ms = raw < 1e12 ? raw * 1000 : raw;
  return Math.abs(Date.now() - ms) <= windowMs;
}

/** 计算 sha256 签名 */
export function sha256Hex(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}
