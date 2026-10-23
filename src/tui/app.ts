/**
 * 终端聊天界面
 *
 * 布局（自上而下）：
 *   标题栏 / 会话区 / 分隔线 / 输入区 / 状态栏
 *
 * 整个界面每帧整体重绘：对话不长，重绘比增量更新更不容易出错。
 */

import type { Agent } from "../agents/agent.js";
import type { InboundMessageContext, MoziConfig } from "../types/index.js";
import type { StreamEvent } from "../agents/runtime.js";
import {
  ANSI,
  displayWidth,
  getTerminalSize,
  moveTo,
  padToWidth,
  parseKey,
  truncateByWidth,
  wrapByWidth,
  type Key,
} from "./terminal.js";

/** 工具调用在界面上的形态 */
interface ToolView {
  callId: string;
  name: string;
  argsPreview: string;
  state: "running" | "done" | "error";
  text: string;
  durationMs?: number;
  startedAt: number;
}

/** 一条消息 */
interface MessageView {
  role: "user" | "assistant";
  text: string;
  thinking: string;
  tools: ToolView[];
  streaming: boolean;
  meta?: string;
}

/** 渲染用的带颜色行 */
interface StyledLine {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

const INPUT_ROWS = 3;
const RENDER_INTERVAL_MS = 33;
const MAX_HISTORY = 100;

export class TuiApp {
  private readonly config: MoziConfig;
  private readonly agent: Agent;
  private readonly sessionKey = "webchat:tui";

  private messages: MessageView[] = [];
  private input = "";
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private scrollOffset = 0;
  private running = false;
  private abortController: AbortController | null = null;
  private status = "";
  private lastMeta = "";
  private startedAt = 0;
  private renderTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(config: MoziConfig, agent: Agent) {
    this.config = config;
    this.agent = agent;
  }

  async start(): Promise<void> {
    this.applyInitialSnapshot();

    process.stdout.write(ANSI.enterAltScreen + ANSI.hideCursor);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    process.stdin.on("data", (chunk: string) => this.onData(chunk));
    process.stdout.on("resize", () => this.scheduleRender());

    this.render();
    await this.waitForExit();
  }

  // ---------- 生命周期 ----------

  /** 载入已有会话历史，让 TUI 也能接着上次继续 */
  private applyInitialSnapshot(): void {
    try {
      this.agent.openDurableSession(this.sessionKey);
      const snapshot = this.agent.getSnapshot(this.sessionKey);
      for (const turn of snapshot?.turns ?? []) {
        this.messages.push({
          role: "user",
          text: turn.content,
          thinking: "",
          tools: [],
          streaming: false,
        });
        const tools: ToolView[] = [];
        let text = "";
        let thinking = "";
        for (const step of turn.steps) {
          if (step.thinking) thinking += step.thinking;
          if (step.text) text += step.text;
          for (const tool of step.tools) {
            tools.push({
              callId: tool.callId,
              name: tool.name,
              argsPreview: this.previewArgs(tool.args),
              state: tool.state === "running" ? "done" : tool.state === "interrupted" ? "error" : tool.state,
              text: tool.text ?? "",
              durationMs: tool.durationMs,
              startedAt: Date.now(),
            });
          }
        }
        this.messages.push({
          role: "assistant",
          text,
          thinking,
          tools,
          streaming: false,
          meta: turn.reason === "interrupted" ? "已中断" : undefined,
        });
      }
      if (this.messages.length > 0) this.status = `已恢复 ${snapshot?.turns.length ?? 0} 个回合`;
    } catch {
      // 历史载入失败不影响新会话
    }
  }

  private waitForExit(): Promise<void> {
    return new Promise((resolve) => {
      this.onExit = resolve;
    });
  }

  private onExit: (() => void) | null = null;

  private quit(): void {
    if (this.disposed) return;
    this.disposed = true;
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(ANSI.showCursor + ANSI.exitAltScreen);
    this.onExit?.();
  }

  // ---------- 输入 ----------

  private onData(chunk: string): void {
    // 一次读取可能包含多个按键（粘贴），逐个处理
    for (const sequence of this.splitKeys(chunk)) {
      const key = parseKey(sequence);
      this.handleKey(key);
      if (this.disposed) return;
    }
    this.scheduleRender();
  }

  /** 把输入块切成按键序列（转义序列不可拆分） */
  private splitKeys(chunk: string): string[] {
    const keys: string[] = [];
    let index = 0;
    while (index < chunk.length) {
      if (chunk[index] === "\x1b") {
        const rest = chunk.slice(index);
        const match = /^\x1b\[[0-9;]*[~A-Za-z]/.exec(rest) ?? /^\x1bO[A-Za-z]/.exec(rest);
        if (match) {
          keys.push(match[0]);
          index += match[0].length;
          continue;
        }
        keys.push("\x1b");
        index += 1;
        continue;
      }
      // 代理对（emoji 等）
      const code = chunk.codePointAt(index) ?? 0;
      const char = String.fromCodePoint(code);
      keys.push(char);
      index += char.length;
    }
    return keys;
  }

  private handleKey(key: Key): void {
    switch (key.name) {
      case "ctrl":
        if (key.char === "c" || key.char === "d") {
          if (this.running) this.cancel();
          else this.quit();
          return;
        }
        if (key.char === "l") {
          // 只清屏，保留会话上下文
          this.messages = this.messages.slice(-0);
          this.scrollOffset = 0;
          return;
        }
        if (key.char === "n") {
          void this.newSession();
          return;
        }
        if (key.char === "j") {
          this.insertText("\n");
          return;
        }
        if (key.char === "u") {
          this.input = "";
          this.cursor = 0;
          return;
        }
        return;

      case "enter":
        if (this.running) return;
        void this.submit();
        return;

      case "newline":
        this.insertText("\n");
        return;

      case "escape":
        if (this.running) this.cancel();
        else {
          this.input = "";
          this.cursor = 0;
        }
        return;

      case "backspace":
        if (this.cursor > 0) {
          this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor);
          this.cursor -= 1;
        }
        return;

      case "delete":
        this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1);
        return;

      case "left":
        if (this.cursor > 0) this.cursor -= 1;
        return;

      case "right":
        if (this.cursor < this.input.length) this.cursor += 1;
        return;

      case "home":
        this.cursor = this.input.lastIndexOf("\n", this.cursor - 1) + 1;
        return;

      case "end": {
        const next = this.input.indexOf("\n", this.cursor);
        this.cursor = next === -1 ? this.input.length : next;
        return;
      }

      case "up":
        if (this.input.trim() === "" && this.history.length > 0) {
          // 输入为空时上下翻阅历史
          this.historyIndex = Math.min(this.history.length - 1, this.historyIndex + 1);
          this.input = this.history[this.history.length - 1 - this.historyIndex] ?? "";
          this.cursor = this.input.length;
        } else {
          this.scrollBy(1);
        }
        return;

      case "down":
        if (this.historyIndex >= 0) {
          this.historyIndex -= 1;
          this.input = this.historyIndex < 0 ? "" : (this.history[this.history.length - 1 - this.historyIndex] ?? "");
          this.cursor = this.input.length;
        } else {
          this.scrollBy(-1);
        }
        return;

      case "pageup":
        this.scrollBy(10);
        return;

      case "pagedown":
        this.scrollBy(-10);
        return;

      case "char":
        this.insertText(key.char);
        return;

      default:
        return;
    }
  }

  private insertText(text: string): void {
    this.input = this.input.slice(0, this.cursor) + text + this.input.slice(this.cursor);
    this.cursor += text.length;
  }

  private scrollBy(delta: number): void {
    const { rows } = getTerminalSize();
    const visible = Math.max(1, this.conversationHeight(rows));
    const total = this.buildConversationLines(getTerminalSize().columns - 2).length;
    const maxOffset = Math.max(0, total - visible);
    this.scrollOffset = Math.min(maxOffset, Math.max(0, this.scrollOffset + delta));
  }

  // ---------- 发送 ----------

  private async submit(): Promise<void> {
    const content = this.input.trim();
    if (!content) return;

    this.input = "";
    this.cursor = 0;
    this.historyIndex = -1;
    this.history.push(content);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.scrollOffset = 0;

    const userMessage: MessageView = {
      role: "user",
      text: content,
      thinking: "",
      tools: [],
      streaming: false,
    };
    const assistantMessage: MessageView = {
      role: "assistant",
      text: "",
      thinking: "",
      tools: [],
      streaming: true,
    };
    this.messages.push(userMessage, assistantMessage);

    const context: InboundMessageContext = {
      channelId: "webchat",
      chatId: "tui",
      messageId: `tui-${Date.now()}`,
      senderId: "tui",
      senderName: "TUI",
      content,
      chatType: "direct",
      timestamp: Date.now(),
    };

    const controller = new AbortController();
    this.abortController = controller;
    this.running = true;
    this.startedAt = Date.now();
    this.status = "正在生成…";
    this.scheduleRender();

    try {
      const stream = this.agent.processMessageEvents(context, {
        signal: controller.signal,
        requestId: controller.signal.aborted ? undefined : `tui-${this.startedAt}`,
        source: "tui",
      });

      for await (const event of stream) {
        this.applyStreamEvent(assistantMessage, event);
        this.scheduleRender();
      }

      assistantMessage.streaming = false;
      const elapsed = Date.now() - this.startedAt;
      this.lastMeta = `${(elapsed / 1000).toFixed(1)}s`;
      this.status = "";
    } catch (error) {
      assistantMessage.streaming = false;
      const aborted = controller.signal.aborted;
      if (!aborted) {
        assistantMessage.text += `\n\n${ANSI.fg.red}错误：${error instanceof Error ? error.message : String(error)}${ANSI.reset}`;
      }
      this.status = aborted ? "已取消" : "请求失败";
    } finally {
      this.running = false;
      this.abortController = null;
      this.scheduleRender();
    }
  }

  private applyStreamEvent(message: MessageView, event: StreamEvent): void {
    switch (event.type) {
      case "text_delta":
        message.text += event.delta;
        return;
      case "thinking_delta":
        message.thinking += event.delta;
        return;
      case "tool_start":
        message.tools.push({
          callId: event.callId,
          name: event.name,
          argsPreview: event.argsPreview,
          state: "running",
          text: "",
          startedAt: Date.now(),
        });
        return;
      case "tool_update": {
        const tool = message.tools.find((candidate) => candidate.callId === event.callId);
        if (tool) tool.text = event.text;
        return;
      }
      case "tool_end": {
        const tool = message.tools.find((candidate) => candidate.callId === event.callId);
        if (tool) {
          tool.state = event.isError ? "error" : "done";
          tool.text = event.text;
          tool.durationMs = Date.now() - tool.startedAt;
        }
        return;
      }
      case "turn_end":
        if (event.reason !== "completed") {
          message.meta = event.reason === "aborted" ? "已取消" : event.error || event.reason;
        }
        return;
      default:
        return;
    }
  }

  /** 开始新会话：清空上下文与界面 */
  private async newSession(): Promise<void> {
    if (this.running) this.cancel();
    try {
      await this.agent.clearSession({
        channelId: "webchat",
        chatId: "tui",
        messageId: `tui-reset-${Date.now()}`,
        senderId: "tui",
        senderName: "TUI",
        content: "",
        chatType: "direct",
        timestamp: Date.now(),
      });
      this.messages = [];
      this.scrollOffset = 0;
      this.lastMeta = "";
      this.status = "已开始新会话";
    } catch (error) {
      this.status = `新建会话失败：${error instanceof Error ? error.message : String(error)}`;
    }
    this.scheduleRender();
  }

  private cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  private previewArgs(args: unknown): string {
    if (!args || typeof args !== "object") return "";
    const record = args as Record<string, unknown>;
    for (const key of ["command", "path", "query", "pattern", "url"]) {
      const value = record[key];
      if (typeof value === "string") {
        return value.replace(/\s+/g, " ").slice(0, 60);
      }
    }
    return "";
  }

  // ---------- 渲染 ----------

  private scheduleRender(): void {
    if (this.renderTimer || this.disposed) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, RENDER_INTERVAL_MS);
  }

  private conversationHeight(rows: number): number {
    return Math.max(3, rows - 2 - INPUT_ROWS - 1);
  }

  private render(): void {
    if (this.disposed) return;
    const size = getTerminalSize();
    const width = size.columns;
    const conversationHeight = this.conversationHeight(size.rows);

    const lines: string[] = [];
    lines.push(this.renderHeader(width));

    const conversation = this.buildConversationLines(width - 2);
    const visible = this.sliceConversation(conversation, conversationHeight);
    for (let index = 0; index < conversationHeight; index += 1) {
      lines.push(this.paint(visible[index] ?? { text: "" }, width));
    }

    lines.push(this.paint({ text: "─".repeat(width), dim: true }, width));

    const inputLines = this.buildInputLines(width - 2);
    for (let index = 0; index < INPUT_ROWS; index += 1) {
      lines.push(this.paint(inputLines.lines[index] ?? { text: "" }, width));
    }

    lines.push(this.renderStatus(width));

    let frame = ANSI.hideCursor;
    lines.forEach((line, index) => {
      frame += moveTo(index + 1, 1) + ANSI.clearLine + line;
    });

    // 把光标放回输入位置
    const cursorRow = 1 + conversationHeight + 1 + 1 + inputLines.cursorRow;
    const cursorColumn = Math.min(width, inputLines.cursorColumn + 2);
    frame += moveTo(cursorRow, cursorColumn) + ANSI.showCursor;
    process.stdout.write(frame);
  }

  private renderHeader(width: number): string {
    const title = `${ANSI.bold}${ANSI.fg.white}墨子${ANSI.reset}`;
    const model = `${ANSI.dim}${this.config.agent.defaultModel}${ANSI.reset}`;
    const right = `${ANSI.dim}${this.running ? "运行中" : "就绪"}${ANSI.reset}`;
    const plainWidth =
      displayWidth("墨子") + 2 + displayWidth(this.config.agent.defaultModel) + displayWidth(this.running ? "运行中" : "就绪");
    const gap = Math.max(1, width - plainWidth - 2);
    return this.paint({ text: `${title}  ${model}${" ".repeat(gap)}${right}` }, width);
  }

  private renderStatus(width: number): string {
    const hints = this.running
      ? "Esc 取消 · Ctrl+C 退出"
      : "Enter 发送 · Ctrl+J 换行 · Ctrl+N 新会话 · ↑↓ 历史 · PgUp/PgDn 滚动 · Ctrl+C 退出";
    const left = `${ANSI.dim}${hints}${ANSI.reset}`;
    const right = `${ANSI.dim}${this.lastMeta}${ANSI.reset}`;
    const gap = Math.max(1, width - displayWidth(hints) - displayWidth(this.lastMeta) - 2);
    const status = this.status ? `  ${ANSI.fg.yellow}${this.status}${ANSI.reset}` : "";
    return this.paint({ text: `${left}${" ".repeat(gap)}${right}${status}` }, width);
  }

  /** 对话区渲染成带颜色的行 */
  private buildConversationLines(width: number): StyledLine[] {
    const lines: StyledLine[] = [];

    for (const message of this.messages) {
      const label =
        message.role === "user"
          ? `${ANSI.fg.cyan}${ANSI.bold}你${ANSI.reset}`
          : `${ANSI.fg.green}${ANSI.bold}墨子${ANSI.reset}`;
      const body = message.text || (message.streaming ? "" : "");

      const bodyLines = wrapByWidth(body, Math.max(10, width - 6));
      if (bodyLines.length === 0) bodyLines.push("");

      lines.push({ text: "" });
      bodyLines.forEach((line, index) => {
        const prefix = index === 0 ? `${label}  ` : "      ";
        lines.push({ text: prefix + line });
      });

      if (message.thinking) {
        const summary = truncateByWidth(message.thinking.replace(/\s+/g, " ").trim(), Math.max(10, width - 10));
        lines.push({ text: `      ${ANSI.dim}⋯ 思考：${summary}${ANSI.reset}`, dim: true });
      }

      for (const tool of message.tools) {
        const mark = tool.state === "running" ? "◐" : tool.state === "error" ? "✗" : "✓";
        const color = tool.state === "error" ? ANSI.fg.red : tool.state === "running" ? ANSI.fg.yellow : ANSI.fg.green;
        const duration = tool.durationMs ? ` ${(tool.durationMs / 1000).toFixed(1)}s` : "";
        const summary = truncateByWidth(
          `${tool.argsPreview}`,
          Math.max(10, width - 24 - tool.name.length - duration.length)
        );
        const text = `      ${color}${mark}${ANSI.reset} ${ANSI.bold}${tool.name}${ANSI.reset} ${ANSI.dim}${summary}${duration}${ANSI.reset}`;
        lines.push({ text });
      }

      if (message.streaming && message.text === "" && message.tools.length === 0) {
        lines.push({ text: `      ${ANSI.dim}正在生成…${ANSI.reset}`, dim: true });
      }

      if (message.meta) {
        lines.push({ text: `      ${ANSI.fg.yellow}${message.meta}${ANSI.reset}` });
      }
    }

    if (this.messages.length === 0) {
      lines.push({ text: "" });
      lines.push({ text: `  ${ANSI.bold}开始一个新的对话${ANSI.reset}` });
      lines.push({ text: `  ${ANSI.dim}回合与工具调用会写入持久日志，重启后可继续。${ANSI.reset}` });
      lines.push({ text: "" });
      lines.push({ text: `  ${ANSI.dim}例如：帮我看看这个仓库的结构${ANSI.reset}` });
    }

    return lines;
  }

  private sliceConversation(lines: StyledLine[], height: number): StyledLine[] {
    const start = Math.max(0, lines.length - height - this.scrollOffset);
    return lines.slice(start, start + height);
  }

  private buildInputLines(width: number): { lines: StyledLine[]; cursorRow: number; cursorColumn: number } {
    const prompt = "› ";
    const available = Math.max(10, width - prompt.length);
    const beforeCursor = wrapByWidth(this.input.slice(0, this.cursor), available);
    const all = wrapByWidth(this.input, available);
    const cursorLine = beforeCursor.length - 1;
    const cursorColumn = displayWidth(beforeCursor[cursorLine] ?? "");

    // 只显示包含光标的最后 INPUT_ROWS 行
    const offset = Math.max(0, all.length - INPUT_ROWS);
    const visible = all.slice(offset, offset + INPUT_ROWS);

    return {
      lines: visible.map((line, index) => ({
        text: `${index === 0 && offset === 0 ? prompt : "  "}${line}`,
      })),
      cursorRow: Math.max(0, cursorLine - offset),
      cursorColumn: cursorColumn + prompt.length,
    };
  }

  /** 补齐宽度并输出 */
  private paint(line: StyledLine, width: number): string {
    const padding = Math.max(0, width - displayWidth(stripAnsi(line.text)));
    return line.text + " ".repeat(padding);
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}
