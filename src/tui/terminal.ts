/**
 * 终端基础能力
 *
 * 只做三件事：读写屏幕、解析按键、按显示宽度折行。
 * 不依赖任何 TUI 库，保持 mozi 的单包结构。
 */

/** 显示宽度（中日韩全角字符按 2 列计算） */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x2600 && code <= 0x27bf) ||
    (code >= 0x1f000 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/**
 * 按显示宽度截断。
 * 省略号本身占 1 列，所以内容最多填充 maxWidth - 1 列，
 * 保证返回值的显示宽度不超过 maxWidth。
 */
export function truncateByWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (displayWidth(text) <= maxWidth) return text;

  let width = 0;
  let result = "";
  for (const char of text) {
    const charWidth = isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
    if (width + charWidth > maxWidth - 1) break;
    width += charWidth;
    result += char;
  }
  return result + "…";
}

/** 按显示宽度右侧补空格 */
export function padToWidth(text: string, maxWidth: number): string {
  const width = displayWidth(text);
  if (width >= maxWidth) return truncateByWidth(text, maxWidth);
  return text + " ".repeat(maxWidth - width);
}

/** 按显示宽度折行 */
export function wrapByWidth(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    let width = 0;
    for (const char of paragraph) {
      const charWidth = isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
      if (width + charWidth > maxWidth) {
        lines.push(current);
        current = char;
        width = charWidth;
      } else {
        current += char;
        width += charWidth;
      }
    }
    lines.push(current);
  }

  return lines;
}

/** 光标移动到指定行列（1-based） */
export function moveTo(row: number, column: number): string {
  return `\x1b[${row};${column}H`;
}

export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  reverse: "\x1b[7m",
  clearLine: "\x1b[2K",
  clearScreen: "\x1b[2J",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  enterAltScreen: "\x1b[?1049h",
  exitAltScreen: "\x1b[?1049l",
  fg: {
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    gray: "\x1b[90m",
    white: "\x1b[97m",
  },
} as const;

/** 按键 */
export type Key =
  | { name: "char"; char: string }
  | { name: "enter" }
  | { name: "newline" }
  | { name: "backspace" }
  | { name: "delete" }
  | { name: "left" }
  | { name: "right" }
  | { name: "up" }
  | { name: "down" }
  | { name: "home" }
  | { name: "end" }
  | { name: "pageup" }
  | { name: "pagedown" }
  | { name: "escape" }
  | { name: "tab" }
  | { name: "ctrl"; char: string }
  | { name: "unknown"; sequence: string };

/** 解析一次按键序列 */
export function parseKey(sequence: string): Key {
  switch (sequence) {
    case "\r":
      return { name: "enter" };
    case "\n":
      return { name: "newline" };
    case "\x7f":
    case "\b":
      return { name: "backspace" };
    case "\x1b":
      return { name: "escape" };
    case "\t":
      return { name: "tab" };
    case "\x1b[A":
      return { name: "up" };
    case "\x1b[B":
      return { name: "down" };
    case "\x1b[C":
      return { name: "right" };
    case "\x1b[D":
      return { name: "left" };
    case "\x1b[H":
    case "\x1b[1~":
      return { name: "home" };
    case "\x1b[F":
    case "\x1b[4~":
      return { name: "end" };
    case "\x1b[3~":
      return { name: "delete" };
    case "\x1b[5~":
      return { name: "pageup" };
    case "\x1b[6~":
      return { name: "pagedown" };
    default:
      break;
  }

  // Ctrl+字母
  if (sequence.length === 1) {
    const code = sequence.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      return { name: "ctrl", char: String.fromCharCode(code + 96) };
    }
    if (code >= 32) return { name: "char", char: sequence };
  }

  return { name: "unknown", sequence };
}

/** 终端尺寸 */
export interface TerminalSize {
  columns: number;
  rows: number;
}

export function getTerminalSize(): TerminalSize {
  return {
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  };
}
