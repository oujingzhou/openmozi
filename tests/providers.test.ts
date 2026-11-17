/**
 * 模型提供商测试 (基于 model-resolver)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  initializeProviders,
  getAllProviders,
  getAllModels,
  resolveModel,
  getApiKeyForProvider,
  isProviderAvailable,
  hasProvider,
} from "../src/providers/index.js";
import type { OpenAICompletionsCompat } from "@mariozechner/pi-ai";
import { getAllRegisteredModels } from "../src/providers/model-resolver.js";
import type { MoziConfig, ProviderId } from "../src/types/index.js";

function makeConfig(providers: Record<string, any>): MoziConfig {
  return {
    providers,
    channels: {},
    agent: { defaultModel: "test-model", defaultProvider: "deepseek" },
    server: { port: 3000 },
    logging: { level: "error" },
  };
}

describe("providers (model-resolver)", () => {
  beforeEach(() => {
    // 重新初始化，清除之前的注册
    initializeProviders(makeConfig({}));
  });

  describe("initializeProviders", () => {
    it("should initialize without error when no providers configured", () => {
      expect(() => initializeProviders(makeConfig({}))).not.toThrow();
    });

    it("should register china provider models", () => {
      initializeProviders(makeConfig({
        deepseek: { apiKey: "sk-test" },
      }));

      const models = getAllModels();
      const deepseekModels = models.filter((m) => m.provider === "deepseek");
      expect(deepseekModels.length).toBeGreaterThan(0);
    });

    it("should register multiple providers", () => {
      initializeProviders(makeConfig({
        deepseek: { apiKey: "sk-test-1" },
        kimi: { apiKey: "sk-test-2" },
      }));

      const models = getAllModels();
      const deepseekModels = models.filter((m) => m.provider === "deepseek");
      const kimiModels = models.filter((m) => m.provider === "kimi");
      expect(deepseekModels.length).toBeGreaterThan(0);
      expect(kimiModels.length).toBeGreaterThan(0);
    });
  });

  describe("resolveModel", () => {
    it("should resolve registered china provider model", () => {
      initializeProviders(makeConfig({
        deepseek: { apiKey: "sk-test" },
      }));

      const model = resolveModel("deepseek", "deepseek-flash");
      expect(model).toBeDefined();
      expect(model!.id).toBe("deepseek-flash");
      expect(model!.api).toBe("openai-completions");
    });

    it("should return undefined for unknown provider", () => {
      const model = resolveModel("unknown-provider" as any, "some-model");
      expect(model).toBeUndefined();
    });

    it("should dynamically resolve unknown model for known provider", () => {
      initializeProviders(makeConfig({
        deepseek: { apiKey: "sk-test" },
      }));

      const model = resolveModel("deepseek", "deepseek-v999-unknown");
      expect(model).toBeDefined();
      expect(model!.id).toBe("deepseek-v999-unknown");
    });

    it("should use custom baseUrl if provided", () => {
      initializeProviders(makeConfig({
        deepseek: { apiKey: "sk-test", baseUrl: "https://custom.api.com/v1" },
      }));

      const model = resolveModel("deepseek", "deepseek-flash");
      expect(model).toBeDefined();
      expect(model!.baseUrl).toBe("https://custom.api.com/v1");
    });
  });

  describe("getApiKeyForProvider", () => {
    it("should return api key for configured provider", () => {
      initializeProviders(makeConfig({
        deepseek: { apiKey: "sk-my-key" },
      }));

      expect(getApiKeyForProvider("deepseek")).toBe("sk-my-key");
    });

    it("should return undefined for unconfigured provider", () => {
      expect(getApiKeyForProvider("unconfigured" as any)).toBeUndefined();
    });
  });

  describe("isProviderAvailable", () => {
    it("should return true for configured provider with apiKey", () => {
      initializeProviders(makeConfig({
        kimi: { apiKey: "sk-test" },
      }));

      expect(isProviderAvailable("kimi")).toBe(true);
    });

    it("should return false for unconfigured provider", () => {
      expect(isProviderAvailable("kimi")).toBe(false);
    });

    it("should return false for provider without apiKey", () => {
      initializeProviders(makeConfig({
        kimi: {},
      }));

      expect(isProviderAvailable("kimi")).toBe(false);
    });
  });

  describe("getAllProviders", () => {
    it("should return array of provider info", () => {
      initializeProviders(makeConfig({
        deepseek: { apiKey: "sk-test" },
      }));

      const providers = getAllProviders();
      expect(Array.isArray(providers)).toBe(true);
      const ds = providers.find((p) => p.id === "deepseek");
      expect(ds).toBeDefined();
      expect(ds!.name).toBeTruthy();
    });
  });

  describe("getAllModels", () => {
    it("should return empty array when no providers configured", () => {
      initializeProviders(makeConfig({}));
      const models = getAllModels();
      expect(Array.isArray(models)).toBe(true);
    });

    it("should return models with provider and model info", () => {
      initializeProviders(makeConfig({
        zhipu: { apiKey: "sk-test" },
      }));

      const models = getAllModels();
      const zhipuModels = models.filter((m) => m.provider === "zhipu");
      expect(zhipuModels.length).toBeGreaterThan(0);

      for (const m of zhipuModels) {
        expect(m.model).toBeDefined();
        expect(m.model.id).toBeTruthy();
      }
    });
  });

  describe("hasProvider", () => {
    it("should return true for configured provider", () => {
      initializeProviders(makeConfig({
        stepfun: { apiKey: "sk-test" },
      }));

      expect(hasProvider("stepfun")).toBe(true);
    });

    it("should return false for unconfigured provider", () => {
      expect(hasProvider("stepfun")).toBe(false);
    });
  });
  describe("OpenAI 兼容层差异", () => {
    /** 取 OpenAI 兼容模型上的 compat 字段；非 OpenAI 兼容模型返回 undefined。 */
    function compatOf(provider: ProviderId, modelId: string): OpenAICompletionsCompat | undefined {
      const model = resolveModel(provider, modelId);
      return model?.api === "openai-completions" ? model.compat : undefined;
    }

    // 这些端点都不接受 store / developer 角色；Kimi 文档写明 role 仅支持
    // system/user/assistant/tool，发 developer 会 400。
    it("should pin store off and system role for every china provider", () => {
      initializeProviders(makeConfig({
        deepseek: { apiKey: "sk" },
        kimi: { apiKey: "sk" },
        stepfun: { apiKey: "sk" },
        minimax: { apiKey: "sk" },
        modelscope: { apiKey: "sk" },
        dashscope: { apiKey: "sk" },
        zhipu: { apiKey: "sk" },
      }));

      for (const item of getAllRegisteredModels()) {
        const compat = compatOf(item.provider, item.modelId);
        expect(compat?.supportsStore, item.modelId).toBe(false);
        expect(compat?.supportsDeveloperRole, item.modelId).toBe(false);
      }
    });

    it("should use max_completion_tokens only where documented", () => {
      initializeProviders(makeConfig({
        kimi: { apiKey: "sk" },
        minimax: { apiKey: "sk" },
        deepseek: { apiKey: "sk" },
      }));

      expect(compatOf("kimi", "kimi-k3.1-pro")?.maxTokensField).toBe("max_completion_tokens");
      expect(compatOf("minimax", "MiniMax-M3.1-Flash")?.maxTokensField).toBe("max_completion_tokens");
      expect(compatOf("deepseek", "deepseek-flash")?.maxTokensField).toBe("max_tokens");
    });

    it("maps the untyped off effort instead of sending it verbatim", () => {
      initializeProviders(makeConfig({ kimi: { apiKey: "sk" }, deepseek: { apiKey: "sk" } }));

      // 会话标题生成会传 off；不映射就会原样发出 "off" 被服务端拒绝
      expect(compatOf("deepseek", "deepseek-flash")?.reasoningEffortMap?.off).toBe("none");
      expect(compatOf("kimi", "kimi-k3.1-pro")?.reasoningEffortMap?.off).toBe("low");
    });

    it("keeps provider-specific reasoning effort values legal", () => {
      initializeProviders(makeConfig({ zhipu: { apiKey: "sk" }, dashscope: { apiKey: "sk" } }));

      // GLM-5.3 只认 low|high|max；qwen4-max 只认 low|high|xhigh
      const zhipuEfforts = Object.values(compatOf("zhipu", "glm-5.3")?.reasoningEffortMap ?? {});
      const dashscopeEfforts = Object.values(compatOf("dashscope", "qwen4-max")?.reasoningEffortMap ?? {});
      expect(zhipuEfforts.length).toBeGreaterThan(0);
      expect(dashscopeEfforts.length).toBeGreaterThan(0);
      expect(zhipuEfforts.every((v) => v === "low" || v === "high" || v === "max")).toBe(true);
      expect(dashscopeEfforts.every((v) => v === "low" || v === "high" || v === "xhigh")).toBe(true);
    });

    it("does not send reasoning_effort to modelscope", () => {
      initializeProviders(makeConfig({ modelscope: { apiKey: "sk" } }));
      expect(compatOf("modelscope", "deepseek-ai/DeepSeek-V4.1-Flash-1017")?.supportsReasoningEffort).toBe(false);
    });

    it("uses the MiniMax OpenAI-compatible root so pi-ai appends the right path", () => {
      initializeProviders(makeConfig({ minimax: { apiKey: "sk" } }));
      const model = resolveModel("minimax", "MiniMax-M3.1-Flash");
      // pi-ai 会拼成 ${baseUrl}/chat/completions
      expect(model?.baseUrl).toBe("https://api.minimax.cn/v1");
    });
  });
});
