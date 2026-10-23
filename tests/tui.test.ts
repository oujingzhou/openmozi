/**
 * 终端渲染与按键解析
 *
 * 这些函数决定 TUI 的换行与光标位置；CJK 宽度算错会让界面错位，
 * 所以用全角字符做边界覆盖。
 */

import { describe, it, expect } from "vitest";
import {
  displayWidth,
  padToWidth,
  parseKey,
  truncateByWidth,
  wrapByWidth,
} from "../src/tui/terminal.js";

describe("tui/terminal display width", () => {
  it("counts ASCII as one column", () => {
    expect(displayWidth("hello")).toBe(5);
    expect(displayWidth("")).toBe(0);
  });

  it("counts CJK as two columns", () => {
    expect(displayWidth("墨子")).toBe(4);
    expect(displayWidth("你好，世界")).toBe(10);
    expect(displayWidth("a墨b")).toBe(4);
  });

  it("counts emoji as two columns", () => {
    expect(displayWidth("🚀")).toBe(2);
  });
});

describe("tui/terminal wrapping", () => {
  it("wraps ASCII by column budget", () => {
    expect(wrapByWidth("abcdefgh", 4)).toEqual(["abcd", "efgh"]);
  });

  it("never splits a wide character across lines", () => {
    // 宽度 4 只能放下两个全角字符
    expect(wrapByWidth("墨子墨子", 4)).toEqual(["墨子", "墨子"]);
    // 宽度 5 时第二个"墨"放不下，应换行而不是被切断
    expect(wrapByWidth("墨子墨子", 5)).toEqual(["墨子", "墨子"]);
  });

  it("preserves explicit newlines and blank lines", () => {
    expect(wrapByWidth("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });

  it("truncates with an ellipsis at the column budget", () => {
    expect(truncateByWidth("abcdef", 4)).toBe("abc…");
    expect(truncateByWidth("abc", 10)).toBe("abc");
    // 省略号占 1 列，全角字符只能容纳 1 个
    expect(truncateByWidth("墨子墨子", 4)).toBe("墨…");
    expect(displayWidth(truncateByWidth("墨子墨子", 4))).toBeLessThanOrEqual(4);
  });

  it("pads to the requested column width", () => {
    expect(padToWidth("墨子", 6)).toBe("墨子  ");
    expect(displayWidth(padToWidth("墨子", 6))).toBe(6);
  });
});

describe("tui/terminal keys", () => {
  it("maps editing keys", () => {
    expect(parseKey("\r")).toEqual({ name: "enter" });
    expect(parseKey("\n")).toEqual({ name: "newline" });
    expect(parseKey("\x7f")).toEqual({ name: "backspace" });
    expect(parseKey("\x1b")).toEqual({ name: "escape" });
    expect(parseKey("\t")).toEqual({ name: "tab" });
  });

  it("maps arrow and navigation sequences", () => {
    expect(parseKey("\x1b[A")).toEqual({ name: "up" });
    expect(parseKey("\x1b[B")).toEqual({ name: "down" });
    expect(parseKey("\x1b[C")).toEqual({ name: "right" });
    expect(parseKey("\x1b[D")).toEqual({ name: "left" });
    expect(parseKey("\x1b[3~")).toEqual({ name: "delete" });
    expect(parseKey("\x1b[5~")).toEqual({ name: "pageup" });
    expect(parseKey("\x1b[6~")).toEqual({ name: "pagedown" });
    expect(parseKey("\x1b[H")).toEqual({ name: "home" });
    expect(parseKey("\x1b[F")).toEqual({ name: "end" });
  });

  it("maps control keys to their letter", () => {
    expect(parseKey("\x03")).toEqual({ name: "ctrl", char: "c" });
    expect(parseKey("\x0e")).toEqual({ name: "ctrl", char: "n" });
    expect(parseKey("\x0a")).toEqual({ name: "newline" });
  });

  it("passes printable characters through", () => {
    expect(parseKey("a")).toEqual({ name: "char", char: "a" });
    expect(parseKey("墨")).toEqual({ name: "char", char: "墨" });
  });

  it("reports unknown escape sequences instead of guessing", () => {
    expect(parseKey("\x1b[99~")).toEqual({ name: "unknown", sequence: "\x1b[99~" });
  });
});
