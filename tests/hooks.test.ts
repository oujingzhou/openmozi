/**
 * Hooks 系统测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock logger
vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  registerHook,
  registerHooks,
  triggerHook,
  triggerHookSync,
  clearHooks,
  getHookCount,
  emitMessageReceived,
  emitMessageSending,
  emitAgentStart,
  emitAgentEnd,
  emitToolStart,
  emitToolEnd,
  emitError,
  type HookEvent,
  type MessageReceivedEvent,
  type AgentStartEvent,
  type ToolStartEvent,
  type ErrorEvent,
} from "../src/hooks/index.js";
import type { InboundMessageContext } from "../src/types/index.js";

describe("hooks", () => {
  beforeEach(() => {
    clearHooks();
  });

  afterEach(() => {
    clearHooks();
  });

  describe("registerHook", () => {
    it("should register a hook handler", () => {
      const handler = vi.fn();
      registerHook("message_received", handler);

      expect(getHookCount("message_received")).toBe(1);
    });

    it("should return unsubscribe function", () => {
      const handler = vi.fn();
      const unsubscribe = registerHook("message_received", handler);

      expect(getHookCount("message_received")).toBe(1);

      unsubscribe();

      expect(getHookCount("message_received")).toBe(0);
    });

    it("should allow multiple handlers for same event", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      registerHook("agent_start", handler1);
      registerHook("agent_start", handler2);

      expect(getHookCount("agent_start")).toBe(2);
    });
  });

  describe("registerHooks", () => {
    it("should register multiple hooks at once", () => {
      const handlers = {
        message_received: vi.fn(),
        agent_start: vi.fn(),
        agent_end: vi.fn(),
      };

      registerHooks(handlers);

      expect(getHookCount("message_received")).toBe(1);
      expect(getHookCount("agent_start")).toBe(1);
      expect(getHookCount("agent_end")).toBe(1);
    });

    it("should return combined unsubscribe function", () => {
      const handlers = {
        message_received: vi.fn(),
        agent_start: vi.fn(),
      };

      const unsubscribe = registerHooks(handlers);

      expect(getHookCount()).toBe(2);

      unsubscribe();

      expect(getHookCount()).toBe(0);
    });

    it("should skip undefined handlers", () => {
      const handlers = {
        message_received: vi.fn(),
        agent_start: undefined,
      };

      registerHooks(handlers as Record<string, unknown>);

      expect(getHookCount("message_received")).toBe(1);
      expect(getHookCount("agent_start")).toBe(0);
    });
  });

  describe("triggerHook", () => {
    it("should call all handlers for event type", async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      registerHook("agent_start", handler1);
      registerHook("agent_start", handler2);

      const event: AgentStartEvent = {
        type: "agent_start",
        timestamp: Date.now(),
        provider: "deepseek",
        model: "deepseek-flash",
        messages: [],
      };

      await triggerHook(event);

      expect(handler1).toHaveBeenCalledWith(event);
      expect(handler2).toHaveBeenCalledWith(event);
    });

    it("should not fail when no handlers registered", async () => {
      const event: AgentStartEvent = {
        type: "agent_start",
        timestamp: Date.now(),
        provider: "deepseek",
        model: "deepseek-flash",
        messages: [],
      };

      // Should not throw
      await triggerHook(event);
    });

    it("should handle async handlers", async () => {
      const results: number[] = [];

      const handler1 = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(1);
      });

      const handler2 = vi.fn(async () => {
        results.push(2);
      });

      registerHook("tool_start", handler1);
      registerHook("tool_start", handler2);

      await triggerHook({
        type: "tool_start",
        timestamp: Date.now(),
        toolName: "test",
        toolCallId: "call-1",
        arguments: {},
      });

      expect(results).toEqual([1, 2]);
    });

    it("should continue even if handler throws", async () => {
      const handler1 = vi.fn(() => {
        throw new Error("Handler error");
      });
      const handler2 = vi.fn();

      registerHook("error", handler1);
      registerHook("error", handler2);

      await triggerHook({
        type: "error",
        timestamp: Date.now(),
        error: new Error("Test error"),
      });

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });
  });

  describe("triggerHookSync", () => {
    it("should trigger hooks without blocking", () => {
      const handler = vi.fn();
      registerHook("message_sent", handler);

      triggerHookSync({
        type: "message_sent",
        timestamp: Date.now(),
        channelId: "channel-1",
        chatId: "chat-1",
        success: true,
      });

      // Handler may be called asynchronously
      // Just verify no error thrown
    });
  });

  describe("clearHooks", () => {
    it("should clear all registered hooks", () => {
      registerHook("message_received", vi.fn());
      registerHook("agent_start", vi.fn());
      registerHook("agent_end", vi.fn());

      expect(getHookCount()).toBe(3);

      clearHooks();

      expect(getHookCount()).toBe(0);
    });
  });

  describe("getHookCount", () => {
    it("should return count for specific event type", () => {
      registerHook("message_received", vi.fn());
      registerHook("message_received", vi.fn());
      registerHook("agent_start", vi.fn());

      expect(getHookCount("message_received")).toBe(2);
      expect(getHookCount("agent_start")).toBe(1);
      expect(getHookCount("agent_end")).toBe(0);
    });

    it("should return total count when no type specified", () => {
      registerHook("message_received", vi.fn());
      registerHook("agent_start", vi.fn());
      registerHook("agent_end", vi.fn());

      expect(getHookCount()).toBe(3);
    });
  });

  describe("emit functions", () => {
    describe("emitMessageReceived", () => {
      it("should emit message_received event", async () => {
        const handler = vi.fn();
        registerHook("message_received", handler);

        const context: InboundMessageContext = {
          channelId: "feishu",
          chatId: "chat-123",
          chatType: "private",
          senderId: "user-456",
          senderName: "Test User",
          messageId: "msg-789",
          messageType: "text",
          content: "Hello",
          timestamp: Date.now(),
        };

        emitMessageReceived(context);

        // Wait for async trigger
        await new Promise((r) => setTimeout(r, 10));

        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "message_received",
            context,
          })
        );
      });
    });

    describe("emitMessageSending", () => {
      it("should emit message_sending event", async () => {
        const handler = vi.fn();
        registerHook("message_sending", handler);

        emitMessageSending({
          channelId: "dingtalk",
          chatId: "chat-123",
          content: "Response message",
          sessionKey: "session-key",
        });

        await new Promise((r) => setTimeout(r, 10));

        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "message_sending",
            channelId: "dingtalk",
            chatId: "chat-123",
            content: "Response message",
          })
        );
      });
    });

    describe("emitAgentStart", () => {
      it("should emit agent_start event", async () => {
        const handler = vi.fn();
        registerHook("agent_start", handler);

        emitAgentStart({
          provider: "kimi",
          model: "moonshot-v1-128k",
          messages: [{ role: "user", content: "Hello" }],
          sessionKey: "session-123",
        });

        await new Promise((r) => setTimeout(r, 10));

        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "agent_start",
            provider: "kimi",
            model: "moonshot-v1-128k",
          })
        );
      });
    });

    describe("emitAgentEnd", () => {
      it("should emit agent_end event", async () => {
        const handler = vi.fn();
        registerHook("agent_end", handler);

        emitAgentEnd({
          provider: "zhipu",
          model: "glm-4",
          response: "Hello, I'm an AI assistant.",
          usage: {
            promptTokens: 10,
            completionTokens: 20,
            totalTokens: 30,
          },
          durationMs: 500,
        });

        await new Promise((r) => setTimeout(r, 10));

        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "agent_end",
            provider: "zhipu",
            model: "glm-4",
            response: "Hello, I'm an AI assistant.",
            durationMs: 500,
          })
        );
      });
    });

    describe("emitToolStart", () => {
      it("should emit tool_start event", async () => {
        const handler = vi.fn();
        registerHook("tool_start", handler);

        emitToolStart({
          toolName: "web_search",
          toolCallId: "call-123",
          arguments: { query: "test query" },
        });

        await new Promise((r) => setTimeout(r, 10));

        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "tool_start",
            toolName: "web_search",
            toolCallId: "call-123",
          })
        );
      });
    });

    describe("emitToolEnd", () => {
      it("should emit tool_end event", async () => {
        const handler = vi.fn();
        registerHook("tool_end", handler);

        emitToolEnd({
          toolName: "bash",
          toolCallId: "call-456",
          result: { output: "command output" },
          isError: false,
          durationMs: 100,
        });

        await new Promise((r) => setTimeout(r, 10));

        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "tool_end",
            toolName: "bash",
            isError: false,
            durationMs: 100,
          })
        );
      });

      it("should handle error result", async () => {
        const handler = vi.fn();
        registerHook("tool_end", handler);

        emitToolEnd({
          toolName: "bash",
          toolCallId: "call-789",
          result: { error: "Command failed" },
          isError: true,
          durationMs: 50,
        });

        await new Promise((r) => setTimeout(r, 10));

        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "tool_end",
            isError: true,
          })
        );
      });
    });

    describe("emitError", () => {
      it("should emit error event", async () => {
        const handler = vi.fn();
        registerHook("error", handler);

        const error = new Error("Test error");
        emitError(error, "test context");

        await new Promise((r) => setTimeout(r, 10));

        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            error,
            context: "test context",
          })
        );
      });

      it("should handle error without context", async () => {
        const handler = vi.fn();
        registerHook("error", handler);

        const error = new Error("Another error");
        emitError(error);

        await new Promise((r) => setTimeout(r, 10));

        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            error,
          })
        );
      });
    });
  });

  describe("event structure", () => {
    it("should include timestamp in all events", async () => {
      const handler = vi.fn();
      registerHook("agent_start", handler);

      const before = Date.now();

      emitAgentStart({
        provider: "deepseek",
        model: "deepseek-flash",
        messages: [],
      });

      await new Promise((r) => setTimeout(r, 10));

      const after = Date.now();

      expect(handler).toHaveBeenCalled();
      const event = handler.mock.calls[0][0] as HookEvent;
      expect(event.timestamp).toBeGreaterThanOrEqual(before);
      expect(event.timestamp).toBeLessThanOrEqual(after);
    });

    it("should include sessionKey when provided", async () => {
      const handler = vi.fn();
      registerHook("agent_start", handler);

      emitAgentStart({
        provider: "deepseek",
        model: "deepseek-flash",
        messages: [],
        sessionKey: "my-session-key",
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "my-session-key",
        })
      );
    });
  });
});
