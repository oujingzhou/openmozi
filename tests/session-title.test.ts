/**
 * 会话标题：兜底逻辑
 *
 * 摘要调用依赖模型，这里只测不依赖网络的纯函数部分，
 * 保证侧边栏在任何情况下都不会出现空标题。
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { fallbackTitle } from "../src/sessions/title.js";

describe("sessions/title", () => {
  it("uses the first message as-is when short", () => {
    expect(fallbackTitle("你好")).toBe("你好");
    expect(fallbackTitle("帮我写一个 LRU 缓存")).toBe("帮我写一个 LRU 缓存");
  });

  it("collapses whitespace and newlines", () => {
    expect(fallbackTitle("第一行\n\n第二行   结束")).toBe("第一行 第二行 结束");
  });

  it("truncates long messages with an ellipsis", () => {
    const title = fallbackTitle("这是一条非常长的用户消息".repeat(5));
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(25);
  });

  it("never returns an empty title", () => {
    expect(fallbackTitle("")).toBe("新会话");
    expect(fallbackTitle("    ")).toBe("新会话");
  });
});
