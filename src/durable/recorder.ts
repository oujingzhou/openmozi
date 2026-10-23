/**
 * Turn recorder - 把 pi 的 AgentSessionEvent 序列翻译成 durable 记录
 *
 * 关键不变量：
 * 1. 用户输入先落盘（turn 记录），再触发模型调用。
 * 2. 工具调用在 execute 之前落盘 tool-intent，因此恢复时能知道"可能已经跑过"。
 * 3. 判定为 safe 重放的工具在恢复时会重新执行；unsafe 的只补写中断结果。
 */

import { randomUUID } from "crypto";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage, Usage } from "@mariozechner/pi-ai";
import type { DurableStore } from "./store.js";
import type { DurableLiveEvent, DurableRecord, DurableUsage, ReplayClass, TurnEndReason } from "./types.js";

/**
 * 流式中间态的落盘策略。
 * 中间态是为了"刷新后能接着看"，但每次写的是完整文本，
 * 频率过高会让日志体积随回复长度平方增长。
 * 这里同时限制时间间隔与新增字符数。
 */
const PARTIAL_FLUSH_INTERVAL_MS = 1000;
const PARTIAL_FLUSH_MIN_GROWTH = 200;

/** 流式增量推送给界面的间隔（与落盘解耦） */
const LIVE_PUSH_INTERVAL_MS = 40;

/** 可安全重放的只读工具 */
const SAFE_REPLAY_TOOLS = new Set([
  "read",
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
  "current_time",
  "calculator",
  "memory_search",
  "image_analyze",
]);

/** 判定工具副作用的等级 */
export function replayClassFor(toolName: string): ReplayClass {
  return SAFE_REPLAY_TOOLS.has(toolName.toLowerCase()) ? "safe" : "unsafe";
}

function toDurableUsage(usage: Usage | undefined): DurableUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.input,
    completionTokens: usage.output,
    totalTokens: usage.totalTokens,
  };
}

/** 从 assistant 消息中提取文本与思考内容 */
function extractContent(message: AssistantMessage): { text: string; thinking: string } {
  let text = "";
  let thinking = "";
  for (const block of message.content ?? []) {
    if (block.type === "text") text += block.text;
    else if (block.type === "thinking") thinking += block.thinking;
  }
  return { text, thinking };
}

/** 从工具流式增量中提取文本（pi 的 partialResult 是未定型结构，这里做边界校验） */
export function textFromPartialResult(value: unknown): string {
  if (!value || typeof value !== "object" || !("content" in value)) return "";
  const content = value.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const type = "type" in item ? item.type : undefined;
      const text = "text" in item ? item.text : undefined;
      return type === "text" && typeof text === "string" ? text : "";
    })
    .join("");
}

/** 从工具结果消息中取出内容数组（pi 的 result 为未定型结构，做边界校验） */
export function contentOfToolResult(value: unknown): Array<{ type: string; text?: string }> {
  if (!value || typeof value !== "object" || !("content" in value)) return [];
  const content = value.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(
    (item): item is { type: string; text?: string } =>
      Boolean(item) && typeof item === "object" && "type" in item
  );
}

function textFromToolResult(content: ToolResultMessage["content"] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.map((item) => (item.type === "text" ? item.text : `[${item.type}]`)).join("\n");
}

/** 一次回合的录制句柄 */
export interface TurnRecording {
  turnId: string;
  requestId: string;
  /** 结束回合；多次调用只有第一次生效 */
  finish(reason: TurnEndReason, error?: string): void;
}

/**
 * 回合记录器：维护单个会话内正在进行的回合状态，并把事件写成 durable 记录。
 * 一个 recorder 对应一个会话，串行使用。
 */
export class TurnRecorder {
  /** 初始为 -1，第一个 message_start 推进到 step-0 */
  private stepCounter = -1;
  private lastPartialFlush = 0;
  private lastPartialLength = 0;
  private lastLivePush = 0;
  private pendingLiveText = "";
  private pendingLiveThinking = "";
  private partialText = "";
  private partialThinking = "";
  private readonly toolStartedAt = new Map<string, number>();
  private activeTurnId: string | null = null;

  constructor(
    private readonly store: DurableStore,
    private readonly sessionKey: string
  ) {}

  /** 当前 step 标识 */
  get currentStepId(): string {
    return `step-${this.stepCounter}`;
  }

  private advanceStep(): void {
    this.stepCounter += 1;
    this.partialText = "";
    this.partialThinking = "";
    this.lastPartialFlush = 0;
    this.lastPartialLength = 0;
    this.pendingLiveText = "";
    this.pendingLiveThinking = "";
    if (!this.activeTurnId) return;
    this.store.publishLive(this.sessionKey, [
      { type: "step_start", turnId: this.activeTurnId, stepId: this.currentStepId },
    ]);
  }

  /** 开始一个回合：先写 turn 记录，这是恢复的锚点 */
  start(params: {
    content: string;
    source: string;
    requestId?: string;
    resumedFrom?: string;
  }): TurnRecording {
    const turnId = randomUUID();
    const requestId = params.requestId ?? turnId;

    this.stepCounter = -1;
    this.partialText = "";
    this.partialThinking = "";
    this.lastPartialFlush = 0;
    this.lastPartialLength = 0;
    this.toolStartedAt.clear();
    this.activeTurnId = turnId;

    this.store.append(
      this.sessionKey,
      [
        {
          kind: "turn",
          turnId,
          requestId,
          content: params.content,
          source: params.source,
          resumedFrom: params.resumedFrom,
        },
      ],
      [
        {
          type: "turn_start",
          turnId,
          requestId,
          createdAt: Date.now(),
          resumed: Boolean(params.resumedFrom),
          content: params.content,
        },
      ]
    );

    let finished = false;
    const store = this.store;
    const sessionKey = this.sessionKey;

    return {
      turnId,
      requestId,
      finish(reason: TurnEndReason, error?: string) {
        if (finished) return;
        finished = true;
        store.append(
          sessionKey,
          [{ kind: "turn-end", turnId, reason, error }],
          [{ type: "turn_end", turnId, reason, error }]
        );
      },
    };
  }

  /** 处理一个 pi 会话事件 */
  recordEvent(recording: TurnRecording, event: AgentSessionEvent): void {
    const turnId = recording.turnId;
    this.activeTurnId = turnId;
    const stepId = this.currentStepId;

    switch (event.type) {
      case "message_start": {
        // 每条新的 assistant 消息开启一个 step
        if (event.message.role === "assistant") this.advanceStep();
        return;
      }
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (!update) return;
        if (update.type === "text_delta") {
          this.partialText += update.delta;
          this.pendingLiveText += update.delta;
          this.flushPartial(turnId, this.currentStepId);
          this.flushLive(turnId, this.currentStepId);
        } else if (update.type === "thinking_delta") {
          this.partialThinking += update.delta;
          this.pendingLiveThinking += update.delta;
          this.flushPartial(turnId, this.currentStepId);
          this.flushLive(turnId, this.currentStepId);
        }
        return;
      }
      case "message_end": {
        if (event.message.role !== "assistant") return;
        const assistant = event.message as AssistantMessage;
        const { text, thinking } = extractContent(assistant);
        this.partialText = "";
        this.partialThinking = "";
        this.pendingLiveText = "";
        this.pendingLiveThinking = "";

        const records: DurableRecord[] = [
          {
            kind: "assistant",
            turnId,
            stepId,
            text,
            thinking: thinking || undefined,
            model: assistant.model,
            provider: assistant.provider,
            usage: toDurableUsage(assistant.usage),
            stopReason: assistant.stopReason,
          },
        ];
        const events: DurableLiveEvent[] = [
          { type: "assistant", turnId, stepId, text, thinking: thinking || undefined, partial: false },
        ];

        // 有工具调用时立刻写意图，崩溃后据此可知调用存在
        for (const block of assistant.content ?? []) {
          if (block.type !== "toolCall") continue;
          records.push({
            kind: "tool-intent",
            turnId,
            stepId,
            callId: block.id,
            name: block.name,
            args: block.arguments,
            replay: replayClassFor(block.name),
          });
          events.push({
            type: "tool_start",
            turnId,
            stepId,
            callId: block.id,
            name: block.name,
            args: block.arguments,
          });
        }

        this.store.append(this.sessionKey, records, events);
        return;
      }
      case "tool_execution_start": {
        this.toolStartedAt.set(event.toolCallId, Date.now());
        return;
      }
      case "tool_execution_update": {
        const text = textFromPartialResult(event.partialResult);
        if (text) {
          this.store.publishLive(this.sessionKey, [
            { type: "tool_update", turnId, callId: event.toolCallId, text },
          ]);
        }
        return;
      }
      case "tool_execution_end": {
        const startedAt = this.toolStartedAt.get(event.toolCallId);
        const durationMs = startedAt ? Date.now() - startedAt : undefined;
        this.toolStartedAt.delete(event.toolCallId);

        const text = contentOfToolResult(event.result)
          .map((item) => (item.type === "text" ? (item.text ?? "") : `[${item.type}]`))
          .join("\n");

        this.store.append(
          this.sessionKey,
          [
            {
              kind: "tool-result",
              turnId,
              stepId,
              callId: event.toolCallId,
              name: event.toolName,
              text,
              isError: event.isError,
              durationMs,
            },
          ],
          [
            {
              type: "tool_end",
              turnId,
              callId: event.toolCallId,
              isError: event.isError,
              text,
              durationMs,
            },
          ]
        );
        return;
      }
      default:
        return;
    }
  }

  /**
   * 推送流式增量。
   * 与落盘节流完全独立：界面按 ~40ms 更新，日志按 ~1s 写一次。
   */
  private flushLive(turnId: string, stepId: string): void {
    const now = Date.now();
    if (now - this.lastLivePush < LIVE_PUSH_INTERVAL_MS) return;
    this.lastLivePush = now;

    const events: DurableLiveEvent[] = [];
    if (this.pendingLiveText) {
      events.push({ type: "text_delta", turnId, stepId, delta: this.pendingLiveText });
      this.pendingLiveText = "";
    }
    if (this.pendingLiveThinking) {
      events.push({ type: "thinking_delta", turnId, stepId, delta: this.pendingLiveThinking });
      this.pendingLiveThinking = "";
    }
    if (events.length > 0) this.store.publishLive(this.sessionKey, events);
  }

  /** 节流落盘流式中间态，保证刷新后能恢复正在流式输出的内容 */
  private flushPartial(turnId: string, stepId: string): void {
    const now = Date.now();
    if (now - this.lastPartialFlush < PARTIAL_FLUSH_INTERVAL_MS) return;

    // 文本增长太少就不写：避免长回复把日志撑爆
    const growth = this.partialText.length + this.partialThinking.length - this.lastPartialLength;
    if (growth >= 0 && growth < PARTIAL_FLUSH_MIN_GROWTH) return;

    this.lastPartialFlush = now;
    this.lastPartialLength = this.partialText.length + this.partialThinking.length;

    const record: DurableRecord = {
      kind: "assistant",
      turnId,
      stepId,
      text: this.partialText,
      thinking: this.partialThinking || undefined,
      partial: true,
    };
    this.store.append(this.sessionKey, [record], [
      {
        type: "assistant",
        turnId,
        stepId,
        text: this.partialText,
        thinking: this.partialThinking || undefined,
        partial: true,
      },
    ]);
  }
}
