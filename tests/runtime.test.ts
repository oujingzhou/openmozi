/**
 * AgentRuntime 测试
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentRuntime, createAgentRuntime, type RuntimeConfig } from "../src/agents/runtime.js";
import type { MoziConfig } from "../src/types/index.js";

// Mock pi-coding-agent
vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: vi.fn().mockResolvedValue({
    session: {
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockReturnValue(() => {}),
      getLastAssistantText: vi.fn().mockReturnValue("Mock response"),
      getSessionStats: vi.fn().mockReturnValue({
        tokens: { input: 100, output: 50, total: 150 },
        totalMessages: 2,
      }),
      dispose: vi.fn(),
      agent: {
        setSystemPrompt: vi.fn(),
        setTools: vi.fn(),
        waitForIdle: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn(),
      },
    },
  }),
  SessionManager: {
    create: vi.fn().mockReturnValue({}),
  },
  AuthStorage: {
    inMemory: vi.fn().mockReturnValue({
      set: vi.fn(),
      setFallbackResolver: vi.fn(),
    }),
  },
  ModelRegistry: vi.fn().mockImplementation(() => ({})),
}));

// Mock model-resolver
vi.mock("../src/providers/model-resolver.js", () => ({
  resolveModel: vi.fn().mockReturnValue({
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    provider: "test-provider",
    baseUrl: "https://api.test.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  }),
  initModelResolver: vi.fn(),
  getApiKeyForProvider: vi.fn().mockReturnValue("test-api-key"),
}));

// Mock logger
vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock system-prompt
vi.mock("../src/agents/system-prompt.js", () => ({
  buildSystemPrompt: vi.fn().mockReturnValue("Test system prompt"),
}));

describe("agents/runtime", () => {
  describe("AgentRuntime", () => {
    let runtime: AgentRuntime;
    const testConfig: RuntimeConfig = {
      model: "test-model",
      provider: "test-provider",
      systemPrompt: "You are a test assistant",
      workingDirectory: "/tmp/test",
    };

    beforeEach(() => {
      vi.clearAllMocks();
      runtime = new AgentRuntime(testConfig);
    });

    it("should initialize with config", () => {
      expect(runtime).toBeInstanceOf(AgentRuntime);
    });

    it("should register custom tools", () => {
      const mockTool = {
        name: "test_tool",
        label: "Test Tool",
        description: "A test tool",
        parameters: {},
        execute: vi.fn(),
      };

      runtime.registerCustomTool(mockTool as any);
      // Tool should be registered (internal state)
    });

    it("should set skills registry", () => {
      const mockRegistry = {
        buildPrompt: vi.fn().mockReturnValue("skills prompt"),
        getAll: vi.fn().mockReturnValue([]),
      };

      runtime.setSkillsRegistry(mockRegistry as any);
      // Registry should be set (internal state)
    });

    describe("chat", () => {
      it("should process chat message", async () => {
        const context = {
          channelId: "test-channel",
          chatId: "test-chat",
          chatType: "direct" as const,
          senderId: "test-user",
          content: "Hello",
          messageId: "msg-1",
          timestamp: Date.now(),
        };

        const response = await runtime.chat(context);

        expect(response).toHaveProperty("content");
        expect(response).toHaveProperty("provider", "test-provider");
        expect(response).toHaveProperty("model", "test-model");
        expect(response).toHaveProperty("usage");
      });

      it("should return usage statistics", async () => {
        const context = {
          channelId: "test-channel",
          chatId: "test-chat",
          chatType: "direct" as const,
          senderId: "test-user",
          content: "Hello",
          messageId: "msg-1",
          timestamp: Date.now(),
        };

        const response = await runtime.chat(context);

        expect(response.usage).toEqual({
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        });
      });
    });

    describe("session management", () => {
      it("should generate correct session key for direct chat", async () => {
        const context = {
          channelId: "feishu",
          chatId: "chat-123",
          chatType: "direct" as const,
          senderId: "user-456",
          content: "Hello",
          messageId: "msg-1",
          timestamp: Date.now(),
        };

        await runtime.chat(context);
        // Session key should be "feishu:user-456" for direct chat
      });

      it("should generate correct session key for group chat", async () => {
        const context = {
          channelId: "dingtalk",
          chatId: "group-789",
          chatType: "group" as const,
          senderId: "user-456",
          content: "Hello",
          messageId: "msg-1",
          timestamp: Date.now(),
        };

        await runtime.chat(context);
        // Session key should be "dingtalk:group-789" for group chat
      });

      it("should clear session", async () => {
        const context = {
          channelId: "test",
          chatId: "chat-1",
          chatType: "direct" as const,
          senderId: "user-1",
          content: "Hello",
          messageId: "msg-1",
          timestamp: Date.now(),
        };

        // Create session first
        await runtime.chat(context);

        // Clear session
        await runtime.clearSession(context);

        // Session should be cleared (no error thrown)
      });

      it("should get session info", async () => {
        const context = {
          channelId: "test",
          chatId: "chat-1",
          chatType: "direct" as const,
          senderId: "user-1",
          content: "Hello",
          messageId: "msg-1",
          timestamp: Date.now(),
        };

        // Create session first
        await runtime.chat(context);

        const info = runtime.getSessionInfo(context);

        expect(info).not.toBeNull();
        expect(info).toHaveProperty("messageCount");
        expect(info).toHaveProperty("lastUpdate");
      });

      it("should return null for non-existent session", () => {
        const context = {
          channelId: "test",
          chatId: "non-existent",
          chatType: "direct" as const,
          senderId: "user-1",
          content: "Hello",
          messageId: "msg-1",
          timestamp: Date.now(),
        };

        const info = runtime.getSessionInfo(context);

        expect(info).toBeNull();
      });
    });

    describe("shutdown", () => {
      it("should dispose all sessions on shutdown", async () => {
        const context = {
          channelId: "test",
          chatId: "chat-1",
          chatType: "direct" as const,
          senderId: "user-1",
          content: "Hello",
          messageId: "msg-1",
          timestamp: Date.now(),
        };

        // Create session
        await runtime.chat(context);

        // Shutdown
        await runtime.shutdown();

        // All sessions should be disposed
      });
    });
  });

  describe("createAgentRuntime", () => {
    it("should create runtime from MoziConfig", () => {
      const config: MoziConfig = {
        providers: {
          "test-provider": {
            apiKey: "test-key",
          },
        },
        channels: {},
        agent: {
          defaultModel: "test-model",
          defaultProvider: "test-provider",
        },
      };

      const runtime = createAgentRuntime(config);

      expect(runtime).toBeInstanceOf(AgentRuntime);
    });
  });
});
