/**
 * Agent Runtime - 基于 pi-coding-agent 的会话管理
 *
 * 在 pi 的 AgentSession 之上叠加 durable execution：
 * - 每个会话一个追加日志（~/.mozi/sessions/<key>.jsonl），回合、step、
 *   工具意图与结果都落盘，进程崩溃后可恢复。
 * - 启动时把"已开始未结束"的回合与工具调用补写为 interrupted，
 *   同时修补 pi 自己的会话文件，避免下一次 prompt 面对悬空的 tool_call。
 * - 提交按 requestId 幂等，重试不会产生第二个回合。
 */

import { join } from "path";
import { randomUUID } from "crypto";
import * as os from "os";
import * as fs from "fs";
import {
  createAgentSession,
  AgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  type ToolDefinition,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import type { AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { MoziConfig, ProviderId, InboundMessageContext } from "../types/index.js";
import { resolveModel, initModelResolver, getApiKeyForProvider } from "../providers/model-resolver.js";
import { getChildLogger } from "../utils/logger.js";
import { delay } from "../utils/index.js";
import { buildSystemPrompt } from "./system-prompt.js";
import type { SkillsRegistry } from "../skills/index.js";
import type { MemoryManager } from "../memory/index.js";
import type { CronService } from "../cron/service.js";
import {
  DurableStore,
  TurnRecorder,
  textFromPartialResult,
  contentOfToolResult,
  type DurableSessionSnapshot,
  type RecoveryReport,
  type TurnRecording,
} from "../durable/index.js";

const logger = getChildLogger("runtime");

/** Runtime 配置 */
export interface RuntimeConfig {
  model: string;
  provider: ProviderId;
  systemPrompt?: string;
  maxTokens?: number;
  workingDirectory?: string;
  sessionDir?: string;
  memoryManager?: MemoryManager;
  cronService?: CronService;
  /** 是否每批日志 fsync，默认 true */
  durableFsync?: boolean;
  /** 单回合最大工具轮数，超过后中止，默认 64 */
  maxToolRounds?: number;
  /** 思考深度，默认 medium */
  thinkingLevel?: ThinkingLevel;
}

/** Chat 响应 */
export interface ChatResponse {
  content: string;
  provider: ProviderId;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** durable 回合 ID */
  turnId?: string;
}

/** Stream 事件 */
export type StreamEvent =
  | { type: "turn_start"; turnId: string; requestId: string; resumed: boolean }
  | { type: "step_start"; stepId: string }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; callId: string; name: string; argsPreview: string }
  | { type: "tool_update"; callId: string; text: string }
  | { type: "tool_end"; callId: string; name: string; isError: boolean; text: string }
  | { type: "turn_end"; turnId: string; reason: string; error?: string };

/** 流式聊天选项 */
export interface ChatOptions {
  signal?: AbortSignal;
  /** 幂等键：同一会话内重复提交返回已有回合 */
  requestId?: string;
  /** 来源标识，写入日志 */
  source?: string;
  /** 内部使用：直接指定会话，跳过多渠道推导（队列执行用） */
  sessionKeyOverride?: string;
}

/** 消息上下文 -> 稳定的会话 key */
export function sessionKeyFor(context: InboundMessageContext): string {
  if (context.chatType === "group") {
    return `${context.channelId}:${context.chatId}`;
  }
  return `${context.channelId}:${context.senderId}`;
}

/** 会话 key -> 安全文件名 */
function safeFileName(sessionKey: string): string {
  return sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * AgentRuntime - 管理 AgentSession 实例与它们的 durable 日志
 */
export class AgentRuntime {
  private sessions = new Map<string, AgentSession>();
  private recorders = new Map<string, TurnRecorder>();
  private config: RuntimeConfig;
  private sessionDir: string;
  private skillsRegistry: SkillsRegistry | null = null;
  private customTools: AgentTool[] = [];
  /** 恢复报告，按 sessionKey 索引 */
  private recoveries = new Map<string, RecoveryReport>();
  /** 正在跑回合的会话 */
  private running = new Set<string>();
  /** 正在排空队列的会话，避免递归 */
  private draining = new Set<string>();
  /** 因 steer 而主动中断的会话（回合应记为 aborted） */
  private steered = new Set<string>();
  private readonly maxToolRounds: number;
  readonly durable: DurableStore;

  constructor(config: RuntimeConfig) {
    this.config = config;
    this.sessionDir = config.sessionDir ?? join(os.homedir(), ".mozi", "sessions");
    this.maxToolRounds = config.maxToolRounds ?? 64;
    // 日志与 pi 的会话文件必须分开：两者都叫 <key>.jsonl，同目录会互相覆盖
    this.durable = new DurableStore({
      directory: join(this.sessionDir, "journal"),
      fsync: config.durableFsync ?? true,
    });

    logger.info({ sessionDir: this.sessionDir }, "AgentRuntime initialized");
  }

  /** 设置 SkillsRegistry */
  setSkillsRegistry(registry: SkillsRegistry): void {
    this.skillsRegistry = registry;
  }

  /** 注册自定义工具 */
  registerCustomTool(tool: AgentTool): void {
    this.customTools.push(tool);
  }

  /** 获取或创建（并恢复）会话 */
  private async getOrCreateSession(sessionKey: string): Promise<AgentSession> {
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;

    const model = resolveModel(this.config.provider, this.config.model);
    if (!model) {
      throw new Error(`Cannot resolve model: ${this.config.provider}/${this.config.model}`);
    }

    const cwd = this.config.workingDirectory ?? process.cwd();

    // 关键修复：SessionManager.create(cwd, sessionDir) 的第二个参数是目录，
    // 不是文件。之前直接传 .jsonl 路径导致 pi 把文件名当目录创建。
    const sessionManager = SessionManager.create(cwd, this.sessionDir);
    const sessionFile = join(this.sessionDir, `${safeFileName(sessionKey)}.jsonl`);
    sessionManager.setSessionFile(sessionFile);

    // 打开 durable 日志并完成崩溃恢复
    const { recovery } = this.durable.open(sessionKey, cwd);
    this.recoveries.set(sessionKey, recovery);

    // 修补 pi 会话文件里悬空的工具调用（崩溃恢复的关键一环）
    this.repairOrphanToolCalls(sessionManager, recovery);

    const authStorage = AuthStorage.inMemory();
    const modelProvider = model.provider;
    const apiKey = getApiKeyForProvider(this.config.provider);
    if (apiKey) {
      authStorage.set(this.config.provider, { type: "api_key", key: apiKey });
      if (modelProvider !== this.config.provider) {
        authStorage.set(modelProvider, { type: "api_key", key: apiKey });
      }
    }

    authStorage.setFallbackResolver((provider: string) => {
      let key = getApiKeyForProvider(provider);
      if (!key && provider === modelProvider) {
        key = getApiKeyForProvider(this.config.provider);
      }
      return key;
    });

    const modelRegistry = new ModelRegistry(authStorage);

    const customToolDefinitions: ToolDefinition[] = this.customTools.map((tool) => ({
      name: tool.name,
      label: tool.label ?? tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: tool.execute,
    }));

    const { session: newSession } = await createAgentSession({
      cwd,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: this.config.thinkingLevel ?? ("medium" as ThinkingLevel),
      sessionManager,
      customTools: customToolDefinitions,
      tools: [],
    });

    const systemPromptText = this.buildSystemPromptText();
    newSession.agent.setSystemPrompt(systemPromptText);
    if (this.customTools.length > 0) {
      newSession.agent.setTools(this.customTools);
    }

    // 兼容性修补：pi-ai 在 tools 为空数组时仍会发送 "tools": []，
    // 部分 OpenAI 兼容端点（如 stepcloud）会直接 400 拒绝。
    // 这里在调用前把空数组去掉，语义上等价于"没有工具"。
    const originalStreamFn = newSession.agent.streamFn;
    newSession.agent.streamFn = (model, context, streamOptions) => {
      const tools = context?.tools;
      const normalized =
        Array.isArray(tools) && tools.length === 0
          ? { ...context, tools: undefined }
          : context;

      // AgentSession 在每轮开始时会把系统提示重置为它自己的基础提示，
      // 这里在真正发请求前固定成 mozi 的人格设定。
      const nextOptions = this.config.maxTokens
        ? { ...streamOptions, maxTokens: this.config.maxTokens }
        : streamOptions;
      return originalStreamFn(model, { ...normalized, systemPrompt: systemPromptText }, nextOptions);
    };

    this.sessions.set(sessionKey, newSession);
    this.recorders.set(sessionKey, new TurnRecorder(this.durable, sessionKey));

    // 进程重启后，日志里可能还有未执行的排队消息
    if (this.durable.snapshot(sessionKey).queued.length > 0) {
      void this.drainQueue(sessionKey);
    }
    logger.debug({ sessionKey, sessionFile, hasHistory: sessionManager.getEntries().length > 0 }, "Session opened");

    return newSession;
  }

  /**
   * 修复 pi 会话中悬空的工具调用。
   *
   * 崩溃可能发生在"assistant 发出 toolCall"与"toolResult 落盘"之间。
   * 若不补写结果，下一次 prompt 的上下文就是非法序列，多数 OpenAI 兼容
   * 接口会直接报错。这里为缺失结果的调用补写一条中断说明。
   */
  private repairOrphanToolCalls(sessionManager: SessionManager, recovery: RecoveryReport): void {
    const entries = sessionManager.getEntries();

    // 找到最后一个 assistant 消息，收集它之后出现的 toolResult
    let lastAssistantIndex = -1;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.type === "message" && entry.message.role === "assistant") {
        lastAssistantIndex = index;
        break;
      }
    }
    if (lastAssistantIndex === -1) return;

    const lastAssistant = entries[lastAssistantIndex];
    if (lastAssistant?.type !== "message") return;
    const message = lastAssistant.message as AssistantMessage;
    const toolCalls = (message.content ?? []).filter((block) => block.type === "toolCall");
    if (toolCalls.length === 0) return;

    const answered = new Set<string>();
    for (let index = lastAssistantIndex + 1; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry?.type === "message" && entry.message.role === "toolResult") {
        answered.add((entry.message as ToolResultMessage).toolCallId);
      }
    }

    let repaired = 0;
    for (const call of toolCalls) {
      if (answered.has(call.id)) continue;
      const result: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [
          {
            type: "text",
            text: `Tool ${call.name} was interrupted by a restart before producing a result. It may have partially executed.`,
          },
        ],
        isError: true,
        timestamp: Date.now(),
      };
      sessionManager.appendMessage(result);
      repaired += 1;
    }

    if (repaired > 0) {
      logger.warn(
        { repaired, sessionKey: sessionManager.getSessionId(), interruptedTurns: recovery.interruptedTurns },
        "Repaired orphan tool calls in pi session"
      );
    }
  }

  /** 构建系统提示 */
  private buildSystemPromptText(): string {
    return buildSystemPrompt({
      basePrompt: this.config.systemPrompt,
      workingDirectory: this.config.workingDirectory,
      includeEnvironment: true,
      includeDateTime: true,
      includeToolRules: false,
      skillsPrompt: this.skillsRegistry?.buildPrompt(),
      enableMemory: !!this.config.memoryManager,
    });
  }

  /** 工具参数的简短预览 */
  private getArgsPreview(args: Record<string, unknown> | undefined): string {
    if (!args) return "";
    const mainArg = args.path ?? args.directory ?? args.command ?? args.query ?? args.pattern;
    if (typeof mainArg !== "string") return "";
    const preview = mainArg.replace(/\n/g, " ").trim();
    return preview.length > 60 ? preview.slice(0, 60) + "…" : preview;
  }

  /** 查询某个 requestId 是否已有完成的回合 */
  private findCompletedTurn(sessionKey: string, requestId: string) {
    if (!this.durable.has(sessionKey)) return null;
    const snapshot = this.durable.snapshot(sessionKey);
    const turn = snapshot.turns.find((candidate) => candidate.requestId === requestId);
    if (!turn || turn.running) return null;
    return turn;
  }

  /** 从回合投影中取出最终文本 */
  private static textFromTurn(turn: { steps: Array<{ text: string }> }): string {
    return turn.steps.map((step) => step.text).filter(Boolean).join("\n\n");
  }

  /** 非流式聊天 */
  async chat(context: InboundMessageContext, options: ChatOptions = {}): Promise<ChatResponse> {
    const sessionKey = sessionKeyFor(context);

    // 幂等：重试已完成的 requestId 直接返回既有结果
    if (options.requestId) {
      const existing = this.findCompletedTurn(sessionKey, options.requestId);
      if (existing) {
        logger.debug({ sessionKey, requestId: options.requestId }, "Returning durable result for duplicate request");
        return {
          content: AgentRuntime.textFromTurn(existing),
          provider: (existing.provider as ProviderId) ?? this.config.provider,
          model: existing.model ?? this.config.model,
          usage: existing.usage,
          turnId: existing.turnId,
        };
      }
    }

    const session = await this.getOrCreateSession(sessionKey);
    const recorder = this.recorders.get(sessionKey)!;

    const recording = recorder.start({
      content: context.content,
      source: options.source ?? context.channelId,
      requestId: options.requestId,
    });

    let rounds = 0;
    let runaway = false;
    const unsubscribe = session.subscribe((event) => {
      recorder.recordEvent(recording, event);
      if (event.type === "tool_execution_end") {
        rounds += 1;
        // 工具持续失败时模型可能无限重试，这里兜底中止
        if (rounds >= this.maxToolRounds) {
          runaway = true;
          session.agent.abort();
        }
      }
    });

    try {
      await session.prompt(context.content);
      await session.agent.waitForIdle();

      if (runaway) {
        const message = `工具调用超过 ${this.maxToolRounds} 轮，已中止本回合`;
        recording.finish("aborted", message);
        throw new Error(message);
      }

      const failure = AgentRuntime.modelFailure(session.messages);
      if (failure) {
        recording.finish("error", failure);
        throw new Error(failure);
      }
      recording.finish("completed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 带上堆栈，便于定位 pi 内部抛出的错误
      logger.error({ error, sessionKey, turnId: recording.turnId }, "Turn failed");
      recording.finish(options.signal?.aborted ? "aborted" : "error", message);
      throw error;
    } finally {
      unsubscribe();
    }

    const stats = session.getSessionStats();
    return {
      content: session.getLastAssistantText() ?? "",
      provider: this.config.provider,
      model: this.config.model,
      usage: {
        promptTokens: stats.tokens.input,
        completionTokens: stats.tokens.output,
        totalTokens: stats.tokens.total,
      },
      turnId: recording.turnId,
    };
  }

  /**
   * 模型返回 stopReason=error 时，pi 不会抛异常（错误写在消息里）。
   * 必须把它转成真实的失败，否则日志与 UI 都会把失败当成成功。
   */
  private static modelFailure(messages: ReadonlyArray<unknown>): string | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || typeof message !== "object" || !("role" in message)) continue;
      if (message.role !== "assistant") continue;
      const assistant = message as AssistantMessage;
      if (assistant.stopReason !== "error") return null;
      return assistant.errorMessage || "模型返回错误，但没有提供错误信息";
    }
    return null;
  }

  /** 流式聊天 */
  async *chatStream(
    context: InboundMessageContext,
    options: ChatOptions = {}
  ): AsyncGenerator<StreamEvent, ChatResponse, unknown> {
    const sessionKey = options.sessionKeyOverride ?? sessionKeyFor(context);

    if (options.requestId) {
      const existing = this.findCompletedTurn(sessionKey, options.requestId);
      if (existing) {
        yield { type: "turn_start", turnId: existing.turnId, requestId: existing.requestId, resumed: true };
        for (const step of existing.steps) {
          yield { type: "step_start", stepId: step.stepId };
          if (step.thinking) yield { type: "thinking_delta", delta: step.thinking };
          if (step.text) yield { type: "text_delta", delta: step.text };
          for (const tool of step.tools) {
            yield {
              type: "tool_start",
              callId: tool.callId,
              name: tool.name,
              argsPreview: this.getArgsPreview(tool.args as Record<string, unknown> | undefined),
            };
            yield { type: "tool_end", callId: tool.callId, name: tool.name, isError: Boolean(tool.isError), text: tool.text ?? "" };
          }
        }
        yield { type: "turn_end", turnId: existing.turnId, reason: existing.reason ?? "completed" };
        return {
          content: AgentRuntime.textFromTurn(existing),
          provider: (existing.provider as ProviderId) ?? this.config.provider,
          model: existing.model ?? this.config.model,
          usage: existing.usage,
          turnId: existing.turnId,
        };
      }
    }

    const session = await this.getOrCreateSession(sessionKey);
    const recorder = this.recorders.get(sessionKey)!;
    this.running.add(sessionKey);
    const recording = recorder.start({
      content: context.content,
      source: options.source ?? context.channelId,
      requestId: options.requestId,
    });

    const queue: StreamEvent[] = [];
    let done = false;
    const failure: { error: Error | null } = { error: null };

    let rounds = 0;
    let runaway = false;
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      recorder.recordEvent(recording, event);

      if (event.type === "tool_execution_end") {
        rounds += 1;
        if (rounds >= this.maxToolRounds) {
          runaway = true;
          session.agent.abort();
        }
      }

      if (event.type === "message_start" && event.message.role === "assistant") {
        queue.push({ type: "step_start", stepId: recorder.currentStepId });
      } else if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update?.type === "text_delta" && update.delta) {
          queue.push({ type: "text_delta", delta: update.delta });
        } else if (update?.type === "thinking_delta" && update.delta) {
          queue.push({ type: "thinking_delta", delta: update.delta });
        }
      } else if (event.type === "tool_execution_start") {
        queue.push({
          type: "tool_start",
          callId: event.toolCallId,
          name: event.toolName,
          argsPreview: this.getArgsPreview(event.args as Record<string, unknown>),
        });
      } else if (event.type === "tool_execution_update") {
        const text = textFromPartialResult(event.partialResult);
        if (text) queue.push({ type: "tool_update", callId: event.toolCallId, text });
      } else if (event.type === "tool_execution_end") {
        const text = contentOfToolResult(event.result)
          .map((item) => (item.type === "text" ? item.text : ""))
          .join("\n");
        queue.push({
          type: "tool_end",
          callId: event.toolCallId,
          name: event.toolName,
          isError: event.isError,
          text,
        });
      } else if (event.type === "agent_end") {
        done = true;
      }
    });

    const promptPromise = session
      .prompt(context.content)
      .then(() => session.agent.waitForIdle())
      .catch((error: unknown) => {
        done = true;
        failure.error = error instanceof Error ? error : new Error(String(error));
      });

    try {
      while (!done) {
        if (options.signal?.aborted) {
          session.agent.abort();
          throw new DOMException("Aborted", "AbortError");
        }
        while (queue.length > 0) yield queue.shift()!;
        if (!done) await delay(30);
      }
      while (queue.length > 0) yield queue.shift()!;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error, sessionKey, turnId: recording.turnId }, "Turn aborted");
      recording.finish(options.signal?.aborted ? "aborted" : "error", message);
      yield { type: "turn_end", turnId: recording.turnId, reason: "aborted", error: message };
      throw error;
    } finally {
      unsubscribe();
      this.running.delete(sessionKey);
      // 延后一拍：先让本回合的 turn-end 落盘，再启动排队消息
      queueMicrotask(() => void this.drainQueue(sessionKey));
    }

    await promptPromise;

    if (failure.error) {
      const message = failure.error.message;
      logger.error({ error: failure.error, sessionKey, turnId: recording.turnId }, "Model returned error");
      recording.finish("error", message);
      yield { type: "turn_end", turnId: recording.turnId, reason: "error", error: message };
      throw failure.error;
    }

    if (this.steered.delete(sessionKey)) {
      const message = "已被插入的消息中断";
      recording.finish("aborted", message);
      yield { type: "turn_end", turnId: recording.turnId, reason: "aborted", error: message };
      return {
        content: session.getLastAssistantText() ?? "",
        provider: this.config.provider,
        model: this.config.model,
        turnId: recording.turnId,
      };
    }

    if (runaway) {
      const message = `工具调用超过 ${this.maxToolRounds} 轮，已中止本回合`;
      recording.finish("aborted", message);
      yield { type: "turn_end", turnId: recording.turnId, reason: "aborted", error: message };
      throw new Error(message);
    }

    const modelFailure = AgentRuntime.modelFailure(session.messages);
    if (modelFailure) {
      recording.finish("error", modelFailure);
      yield { type: "turn_end", turnId: recording.turnId, reason: "error", error: modelFailure };
      throw new Error(modelFailure);
    }

    recording.finish("completed");
    yield { type: "turn_end", turnId: recording.turnId, reason: "completed" };

    const stats = session.getSessionStats();
    return {
      content: session.getLastAssistantText() ?? "",
      provider: this.config.provider,
      model: this.config.model,
      usage: {
        promptTokens: stats.tokens.input,
        completionTokens: stats.tokens.output,
        totalTokens: stats.tokens.total,
      },
      turnId: recording.turnId,
    };
  }

  /** 清除会话（同时重置 durable 日志与 pi 会话） */
  async clearSession(context: InboundMessageContext): Promise<void> {
    const sessionKey = sessionKeyFor(context);
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.dispose();
      this.sessions.delete(sessionKey);
    }
    this.recorders.delete(sessionKey);

    if (this.durable.has(sessionKey)) {
      this.durable.append(sessionKey, [{ kind: "reset", reason: "user" }], [{ type: "reset", reason: "user" }]);
    }

    // 归档 pi 会话文件，让下一次是干净的上下文
    const sessionFile = join(this.sessionDir, `${safeFileName(sessionKey)}.jsonl`);
    if (fs.existsSync(sessionFile) && !fs.statSync(sessionFile).isDirectory()) {
      fs.renameSync(sessionFile, `${sessionFile}.reset.${Date.now()}`);
    }

    logger.debug({ sessionKey }, "Session cleared");
  }

  /** 获取会话信息 */
  getSessionInfo(context: InboundMessageContext): {
    messageCount: number;
    lastUpdate: Date;
  } | null {
    const sessionKey = sessionKeyFor(context);
    const session = this.sessions.get(sessionKey);
    if (!session) return null;

    const stats = session.getSessionStats();
    return { messageCount: stats.totalMessages, lastUpdate: new Date() };
  }

  /** durable 快照 */
  getSnapshot(sessionKey: string): DurableSessionSnapshot | null {
    if (!this.durable.has(sessionKey)) return null;
    return this.durable.snapshot(sessionKey);
  }

  /**
   * 打开会话的 durable 日志（不创建 pi 会话），用于 UI 读取历史。
   * 若发现崩溃遗留的未完成回合，顺手修复 pi 会话文件里的孤立工具调用，
   * 否则下一次 prompt 会带着非法上下文发给模型。
   */
  openDurableSession(sessionKey: string): RecoveryReport {
    const cwd = this.config.workingDirectory ?? process.cwd();
    const { recovery } = this.durable.open(sessionKey, cwd);
    this.recoveries.set(sessionKey, recovery);

    if (this.durable.snapshot(sessionKey).queued.length > 0 && !this.running.has(sessionKey)) {
      void this.drainQueue(sessionKey);
    }

    if (recovery.interruptedTurns.length > 0 || recovery.interruptedTools.length > 0) {
      const sessionFile = join(this.sessionDir, `${safeFileName(sessionKey)}.jsonl`);
      if (fs.existsSync(sessionFile) && !fs.statSync(sessionFile).isDirectory()) {
        try {
          const manager = SessionManager.open(sessionFile, this.sessionDir);
          this.repairOrphanToolCalls(manager, recovery);
        } catch (error) {
          logger.warn({ error, sessionKey }, "Failed to repair pi session after crash");
        }
      }
    }

    return recovery;
  }

  /** 该会话是否正在跑回合 */
  isBusy(sessionKey: string): boolean {
    return this.running.has(sessionKey);
  }

  /** 当前排队中的消息 */
  listQueued(sessionKey: string): Array<{ id: string; content: string; behavior: "steer" | "followUp" }> {
    if (!this.durable.has(sessionKey)) return [];
    return this.durable.snapshot(sessionKey).queued.map((item) => ({
      id: item.id,
      content: item.content,
      behavior: item.behavior,
    }));
  }

  /**
   * 回合运行期间收到的消息入队。
   * 队列写入 durable 日志，进程重启后仍然有效。
   */
  enqueueMessage(params: {
    sessionKey: string;
    content: string;
    behavior: "steer" | "followUp";
    context: InboundMessageContext;
  }): string {
    const queueId = randomUUID();
    this.durable.append(
      params.sessionKey,
      [
        {
          kind: "queued",
          queueId,
          content: params.content,
          behavior: params.behavior,
          channelId: params.context.channelId,
          chatId: params.context.chatId,
          senderId: params.context.senderId,
        },
      ],
      [{ type: "queue_added", queueId, content: params.content, behavior: params.behavior }]
    );

    // steer：中断当前回合，让排队消息立刻执行
    if (params.behavior === "steer") {
      const session = this.sessions.get(params.sessionKey);
      if (session?.isStreaming) session.agent.abort();
    }

    // 若当前没有回合在跑，直接开始排空
    if (!this.running.has(params.sessionKey)) void this.drainQueue(params.sessionKey);

    return queueId;
  }

  /** 删除排队消息 */
  dequeueMessage(sessionKey: string, queueId: string): boolean {
    if (!this.durable.has(sessionKey)) return false;
    const pending = this.durable.snapshot(sessionKey).queued;
    if (!pending.some((item) => item.id === queueId)) return false;
    this.durable.append(sessionKey, [{ kind: "dequeued", queueId, reason: "removed" }], [
      { type: "queue_removed", queueId, reason: "removed" },
    ]);
    return true;
  }

  /** 把排队消息升级为 steer（中断当前回合） */
  steerQueued(sessionKey: string, queueId: string): boolean {
    if (!this.durable.has(sessionKey)) return false;
    const pending = this.durable.snapshot(sessionKey).queued;
    const index = pending.findIndex((item) => item.id === queueId);
    if (index === -1) return false;

    // 重新入队一条 steer，并移除原条目，保持顺序语义简单
    const item = pending[index]!;
    this.durable.append(sessionKey, [
      { kind: "dequeued", queueId, reason: "removed" },
      {
        kind: "queued",
        queueId: `${queueId}-steer`,
        content: item.content,
        behavior: "steer",
        channelId: "webchat",
        chatId: sessionKey,
        senderId: sessionKey.replace(/^webchat:/, ""),
      },
    ]);
    const session = this.sessions.get(sessionKey);
    this.steered.add(sessionKey);
    if (session?.isStreaming) session.agent.abort();
    return true;
  }

  /** 按顺序执行排队消息 */
  private async drainQueue(sessionKey: string): Promise<void> {
    if (this.draining.has(sessionKey)) return;
    this.draining.add(sessionKey);

    try {
      for (;;) {
        if (this.running.has(sessionKey)) return;

        const snapshot = this.durable.snapshot(sessionKey);
        const next = snapshot.queued[0];
        if (!next) return;
        const stored = this.durable.readRecords(sessionKey).find(
          (record) => record.kind === "queued" && record.queueId === next.id
        );
        if (!stored || stored.kind !== "queued") return;

        this.durable.append(sessionKey, [{ kind: "dequeued", queueId: next.id, reason: "delivered" }], [
          { type: "queue_removed", queueId: next.id, reason: "delivered" },
        ]);

        const context: InboundMessageContext = {
          channelId: stored.channelId as InboundMessageContext["channelId"],
          chatId: stored.chatId,
          messageId: `queue-${next.id}`,
          senderId: stored.senderId,
          senderName: "",
          content: stored.content,
          chatType: "direct",
          timestamp: Date.now(),
        };

        try {
          // 事件通过 durable 订阅广播，这里只驱动执行
          for await (const _event of this.chatStream(context, {
            source: "queue",
            sessionKeyOverride: sessionKey,
          })) {
            void _event;
          }
        } catch (error) {
          logger.warn({ error, sessionKey }, "执行排队消息失败");
          return;
        }
      }
    } finally {
      this.draining.delete(sessionKey);
    }
  }

  /**
   * 热更新模型配置。
   * 只改内存中的运行时参数并同步到已打开的会话，不重建会话、不丢上下文。
   * 正在流式的会话跳过，等它本轮结束后下一次保存再生效。
   */
  applyModelConfig(next: {
    model: string;
    provider: ProviderId;
    thinkingLevel?: ThinkingLevel;
  }): { applied: number; skipped: number } {
    const changedProvider = this.config.provider !== next.provider;
    const changedModel = this.config.model !== next.model;

    this.config.provider = next.provider;
    this.config.model = next.model;
    if (next.thinkingLevel) this.config.thinkingLevel = next.thinkingLevel;

    let applied = 0;
    let skipped = 0;

    if (changedProvider || changedModel) {
      // 重新解析模型；解析失败说明配置有误，保持旧模型继续工作
      const resolved = resolveModel(next.provider, next.model);
      if (!resolved) {
        logger.warn({ provider: next.provider, model: next.model }, "热更新失败：无法解析模型");
        return { applied: 0, skipped: this.sessions.size };
      }

      for (const [sessionKey, session] of this.sessions) {
        if (session.isStreaming) {
          skipped += 1;
          continue;
        }
        try {
          session.agent.setModel(resolved);
          applied += 1;
        } catch (error) {
          skipped += 1;
          logger.warn({ error, sessionKey }, "热更新模型失败");
        }
      }
    }

    if (next.thinkingLevel) {
      for (const session of this.sessions.values()) {
        if (session.isStreaming) continue;
        try {
          session.agent.setThinkingLevel(next.thinkingLevel);
        } catch {
          // 模型不支持该思考级别时忽略
        }
      }
    }

    logger.info(
      { provider: next.provider, model: next.model, thinkingLevel: next.thinkingLevel, applied, skipped },
      "模型配置已热更新"
    );
    return { applied, skipped };
  }

  /** 最近一次恢复报告 */
  getRecovery(sessionKey: string): RecoveryReport | null {
    return this.recoveries.get(sessionKey) ?? null;
  }

  /** 关闭所有会话 */
  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.recorders.clear();
    logger.info("All sessions disposed");
  }
}

/** 创建 AgentRuntime */
export function createAgentRuntime(config: MoziConfig): AgentRuntime {
  initModelResolver(config);

  return new AgentRuntime({
    model: config.agent.defaultModel,
    provider: config.agent.defaultProvider,
    systemPrompt: config.agent.systemPrompt,
    maxTokens: config.agent.maxTokens,
    workingDirectory: config.agent.workingDirectory,
    sessionDir: config.sessions?.directory,
    thinkingLevel: config.agent.thinkingLevel,
  });
}
