/**
 * 持久化原语的回归测试
 *
 * 锁死两条曾在真实使用中造成数据丢失的行为：
 * 1. 会话索引损坏时不能用空表覆盖历史（优先从 .bak 恢复，否则拒绝写入）
 * 2. JSON5 序列化必须能原样往返（换行/引号/反斜杠）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import json5 from "json5";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { atomicWriteJson, readJsonFile, serializeJson5, JsonlAppender } from "../src/storage/index.js";
import { FileSessionStore } from "../src/sessions/store.js";

describe("storage primitives", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-storage-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips JSON5 values that contain control characters", () => {
    const value = {
      prompt: "第一行\n第二行\t带制表符",
      quoted: '他说 "你好"',
      backslash: "C:\\temp\\x",
      nested: { list: [1, "a\nb"] },
    };

    const text = serializeJson5(value);
    expect(json5.parse(text)).toEqual(value);
  });

  it("writes JSON atomically and reads it back", () => {
    const file = path.join(dir, "data.json");
    atomicWriteJson(file, { a: 1, b: ["x"] });

    expect(readJsonFile<{ a: number }>(file)).toEqual({ a: 1, b: ["x"] });
    // 不留下临时文件
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("appends JSONL records and reports corrupt lines", () => {
    const file = path.join(dir, "log.jsonl");
    const appender = new JsonlAppender(file, { fsync: false });
    appender.append([{ n: 1 }, { n: 2 }]);

    fs.appendFileSync(file, "{ broken\n");

    const parsed = appender.readAll<{ n: number }>();
    expect(parsed.records.map((r) => r.n)).toEqual([1, 2]);
    expect(parsed.corruptLines).toBe(1);
  });
});

describe("session index durability", () => {
  let dir: string;
  let indexPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-index-"));
    indexPath = path.join(dir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("recovers history from .bak when the index is corrupt", async () => {
    const store = new FileSessionStore(dir);
    await store.getOrCreate("webchat:a");
    await store.getOrCreate("webchat:b");

    const good = fs.readFileSync(indexPath, "utf-8");
    fs.writeFileSync(`${indexPath}.bak`, good, "utf-8");
    fs.writeFileSync(indexPath, "{ corrupt", "utf-8");

    // 新实例模拟进程重启
    const reopened = new FileSessionStore(dir);
    const keys = (await reopened.list()).map((s) => s.sessionKey).sort();
    expect(keys).toEqual(["webchat:a", "webchat:b"]);

    // 恢复后仍可正常写入
    await reopened.getOrCreate("webchat:c");
    expect(Object.keys(JSON.parse(fs.readFileSync(indexPath, "utf-8")))).toHaveLength(3);
  });

  it("refuses to write when neither the index nor its backup is readable", async () => {
    const store = new FileSessionStore(dir);
    await store.getOrCreate("webchat:a");

    fs.writeFileSync(indexPath, "{ corrupt", "utf-8");
    fs.rmSync(`${indexPath}.bak`, { force: true });

    const reopened = new FileSessionStore(dir);
    await expect(reopened.getOrCreate("webchat:b")).rejects.toThrow(/损坏/);
    // 损坏文件原样保留，便于人工修复
    expect(fs.readFileSync(indexPath, "utf-8")).toBe("{ corrupt");
  });
});
