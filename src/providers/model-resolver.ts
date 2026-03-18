/**
 * Model Resolver - 将 mozi 配置映射为 pi-ai 的 Model 对象
 */

import type { Model, Api, Provider } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
import type { ProviderId, SimpleProviderConfig, MoziConfig, ModelDefinition } from "../types/index.js";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("model-resolver");

/** 已解析的模型信息 */
export interface ResolvedModel {
  model: Model<Api>;
  providerId: ProviderId;
}

/** 模型注册表 */
const modelRegistry = new Map<string, ResolvedModel>();

/** 提供商配置缓存 */
let providerConfigs: Record<string, SimpleProviderConfig> = {};

/** 中国 provider 到默认 baseUrl 的映射 */
const CHINA_PROVIDER_BASE_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1",
  kimi: "https://api.moonshot.cn/v1",
  stepfun: "https://api.stepfun.com/v1",
  doubao: "https://ark.cn-beijing.volces.com/api/v3",
  minimax: "https://api.minimax.chat/v1/text/chatcompletion_v2",
  modelscope: "https://api-inference.modelscope.cn/v1",
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
};

/** 中国 provider 的默认模型定义 */
const CHINA_PROVIDER_MODELS: Record<string, ModelDefinition[]> = {
  deepseek: [
    { id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek", api: "openai-compatible", contextWindow: 64000, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner (R1)", provider: "deepseek", api: "openai-compatible", contextWindow: 64000, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
  ],
  doubao: [
    { id: "doubao-seed-1-8-251228", name: "豆包 Seed 1.8", provider: "doubao", api: "openai-compatible", contextWindow: 262144, maxTokens: 32768, supportsVision: true, supportsReasoning: true },
    { id: "doubao-seed-1-6-lite-251015", name: "豆包 Seed 1.6 Lite", provider: "doubao", api: "openai-compatible", contextWindow: 262144, maxTokens: 32768, supportsVision: true, supportsReasoning: true },
    { id: "doubao-seed-1-6-flash-250828", name: "豆包 Seed 1.6 Flash", provider: "doubao", api: "openai-compatible", contextWindow: 262144, maxTokens: 32768, supportsVision: true, supportsReasoning: true },
  ],
  kimi: [
    { id: "kimi-k2.5", name: "Kimi K2.5", provider: "kimi", api: "openai-compatible", contextWindow: 128000, maxTokens: 65536, supportsVision: true, supportsReasoning: true },
    { id: "kimi-latest", name: "Kimi Latest", provider: "kimi", api: "openai-compatible", contextWindow: 128000, maxTokens: 65536, supportsVision: true, supportsReasoning: false },
    { id: "moonshot-v1-128k", name: "Moonshot V1 128K", provider: "kimi", api: "openai-compatible", contextWindow: 128000, maxTokens: 65536, supportsVision: false, supportsReasoning: false },
  ],
  stepfun: [
    { id: "step-2-mini", name: "Step 2 Mini", provider: "stepfun", api: "openai-compatible", contextWindow: 32000, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
    { id: "step-1-128k", name: "Step 1 128K", provider: "stepfun", api: "openai-compatible", contextWindow: 128000, maxTokens: 65536, supportsVision: false, supportsReasoning: false },
  ],
  minimax: [
    { id: "MiniMax-M2.1", name: "MiniMax M2.1", provider: "minimax", api: "openai-compatible", contextWindow: 1000000, maxTokens: 65536, supportsVision: false, supportsReasoning: true },
    { id: "MiniMax-M1", name: "MiniMax M1", provider: "minimax", api: "openai-compatible", contextWindow: 1000000, maxTokens: 65536, supportsVision: false, supportsReasoning: true },
    { id: "abab6.5s-chat", name: "ABAB 6.5s Chat", provider: "minimax", api: "openai-compatible", contextWindow: 245760, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
  ],
  modelscope: [
    { id: "Qwen/Qwen2.5-72B-Instruct", name: "Qwen 2.5 72B", provider: "modelscope", api: "openai-compatible", contextWindow: 131072, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
    { id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1 (ModelScope)", provider: "modelscope", api: "openai-compatible", contextWindow: 65536, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
    { id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek V3 (ModelScope)", provider: "modelscope", api: "openai-compatible", contextWindow: 65536, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
  ],
  dashscope: [
    { id: "qwen3-235b-a22b", name: "Qwen3 235B (MoE)", provider: "dashscope", api: "openai-compatible", contextWindow: 131072, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
    { id: "qwen3-32b", name: "Qwen3 32B", provider: "dashscope", api: "openai-compatible", contextWindow: 131072, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
    { id: "qwen-max", name: "Qwen Max", provider: "dashscope", api: "openai-compatible", contextWindow: 32768, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
    { id: "qwen-plus", name: "Qwen Plus", provider: "dashscope", api: "openai-compatible", contextWindow: 131072, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
    { id: "qwq-plus", name: "QwQ Plus", provider: "dashscope", api: "openai-compatible", contextWindow: 131072, maxTokens: 16384, supportsVision: false, supportsReasoning: true },
    { id: "deepseek-r1", name: "DeepSeek R1 (DashScope)", provider: "dashscope", api: "openai-compatible", contextWindow: 65536, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
  ],
  zhipu: [
    { id: "glm-z1-plus", name: "GLM-Z1 Plus", provider: "zhipu", api: "openai-compatible", contextWindow: 128000, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
    { id: "glm-z1-flash", name: "GLM-Z1 Flash (Free)", provider: "zhipu", api: "openai-compatible", contextWindow: 128000, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
    { id: "glm-4.7", name: "GLM-4.7", provider: "zhipu", api: "openai-compatible", contextWindow: 128000, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
    { id: "glm-4-plus", name: "GLM-4 Plus", provider: "zhipu", api: "openai-compatible", contextWindow: 128000, maxTokens: 4096, supportsVision: false, supportsReasoning: false },
    { id: "glm-4-flash", name: "GLM-4 Flash (Free)", provider: "zhipu", api: "openai-compatible", contextWindow: 128000, maxTokens: 4096, supportsVision: false, supportsReasoning: false },
    { id: "glm-4v-plus", name: "GLM-4V Plus", provider: "zhipu", api: "openai-compatible", contextWindow: 8192, maxTokens: 1024, supportsVision: true, supportsReasoning: false },
  ],
};

/** 预设 provider 配置 (pi-ai 不内置但常用的) */
const PRESET_PROVIDER_CONFIGS: Record<string, { baseUrl: string; headers?: Record<string, string> }> = {
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    headers: { "HTTP-Referer": "https://github.com/King-Chau/mozi", "X-Title": "Mozi" },
  },
  together: { baseUrl: "https://api.together.xyz/v1" },
  groq: { baseUrl: "https://api.groq.com/openai/v1" },
  ollama: { baseUrl: "http://localhost:11434/v1" },
  vllm: { baseUrl: "http://localhost:8000/v1" },
};

/** pi-ai 已知的 provider 映射 */
const PI_AI_KNOWN_PROVIDERS: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  groq: "groq",
  openrouter: "openrouter",
};

/** 获取 provider 的 API key */
export function getApiKeyForProvider(providerId: string): string | undefined {
  const config = providerConfigs[providerId];
  return config?.apiKey;
}

/** 构建 OpenAI 兼容的 Model 对象 */
function buildOpenAIModel(
  modelId: string,
  modelDef: ModelDefinition,
  baseUrl: string,
  provider: string,
  headers?: Record<string, string>,
): Model<"openai-completions"> {
  return {
    id: modelId,
    name: modelDef.name,
    api: "openai-completions",
    provider: provider as Provider,
    baseUrl,
    reasoning: modelDef.supportsReasoning,
    input: modelDef.supportsVision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelDef.contextWindow,
    maxTokens: modelDef.maxTokens,
    headers,
  };
}

/** 构建 Anthropic 兼容的 Model 对象 */
function buildAnthropicModel(
  modelId: string,
  modelDef: ModelDefinition,
  baseUrl: string,
  provider: string,
  apiVersion?: string,
  headers?: Record<string, string>,
): Model<"anthropic-messages"> {
  return {
    id: modelId,
    name: modelDef.name,
    api: "anthropic-messages",
    provider: provider as Provider,
    baseUrl,
    reasoning: modelDef.supportsReasoning,
    input: modelDef.supportsVision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelDef.contextWindow,
    maxTokens: modelDef.maxTokens,
    headers: {
      "anthropic-version": apiVersion ?? "2023-06-01",
      ...headers,
    },
  };
}

/** 注册中国 provider 的所有模型 */
function registerChinaProvider(
  providerId: string,
  config: SimpleProviderConfig,
): void {
  const defaultBaseUrl = CHINA_PROVIDER_BASE_URLS[providerId];
  if (!defaultBaseUrl) return;

  const baseUrl = config.baseUrl ?? defaultBaseUrl;
  const models = CHINA_PROVIDER_MODELS[providerId];
  if (!models) return;

  for (const modelDef of models) {
    const model = buildOpenAIModel(
      modelDef.id,
      modelDef,
      baseUrl,
      providerId,
      config.headers,
    );
    modelRegistry.set(`${providerId}:${modelDef.id}`, { model, providerId: providerId as ProviderId });
  }

  logger.debug({ providerId, modelCount: models.length }, "China provider registered");
}

/** 注册预设 provider (openrouter, together, groq, ollama, vllm) */
function registerPresetProvider(
  providerId: string,
  config: SimpleProviderConfig,
): void {
  const preset = PRESET_PROVIDER_CONFIGS[providerId];
  if (!preset) return;

  const baseUrl = config.baseUrl ?? preset.baseUrl;
  const headers = { ...preset.headers, ...config.headers };

  // 这些 provider 的模型是动态的，注册一个 placeholder 以便 resolveModel 可以按需创建
  // 不预注册具体模型，由 resolveModel 动态处理
  logger.debug({ providerId, baseUrl }, "Preset provider registered");
}

/** 注册自定义 OpenAI 提供商 */
function registerCustomOpenAI(config: Record<string, unknown>): void {
  const baseUrl = config.baseUrl as string;
  const models = config.models as Array<{
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    supportsVision?: boolean;
    supportsReasoning?: boolean;
  }>;
  const headers = config.headers as Record<string, string> | undefined;

  if (!baseUrl || !models) return;

  for (const m of models) {
    const modelDef: ModelDefinition = {
      id: m.id,
      name: m.name ?? m.id,
      provider: "custom-openai",
      api: "openai-compatible",
      contextWindow: m.contextWindow ?? 128000,
      maxTokens: m.maxTokens ?? 4096,
      supportsVision: m.supportsVision ?? false,
      supportsReasoning: m.supportsReasoning ?? false,
    };
    const model = buildOpenAIModel(m.id, modelDef, baseUrl, "custom-openai", headers);
    modelRegistry.set(`custom-openai:${m.id}`, { model, providerId: "custom-openai" });
  }
}

/** 注册自定义 Anthropic 提供商 */
function registerCustomAnthropic(config: Record<string, unknown>): void {
  const baseUrl = config.baseUrl as string;
  const models = config.models as Array<{
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    supportsVision?: boolean;
  }>;
  const apiVersion = config.apiVersion as string | undefined;
  const headers = config.headers as Record<string, string> | undefined;

  if (!baseUrl || !models) return;

  for (const m of models) {
    const modelDef: ModelDefinition = {
      id: m.id,
      name: m.name ?? m.id,
      provider: "custom-anthropic",
      api: "anthropic",
      contextWindow: m.contextWindow ?? 200000,
      maxTokens: m.maxTokens ?? 8192,
      supportsVision: m.supportsVision ?? false,
      supportsReasoning: false,
    };
    const model = buildAnthropicModel(m.id, modelDef, baseUrl, "custom-anthropic", apiVersion, headers);
    modelRegistry.set(`custom-anthropic:${m.id}`, { model, providerId: "custom-anthropic" });
  }
}

/** 初始化模型解析器 */
export function initModelResolver(config: MoziConfig): void {
  modelRegistry.clear();
  providerConfigs = config.providers as Record<string, SimpleProviderConfig>;

  const chinaProviders = ["deepseek", "doubao", "kimi", "stepfun", "minimax", "modelscope", "dashscope", "zhipu"];

  for (const [id, providerConfig] of Object.entries(providerConfigs)) {
    if (!providerConfig) continue;

    if (chinaProviders.includes(id) && providerConfig.apiKey) {
      registerChinaProvider(id, providerConfig);
    } else if (Object.keys(PRESET_PROVIDER_CONFIGS).includes(id)) {
      registerPresetProvider(id, providerConfig);
    }
  }

  // 自定义 OpenAI
  const customOpenai = config.providers["custom-openai"];
  if (customOpenai && (customOpenai as Record<string, unknown>).apiKey && (customOpenai as Record<string, unknown>).baseUrl) {
    registerCustomOpenAI(customOpenai as Record<string, unknown>);
  }

  // 自定义 Anthropic
  const customAnthropic = config.providers["custom-anthropic"];
  if (customAnthropic && (customAnthropic as Record<string, unknown>).apiKey && (customAnthropic as Record<string, unknown>).baseUrl) {
    registerCustomAnthropic(customAnthropic as Record<string, unknown>);
  }

  // OpenAI (pi-ai 已知)
  if (providerConfigs.openai?.apiKey) {
    // pi-ai 内置了 OpenAI 模型，不需要手动注册
    logger.debug("OpenAI provider available via pi-ai built-in");
  }

  logger.info({ registeredModels: modelRegistry.size }, "Model resolver initialized");
}

/** 解析模型 */
export function resolveModel(providerId: ProviderId, modelId: string): Model<Api> | undefined {
  // 1. 先查本地注册表
  const key = `${providerId}:${modelId}`;
  const registered = modelRegistry.get(key);
  if (registered) {
    return registered.model;
  }

  // 2. 对于 pi-ai 已知的 provider，尝试用 getModel
  const piProvider = PI_AI_KNOWN_PROVIDERS[providerId];
  if (piProvider) {
    try {
      const model = getModel(piProvider as any, modelId as any);
      return model;
    } catch {
      // getModel 不认识这个模型，继续
    }
  }

  // 3. 对于预设 provider 或有 baseUrl 的动态模型，创建 OpenAI 兼容模型
  const config = providerConfigs[providerId];
  if (config) {
    const preset = PRESET_PROVIDER_CONFIGS[providerId];
    const chinaBaseUrl = CHINA_PROVIDER_BASE_URLS[providerId];
    const baseUrl = config.baseUrl ?? preset?.baseUrl ?? chinaBaseUrl;

    if (baseUrl) {
      const dynamicDef: ModelDefinition = {
        id: modelId,
        name: modelId,
        provider: providerId,
        api: "openai-compatible",
        contextWindow: 128000,
        maxTokens: 8192,
        supportsVision: false,
        supportsReasoning: false,
      };
      const headers = { ...preset?.headers, ...config.headers };
      const model = buildOpenAIModel(modelId, dynamicDef, baseUrl, providerId, Object.keys(headers).length > 0 ? headers : undefined);

      // 缓存动态解析的模型
      modelRegistry.set(key, { model, providerId });
      logger.debug({ providerId, modelId, baseUrl }, "Dynamic model resolved");
      return model;
    }
  }

  logger.warn({ providerId, modelId }, "Failed to resolve model");
  return undefined;
}

/** 获取所有已注册模型 */
export function getAllRegisteredModels(): Array<{ provider: ProviderId; modelId: string; model: Model<Api> }> {
  const result: Array<{ provider: ProviderId; modelId: string; model: Model<Api> }> = [];

  for (const [key, resolved] of modelRegistry) {
    const [, modelId] = key.split(":", 2);
    if (modelId) {
      result.push({
        provider: resolved.providerId,
        modelId,
        model: resolved.model,
      });
    }
  }

  return result;
}

/** 检查 provider 是否可用 */
export function isProviderAvailable(providerId: ProviderId): boolean {
  const config = providerConfigs[providerId];
  if (!config) return false;

  // 对需要 API key 的 provider，检查 key 是否存在
  if (providerId === "ollama" || providerId === "vllm") return true;
  return !!config.apiKey;
}
