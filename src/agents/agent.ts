/**
 * Agent - 消息处理核心
 * 使用 AgentRuntime (基于 pi-coding-agent) 作为底层引擎
 */

import type {
  InboundMessageContext,
  ProviderId,
  MoziConfig,
} from "../types/index.js";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { AgentRuntime, createAgentRuntime, type ChatResponse, type StreamEvent } from "./runtime.js";
import { getChildLogger } from "../utils/logger.js";
import { createBuiltinTools, type BuiltinToolsOptions } from "../tools/builtin/index.js";
import { initSkills, type SkillsRegistry } from "../skills/index.js";
import type { MemoryManager } from "../memory/index.js";
import { getCronService } from "../cron/service.js";
import { createDefaultCronExecuteJob } from "../cron/executor.js";

const logger = getChildLogger("agent");

// ============== Agent 配置 ==============

/** Agent 配置 */
export interface AgentOptions {
  model: string;
  provider?: ProviderId;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  maxHistoryMessages?: number;
  maxHistoryTurns?: number;
  contextWindow?: number;
  enableTools?: boolean;
  toolPolicy?: { allow?: string[]; deny?: string[] };
  enableCompaction?: boolean;
  compactionThreshold?: number;
  maxToolRounds?: number;
  workingDirectory?: string;
  enableFunctionCalling?: boolean;
  memoryManager?: MemoryManager;
}

/** Agent 响应 */
export interface AgentResponse {
  content: string;
  toolCalls?: ToolCallResult[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  provider: ProviderId;
  model: string;
}

/** 工具调用结果 */
export interface ToolCallResult {
  toolCallId: string;
  name: string;
  result: {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  };
  isError: boolean;
  durationMs: number;
}

// ============== Agent 类 ==============

/** Agent 类 - 包装 AgentRuntime */
export class Agent {
  private runtime: AgentRuntime;
  private options: AgentOptions;
  private tools: AgentTool[] = [];

  constructor(runtime: AgentRuntime, options: AgentOptions) {
    this.runtime = runtime;
    this.options = options;

    if (this.options.enableTools) {
      this.initializeTools();
    }
  }

  private initializeTools(): void {
    const builtinOptions: BuiltinToolsOptions = {
      filesystem: { allowedPaths: [this.options.workingDirectory ?? process.cwd()] },
      bash: { allowedPaths: [this.options.workingDirectory ?? process.cwd()] },
      enableBrowser: true,
      enableMemory: !!this.options.memoryManager,
      memoryManager: this.options.memoryManager,
      enableCron: false,
    };

    this.tools = createBuiltinTools(builtinOptions);

    // 注册工具到 runtime
    for (const tool of this.tools) {
      this.runtime.registerCustomTool(tool);
    }

    logger.info({ toolCount: this.tools.length }, "Tools initialized");
  }

  setSkillsRegistry(registry: SkillsRegistry): void {
    this.runtime.setSkillsRegistry(registry);
  }

  registerTool(tool: AgentTool): void {
    this.tools.push(tool);
    this.runtime.registerCustomTool(tool);
  }

  /** 处理消息 (非流式) */
  async processMessage(context: InboundMessageContext): Promise<AgentResponse> {
    const response = await this.runtime.chat(context);

    return {
      content: response.content,
      usage: response.usage,
      provider: response.provider,
      model: response.model,
    };
  }

  /** 流式处理消息 */
  async *processMessageStream(
    context: InboundMessageContext,
    options?: { signal?: AbortSignal }
  ): AsyncGenerator<string, AgentResponse, unknown> {
    const allToolCalls: ToolCallResult[] = [];
    let fullContent = "";

    for await (const event of this.runtime.chatStream(context, options)) {
      if (event.type === "text_delta") {
        fullContent += event.delta;
        yield event.delta;
      } else if (event.type === "tool_start") {
        yield `\n⏺ ${event.name}(${event.argsPreview})`;
      } else if (event.type === "tool_end") {
        yield event.isError ? " ✗" : " ✓";
      }
    }

    // 返回最终响应
    return {
      content: fullContent,
      toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
      provider: this.options.provider ?? ("deepseek" as ProviderId),
      model: this.options.model,
    };
  }

  clearSession(context: InboundMessageContext): void {
    this.runtime.clearSession(context);
  }

  getSessionInfo(context: InboundMessageContext): {
    messageCount: number;
    estimatedTokens: number;
    hasSummary: boolean;
    lastUpdate: Date;
  } | null {
    const info = this.runtime.getSessionInfo(context);
    if (!info) return null;

    return {
      messageCount: info.messageCount,
      estimatedTokens: 0, // 由 runtime 内部管理
      hasSummary: false,
      lastUpdate: info.lastUpdate,
    };
  }

  restoreSessionFromTranscript(
    sessionKey: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>
  ): void {
    this.runtime.restoreSessionFromTranscript(sessionKey, messages);
  }
}

/** 创建 Agent */
export async function createAgent(config: MoziConfig): Promise<Agent> {
  let memoryManager: MemoryManager | undefined;
  if (config.memory?.enabled !== false && config.memory) {
    const { createMemoryManager } = await import("../memory/index.js");
    memoryManager = createMemoryManager({
      enabled: config.memory.enabled ?? true,
      directory: config.memory.directory,
      embeddingProvider: config.memory.embeddingProvider,
      embeddingModel: config.memory.embeddingModel,
    });
    logger.info({ directory: config.memory.directory }, "Memory system initialized");
  }

  // 创建 runtime
  const runtime = createAgentRuntime(config);

  // 设置 cron 执行器
  const agentExecutor = async (params: {
    message: string;
    sessionKey?: string;
    model?: string;
    timeoutSeconds?: number;
  }) => {
    try {
      const response = await runtime.chat({
        channelId: "webchat",
        chatId: params.sessionKey ?? `cron-${Date.now()}`,
        chatType: "direct",
        senderId: "cron-system",
        content: params.message,
        messageId: `cron-${Date.now()}`,
        timestamp: Date.now(),
      });
      return { success: true, output: response.content };
    } catch (err) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  };

  const cronExecuteJob = createDefaultCronExecuteJob({ agentExecutor });
  const cronService = getCronService({
    enabled: true,
    executeJob: cronExecuteJob,
    onEvent: (event) => { logger.debug({ event }, "Cron event"); },
  });
  cronService.start();
  logger.info("Cron service initialized");

  // 创建 Agent
  const agent = new Agent(runtime, {
    model: config.agent.defaultModel,
    provider: config.agent.defaultProvider,
    systemPrompt: config.agent.systemPrompt ?? "",
    temperature: config.agent.temperature,
    maxTokens: config.agent.maxTokens,
    workingDirectory: config.agent.workingDirectory ?? process.cwd(),
    enableFunctionCalling: config.agent.enableFunctionCalling ?? true,
    memoryManager,
    enableTools: true,
  });

  // 加载 skills
  if (config.skills?.enabled !== false) {
    try {
      const registry = await initSkills(config.skills);
      agent.setSkillsRegistry(registry);
      const skillCount = registry.getAll().length;
      if (skillCount > 0) logger.info({ skillCount }, "Skills loaded");
    } catch (error) {
      logger.warn({ error }, "Failed to load skills");
    }
  }

  return agent;
}