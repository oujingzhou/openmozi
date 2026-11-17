/**
 * Model Resolver - 将 mozi 配置映射为 pi-ai 的 Model 对象
 */

import type { Model, Api, Provider } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
import { CHINA_PROVIDER_IDS, type ProviderId, type SimpleProviderConfig, type MoziConfig, type ModelDefinition } from "../types/index.js";
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
  // MiniMax 原生 /text/chatcompletion_v2 已废弃：pi-ai 会再拼 /chat/completions，必须用 OpenAI 兼容根路径
  minimax: "https://api.minimax.cn/v1",
  modelscope: "https://api-inference.modelscope.cn/v1",
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
};

/**
 * 中国 provider 的默认模型定义
 *
 * 规格取自各家官方文档（2026-11 核对）：
 * - contextWindow = 上下文窗口；maxTokens = 单次请求的输出上限
 * - supportsVision 指该「模型 ID + 该端点」能否直接吃图片
 */
const CHINA_PROVIDER_MODELS: Record<string, ModelDefinition[]> = {
  deepseek: [
    // V4.1-Flash-1017：1M 上下文 / 384K 输出 / 原生多模态；thinking 默认开启，reasoning_effort 取 none|low|high|max
    { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", provider: "deepseek", api: "openai-compatible", contextWindow: 1000000, maxTokens: 393216, supportsVision: true, supportsReasoning: true },
    // V4-Pro-0813：旗舰推理，不支持视觉
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", provider: "deepseek", api: "openai-compatible", contextWindow: 1000000, maxTokens: 393216, supportsVision: false, supportsReasoning: true },
  ],
  kimi: [
    // K3 系列：1M 上下文，始终思考，reasoning_effort 取 low|high|max，默认 131072 输出
    { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro", provider: "kimi", api: "openai-compatible", contextWindow: 1048576, maxTokens: 131072, supportsVision: true, supportsReasoning: true },
    { id: "kimi-k3.1-pro-highspeed", name: "Kimi K3.1 Pro Highspeed", provider: "kimi", api: "openai-compatible", contextWindow: 1048576, maxTokens: 131072, supportsVision: true, supportsReasoning: true },
    { id: "kimi-k3", name: "Kimi K3", provider: "kimi", api: "openai-compatible", contextWindow: 1048576, maxTokens: 131072, supportsVision: true, supportsReasoning: true },
  ],
  stepfun: [
    // Step 5 Preview：旗舰基模，1M 上下文 / 64K 输出，文本+图片+视频
    { id: "step-5-preview", name: "Step 5 Preview", provider: "stepfun", api: "openai-compatible", contextWindow: 1000000, maxTokens: 65536, supportsVision: true, supportsReasoning: true },
    // Step 3.7 Flash：多模态推理，256K 上下文
    { id: "step-3.7-flash", name: "Step 3.7 Flash", provider: "stepfun", api: "openai-compatible", contextWindow: 262144, maxTokens: 262144, supportsVision: true, supportsReasoning: true },
    { id: "step-3.5-flash", name: "Step 3.5 Flash", provider: "stepfun", api: "openai-compatible", contextWindow: 262144, maxTokens: 65536, supportsVision: false, supportsReasoning: true },
    { id: "step-1o-turbo-vision", name: "Step-1o Turbo Vision", provider: "stepfun", api: "openai-compatible", contextWindow: 32768, maxTokens: 8192, supportsVision: true, supportsReasoning: false },
  ],
  minimax: [
    // M3.1-Flash：1M 上下文，输出上限 512K，思考不可关闭，reasoning_effort 取 low..max
    { id: "MiniMax-M3.1-Flash", name: "MiniMax M3.1 Flash", provider: "minimax", api: "openai-compatible", contextWindow: 1000000, maxTokens: 524288, supportsVision: true, supportsReasoning: true },
    { id: "MiniMax-M3", name: "MiniMax M3", provider: "minimax", api: "openai-compatible", contextWindow: 1000000, maxTokens: 524288, supportsVision: true, supportsReasoning: true },
  ],
  modelscope: [
    // 取自 API-Inference /v1/models 现行列表。免费推理未公开逐模型输出上限，统一取保守值。
    { id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", name: "DeepSeek V4.1 Flash (ModelScope)", provider: "modelscope", api: "openai-compatible", contextWindow: 1000000, maxTokens: 32768, supportsVision: false, supportsReasoning: true },
    { id: "Qwen/Qwen3.5-397B-A17B", name: "Qwen3.5 397B (ModelScope)", provider: "modelscope", api: "openai-compatible", contextWindow: 262144, maxTokens: 32768, supportsVision: true, supportsReasoning: true },
    { id: "moonshotai/Kimi-K3.1-Pro", name: "Kimi K3.1 Pro (ModelScope)", provider: "modelscope", api: "openai-compatible", contextWindow: 1048576, maxTokens: 32768, supportsVision: true, supportsReasoning: true },
    { id: "MiniMax/MiniMax-M3", name: "MiniMax M3 (ModelScope)", provider: "modelscope", api: "openai-compatible", contextWindow: 1000000, maxTokens: 32768, supportsVision: true, supportsReasoning: true },
    { id: "ZhipuAI/GLM-5.2", name: "GLM-5.2 (ModelScope)", provider: "modelscope", api: "openai-compatible", contextWindow: 1000000, maxTokens: 32768, supportsVision: false, supportsReasoning: true },
  ],
  dashscope: [
    // qwen4-max：1M 上下文，思考模式输出上限 262144，文本/图片/视频
    { id: "qwen4-max", name: "Qwen4 Max", provider: "dashscope", api: "openai-compatible", contextWindow: 1000000, maxTokens: 262144, supportsVision: true, supportsReasoning: true },
    { id: "qwen3.7-plus", name: "Qwen3.7 Plus", provider: "dashscope", api: "openai-compatible", contextWindow: 1000000, maxTokens: 131072, supportsVision: true, supportsReasoning: true },
    { id: "qwen3.8-flash", name: "Qwen3.8 Flash", provider: "dashscope", api: "openai-compatible", contextWindow: 1000000, maxTokens: 131072, supportsVision: true, supportsReasoning: true },
  ],
  zhipu: [
    // GLM-5.3：旗舰，纯文本，1M 上下文 / 128K 输出，思考强制开启（reasoning_effort 取 low|high|max）
    { id: "glm-5.3", name: "GLM-5.3", provider: "zhipu", api: "openai-compatible", contextWindow: 1000000, maxTokens: 131072, supportsVision: false, supportsReasoning: true },
    // GLM-5.3-Flash：原生多模态，1M 上下文 / 128K 输出
    { id: "glm-5.3-flash", name: "GLM-5.3 Flash", provider: "zhipu", api: "openai-compatible", contextWindow: 1000000, maxTokens: 131072, supportsVision: true, supportsReasoning: true },
    { id: "glm-4.7", name: "GLM-4.7", provider: "zhipu", api: "openai-compatible", contextWindow: 204800, maxTokens: 131072, supportsVision: false, supportsReasoning: true },
    { id: "glm-4.7-flash", name: "GLM-4.7 Flash (Free)", provider: "zhipu", api: "openai-compatible", contextWindow: 204800, maxTokens: 131072, supportsVision: false, supportsReasoning: true },
  ],
};

/**
 * 中国 provider 的 OpenAI 兼容层差异。
 *
 * pi-ai 只按 baseUrl 自动探测少数几家（deepseek.com / api.z.ai …），其余会默认发出
 * `store`、`developer` 角色和 `max_completion_tokens`，这些国产端点大多不认（Kimi 文档
 * 明确 role 仅支持 system/user/assistant/tool）。这里逐家钉死，避免 400。
 * reasoningEffortMap 把 pi-ai 的档位收敛到各家文档里的合法取值；额外处理 "off"
 * （会话标题生成会显式传 off，pi-ai 类型里没有该档位，不映射就会原样发出被 400 拒绝）。
 */
const CHINA_PROVIDER_COMPAT: Record<string, Record<string, unknown>> = {
  deepseek: {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
    // 文档：none|low|high|max，minimal→low、medium/xhigh→high；off 可直接关闭思考
    reasoningEffortMap: { off: "none", minimal: "low", low: "low", medium: "high", high: "high", xhigh: "high" },
  },
  kimi: {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: "max_completion_tokens",
    // K3 始终思考：low|high|max（默认 max），thinking 不可关闭，off 只能压到最低档
    reasoningEffortMap: { off: "low", minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max" },
  },
  stepfun: {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
    reasoningEffortMap: { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" },
  },
  minimax: {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: "max_completion_tokens",
    reasoningEffortMap: { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
  },
  modelscope: {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
    // 免费聚合端点未公开逐模型的 reasoning_effort 取值，宁可不发也不要发错：
    // 关掉该字段后思考强度由各模型自身的默认值决定。
    supportsReasoningEffort: false,
  },
  dashscope: {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
    // qwen4-max 文档：low|high|xhigh，minimal→low、medium→high、max→xhigh
    // qwen4-max 文档：low|high|xhigh，minimal→low、medium→high、max→xhigh
    reasoningEffortMap: { off: "low", minimal: "low", low: "low", medium: "high", high: "high", xhigh: "xhigh" },
  },
  zhipu: {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
    // GLM-5.3 文档：low|high|max，思考强制开启
    reasoningEffortMap: { off: "low", minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max" },
  },
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
  compat?: Record<string, unknown>,
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
    ...(compat ? { compat } : {}),
  } as Model<"openai-completions">;
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
      CHINA_PROVIDER_COMPAT[providerId],
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
    /** 透传给 pi-ai 的兼容开关，如 reasoningEffortMap */
    compat?: Record<string, unknown>;
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
    const model = buildOpenAIModel(
      m.id,
      modelDef,
      baseUrl,
      "custom-openai",
      headers,
      m.compat as Record<string, unknown> | undefined,
    );
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

  const chinaProviders: readonly string[] = CHINA_PROVIDER_IDS;

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
      const model = buildOpenAIModel(
        modelId,
        dynamicDef,
        baseUrl,
        providerId,
        Object.keys(headers).length > 0 ? headers : undefined,
        CHINA_PROVIDER_COMPAT[providerId],
      );

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
