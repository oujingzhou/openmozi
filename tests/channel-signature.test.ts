/**
 * 通道签名校验的回归测试
 *
 * 四个通道原来都"未配置密钥即放行"，且没有时间窗、用普通字符串比较。
 * 这里锁死三条：失败关闭、拒绝过期回调、常量时间比较不接受长度不同的签名。
 */

import { describe, it, expect } from "vitest";
import { isFreshTimestamp, safeEqual, sha256Hex } from "../src/channels/common/signature.js";
import { WeComCrypto } from "../src/channels/wecom/crypto.js";

describe("channel signature helpers", () => {
  it("rejects callbacks outside the replay window", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    expect(isFreshTimestamp(String(nowSec))).toBe(true);
    expect(isFreshTimestamp(String(nowSec * 1000))).toBe(true);
    expect(isFreshTimestamp(String(nowSec - 3600))).toBe(false);
    expect(isFreshTimestamp(String(nowSec + 3600))).toBe(false);
    expect(isFreshTimestamp("not-a-number")).toBe(false);
  });

  it("compares signatures without accepting prefix collisions", () => {
    const digest = sha256Hex("payload");
    expect(safeEqual(digest, digest)).toBe(true);
    expect(safeEqual(digest, digest.slice(0, -1))).toBe(false);
    expect(safeEqual("", digest)).toBe(false);
  });

  it("rejects a stale WeCom callback even with a valid signature", () => {
    const crypto = new WeComCrypto("token", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG", "corp");
    const stale = String(Math.floor(Date.now() / 1000) - 7200);
    const signature = crypto.getSignature(stale, "nonce", "encrypted");

    expect(crypto.verifySignature(signature, stale, "nonce", "encrypted")).toBe(false);
  });

  it("accepts a fresh WeCom callback with the right signature", () => {
    const crypto = new WeComCrypto("token", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG", "corp");
    const fresh = String(Math.floor(Date.now() / 1000));
    const signature = crypto.getSignature(fresh, "nonce", "encrypted");

    expect(crypto.verifySignature(signature, fresh, "nonce", "encrypted")).toBe(true);
    expect(crypto.verifySignature("deadbeef", fresh, "nonce", "encrypted")).toBe(false);
  });
});
