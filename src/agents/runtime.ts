/**
 * Agent Runtime - 使用 pi-coding-agent 的 createAgentSession 高层 API
 * 管理多会话，提供 chat 和 chatStream 接口
 */

import { join } from "path";
import * as os from "os";
import {
  createAgentSession,
  AgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  type ToolDefinition,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { MoziConfig, ProviderId, InboundMessageContext } from "../types/index.js";
import { resolveModel, initModelResolver, getApiKeyForProvider } from "../providers/model-resolver.js";
import { getChildLogger } from "../utils/logger.js";
import { buildSystemPrompt } from "./system-prompt.js";
import type { SkillsRegistry } from "../skills/index.js";
import type { MemoryManager } from "../memory/index.js";
import type { CronService } from "../cron/service.js";

const logger = getChildLogger("runtime");

/** Runtime 配置 */
export interface RuntimeConfig {
  model: string;
  provider: ProviderId;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  workingDirectory?: string;
  sessionDir?: string;
  memoryManager?: MemoryManager;
  cronService?: CronService;
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
}

/** Stream 事件 */
export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; name: string; argsPreview: string }
  | { type: "tool_end"; isError: boolean };

/**
 * AgentRuntime - 管理 AgentSession 实例
 */
export class AgentRuntime {
  private sessions = new Map<string, AgentSession>();
  private config: RuntimeConfig;
  private sessionDir: string;
  private skillsRegistry: SkillsRegistry | null = null;
  private customTools: AgentTool[] = [];

  constructor(config: RuntimeConfig) {
    this.config = config;
    this.sessionDir = config.sessionDir ?? join(os.homedir(), ".mozi", "sessions");

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

  /** 获取或创建会话 */
  private async getOrCreateSession(sessionKey: string): Promise<AgentSession> {
    let session = this.sessions.get(sessionKey);
    if (session) return session;

    // 解析模型
    const model = resolveModel(this.config.provider, this.config.model);
    if (!model) {
      throw new Error(`Cannot resolve model: ${this.config.provider}/${this.config.model}`);
    }

    // 为每个会话创建独立的 SessionManager
    const sessionFile = join(this.sessionDir, `${this.sanitizeSessionKey(sessionKey)}.jsonl`);
    const sessionManager = SessionManager.create(this.config.workingDirectory ?? process.cwd(), sessionFile);

    // 创建 AuthStorage 并从 mozi 配置预填充 API key
    const authStorage = AuthStorage.inMemory();

    // 重要：使用 model.provider (由 resolveModel 设置) 而不是 this.config.provider
    // 因为 createAgentSession 内部通过 model.provider 查找 API key
    const modelProvider = model.provider;
    const apiKey = getApiKeyForProvider(this.config.provider);
    if (apiKey) {
      // 同时设置 config.provider 和 model.provider (如果不同)
      authStorage.set(this.config.provider, { type: "api_key", key: apiKey });
      if (modelProvider !== this.config.provider) {
        authStorage.set(modelProvider, { type: "api_key", key: apiKey });
      }
      logger.debug({ provider: this.config.provider, modelProvider }, "API key set from mozi config");
    }

    // 设置 fallback resolver 以支持其他 provider
    authStorage.setFallbackResolver((provider: string) => {
      // 尝试直接获取
      let key = getApiKeyForProvider(provider);
      // 如果找不到，尝试用 config.provider 的 key (因为可能是同一个服务的不同别名)
      if (!key && provider === modelProvider) {
        key = getApiKeyForProvider(this.config.provider);
      }
      if (key) {
        logger.debug({ provider }, "Got API key from mozi config via fallback");
      }
      return key;
    });

    // 创建 ModelRegistry 使用同一个 authStorage
    const modelRegistry = new ModelRegistry(authStorage);

    // 构建自定义工具定义
    const customToolDefinitions: ToolDefinition[] = this.customTools.map((tool) => ({
      name: tool.name,
      label: tool.label ?? tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: tool.execute,
    }));

    // 创建 AgentSession
    const { session: newSession } = await createAgentSession({
      cwd: this.config.workingDirectory ?? process.cwd(),
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: "medium" as ThinkingLevel,
      sessionManager,
      customTools: customToolDefinitions,
      tools: [], // 不使用默认的 coding tools，只用自定义工具
    });

    // 设置系统提示
    const systemPrompt = this.buildSystemPromptText();
    newSession.agent.setSystemPrompt(systemPrompt);

    // 如果有自定义工具，设置到 agent
    if (this.customTools.length > 0) {
      newSession.agent.setTools(this.customTools);
    }

    this.sessions.set(sessionKey, newSession);
    logger.debug({ sessionKey }, "New session created");

    return newSession;
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

  /** 清理 session key 使其可作为文件名 */
  private sanitizeSessionKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  /** 从 context 获取 session key */
  private getSessionKey(context: InboundMessageContext): string {
    if (context.chatType === "group") {
      return `${context.channelId}:${context.chatId}`;
    }
    return `${context.channelId}:${context.senderId}`;
  }

  /** 非流式聊天 */
  async chat(context: InboundMessageContext): Promise<ChatResponse> {
    const sessionKey = this.getSessionKey(context);
    logger.debug({ sessionKey, content: context.content.slice(0, 100) }, "Processing message");

    const session = await this.getOrCreateSession(sessionKey);

    // 发送消息
    await session.prompt(context.content);
    await session.agent.waitForIdle();

    // 提取最后一条助手消息
    const lastText = session.getLastAssistantText() ?? "";

    // 获取使用统计
    const stats = session.getSessionStats();

    return {
      content: lastText,
      provider: this.config.provider,
      model: this.config.model,
      usage: {
        promptTokens: stats.tokens.input,
        completionTokens: stats.tokens.output,
        totalTokens: stats.tokens.total,
      },
    };
  }

  /** 流式聊天 */
  async *chatStream(
    context: InboundMessageContext,
    options?: { signal?: AbortSignal }
  ): AsyncGenerator<StreamEvent, ChatResponse, unknown> {
    const sessionKey = this.getSessionKey(context);
    logger.debug({ sessionKey, content: context.content.slice(0, 100) }, "Processing message (stream)");

    const session = await this.getOrCreateSession(sessionKey);

    // 事件队列
    const eventQueue: StreamEvent[] = [];
    let done = false;
    let promptError: Error | null = null;

    // 订阅事件
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "message_update") {
        const updateEvent = event as { type: "message_update"; assistantMessageEvent: { type: string; delta?: string } };
        if (updateEvent.assistantMessageEvent?.type === "text_delta" && updateEvent.assistantMessageEvent.delta) {
          eventQueue.push({ type: "text_delta", delta: updateEvent.assistantMessageEvent.delta });
        }
      } else if (event.type === "tool_execution_start") {
        const toolEvent = event as { type: "tool_execution_start"; toolName: string; args: Record<string, unknown> };
        const argsPreview = this.getArgsPreview(toolEvent.args);
        eventQueue.push({ type: "tool_start", name: toolEvent.toolName, argsPreview });
      } else if (event.type === "tool_execution_end") {
        const toolEvent = event as { type: "tool_execution_end"; isError: boolean };
        eventQueue.push({ type: "tool_end", isError: toolEvent.isError });
      } else if (event.type === "agent_end") {
        done = true;
      }
    });

    // 启动 prompt
    const promptPromise = session.prompt(context.content)
      .then(() => session.agent.waitForIdle())
      .catch((err: unknown) => {
        done = true;
        promptError = err instanceof Error ? err : new Error(String(err));
      });

    // 流式输出事件
    try {
      while (!done) {
        if (options?.signal?.aborted) {
          session.agent.abort();
          throw new DOMException("Aborted", "AbortError");
        }

        while (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        }

        if (!done) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      // 排空剩余事件
      while (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      }
    } finally {
      unsubscribe();
    }

    await promptPromise;

    if (promptError) {
      throw promptError;
    }

    // 获取结果
    const lastText = session.getLastAssistantText() ?? "";
    const stats = session.getSessionStats();

    return {
      content: lastText,
      provider: this.config.provider,
      model: this.config.model,
      usage: {
        promptTokens: stats.tokens.input,
        completionTokens: stats.tokens.output,
        totalTokens: stats.tokens.total,
      },
    };
  }

  /** 获取参数预览 */
  private getArgsPreview(args: Record<string, unknown>): string {
    if (!args) return "";
    const mainArg = args.path ?? args.directory ?? args.command ?? args.query ?? args.pattern;
    if (typeof mainArg === "string") {
      const preview = mainArg.replace(/\n/g, " ").trim();
      return preview.length > 40 ? preview.slice(0, 40) + "…" : preview;
    }
    return "";
  }

  /** 清除会话 */
  async clearSession(context: InboundMessageContext): Promise<void> {
    const sessionKey = this.getSessionKey(context);
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.dispose();
      this.sessions.delete(sessionKey);
    }
    logger.debug({ sessionKey }, "Session cleared");
  }

  /** 获取会话信息 */
  getSessionInfo(context: InboundMessageContext): {
    messageCount: number;
    lastUpdate: Date;
  } | null {
    const sessionKey = this.getSessionKey(context);
    const session = this.sessions.get(sessionKey);
    if (!session) return null;

    const stats = session.getSessionStats();
    return {
      messageCount: stats.totalMessages,
      lastUpdate: new Date(),
    };
  }

  /** 从历史恢复会话 */
  async restoreSessionFromTranscript(
    sessionKey: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>
  ): Promise<void> {
    const session = await this.getOrCreateSession(sessionKey);

    // AgentSession 会自动持久化，这里我们可以通过发送初始消息来恢复上下文
    // 注意：这是一个简化的实现，真正的恢复可能需要更复杂的处理
    if (messages.length > 0) {
      logger.debug({ sessionKey, messageCount: messages.length }, "Session restored from transcript");
    }
  }

  /** 关闭所有会话 */
  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    logger.info("All sessions disposed");
  }
}

/** 创建 AgentRuntime */
export function createAgentRuntime(config: MoziConfig): AgentRuntime {
  const runtimeConfig: RuntimeConfig = {
    model: config.agent.defaultModel,
    provider: config.agent.defaultProvider,
    systemPrompt: config.agent.systemPrompt,
    temperature: config.agent.temperature,
    maxTokens: config.agent.maxTokens,
    workingDirectory: config.agent.workingDirectory,
    sessionDir: config.sessions?.directory,
  };

  // 初始化模型解析器
  initModelResolver(config);

  return new AgentRuntime(runtimeConfig);
}