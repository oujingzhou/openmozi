/**
 * Web 控制台配置读写
 *
 * 与传输层解耦：这些函数只处理配置的脱敏、校验、合并与落盘。
 */

import { dirname } from "path";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import json5 from "json5";
import type { MoziConfig, ProviderId } from "../types/index.js";
import { getActiveConfigPath } from "../config/index.js";
import { getChildLogger } from "../utils/logger.js";
import type {
  ConfigInfo,
  ConfigSaveParams,
  ConfigValidateResult,
  ProviderConfigInfo,
  ChannelConfigInfo,
} from "./types.js";

const logger = getChildLogger("web.config");
  /** 获取配置信息（脱敏） */
export function getConfigInfo(config: MoziConfig): ConfigInfo {
    // 提供商信息（脱敏 API Key）
    const providers: Record<string, ConfigInfo["providers"][string]> = {};
    for (const [id, provider] of Object.entries(config.providers)) {
      const record = provider as Record<string, unknown>;
      const models = Array.isArray(record.models)
        ? (record.models as Array<Record<string, unknown>>).map((model) => ({
            id: String(model.id ?? ""),
            name: typeof model.name === "string" ? model.name : undefined,
            contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined,
            maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : undefined,
            supportsVision: typeof model.supportsVision === "boolean" ? model.supportsVision : undefined,
            supportsReasoning: typeof model.supportsReasoning === "boolean" ? model.supportsReasoning : undefined,
          }))
        : undefined;

      providers[id] = {
        id,
        name: typeof record.name === "string" ? record.name : id,
        baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : undefined,
        hasApiKey: Boolean(record.apiKey),
        groupId: typeof record.groupId === "string" ? record.groupId : undefined,
        ...(models && models.length > 0 ? { models } : {}),
      };
    }

    // 通道信息（脱敏敏感字段）
    const channels: Record<string, ConfigInfo["channels"][string]> = {};
    const channelNames: Record<string, string> = {
      feishu: "飞书",
      dingtalk: "钉钉",
      qq: "QQ",
      wecom: "企业微信",
    };
    for (const [id, channel] of Object.entries(config.channels)) {
      if (channel) {
        const hasConfig = (
          // 飞书
          (id === "feishu" && ((channel as any).appId || (channel as any).appSecret)) ||
          // 钉钉
          (id === "dingtalk" && ((channel as any).appKey || (channel as any).appSecret || (channel as any).robotCode)) ||
          // QQ
          (id === "qq" && ((channel as any).appId || (channel as any).clientSecret)) ||
          // 企业微信
          (id === "wecom" && ((channel as any).corpId || (channel as any).corpSecret || (channel as any).agentId || (channel as any).token || (channel as any).encodingAESKey))
        );
        const channelConfig: ConfigInfo["channels"][string] = {
          id,
          name: channelNames[id] || id,
          hasConfig,
          enabled: hasConfig && ((channel as any).enabled ?? true),
        };
        // 添加非敏感字段用于编辑
        if (id === "feishu") {
          (channelConfig as any).appId = (channel as any).appId;
          // appSecret 不返回
        } else if (id === "dingtalk") {
          (channelConfig as any).appKey = (channel as any).appKey;
          (channelConfig as any).robotCode = (channel as any).robotCode;
        } else if (id === "qq") {
          (channelConfig as any).appId = (channel as any).appId;
          (channelConfig as any).sandbox = (channel as any).sandbox;
          // clientSecret 不返回
        } else if (id === "wecom") {
          (channelConfig as any).corpId = (channel as any).corpId;
          (channelConfig as any).agentId = (channel as any).agentId;
          (channelConfig as any).token = (channel as any).token;
          (channelConfig as any).encodingAESKey = (channel as any).encodingAESKey;
          // corpSecret 不返回
        }
        channels[id] = channelConfig;
      }
    }

    // Agent 配置
    const agent = {
      defaultProvider: config.agent.defaultProvider,
      defaultModel: config.agent.defaultModel,
      maxTokens: config.agent.maxTokens,
      systemPrompt: config.agent.systemPrompt,
      thinkingLevel: config.agent.thinkingLevel,
    };

    // 服务器配置
    const server = {
      port: config.server.port,
      host: config.server.host || "0.0.0.0",
    };

    // 日志配置
    const logging = {
      level: config.logging.level,
    };

    // 记忆系统配置
    const memory = {
      enabled: config.memory?.enabled,
      directory: config.memory?.directory,
      embeddingModel: config.memory?.embeddingModel,
      embeddingProvider: config.memory?.embeddingProvider,
    };

    // Skills 配置
    const skills = {
      enabled: config.skills?.enabled,
      userDir: config.skills?.userDir,
      workspaceDir: config.skills?.workspaceDir,
      disabled: config.skills?.disabled,
      only: config.skills?.only,
    };

    return {
      providers,
      channels,
      agent,
      server,
      logging,
      memory: memory as ConfigInfo["memory"],
      skills: skills as ConfigInfo["skills"],
    };
  }

  /** 验证配置 */
export function validateConfig(params: ConfigSaveParams): ConfigValidateResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 验证提供商
    if (params.providers) {
      let hasApiKey = false;
      for (const [id, p] of Object.entries(params.providers)) {
        if (p.hasApiKey) {
          hasApiKey = true;
        }
        // 验证自定义 OpenAI/Anthropic 需要 baseUrl
        if (p.hasApiKey && (id === "custom-openai" || id === "custom-anthropic")) {
          if (!p.baseUrl) {
            errors.push(`${id} 需要 baseUrl 配置`);
          }
        }
      }
      if (!hasApiKey && Object.keys(params.providers).length > 0) {
        warnings.push("没有配置任何 API Key，将无法使用模型功能");
      }
    }

    // 验证通道
    if (params.channels) {
      for (const [id, c] of Object.entries(params.channels)) {
        if (c.hasConfig) {
          if (id === "feishu" && !c.appId) {
            errors.push("飞书需要 App ID");
          }
          if (id === "dingtalk" && !c.appKey) {
            errors.push("钉钉需要 App Key");
          }
          if (id === "qq" && !c.appId) {
            errors.push("QQ 需要 App ID");
          }
          if (id === "wecom" && !c.corpId) {
            errors.push("企业微信需要 Corp ID");
          }
        }
      }
    }

    // 验证 Agent 配置
    if (params.agent) {
      const validProviders = [
        "deepseek", "doubao", "minimax", "kimi", "stepfun", "modelscope",
        "dashscope", "zhipu", "openai", "ollama", "openrouter",
        "together", "groq", "custom-openai", "custom-anthropic",
      ];
      if (params.agent.defaultProvider && !validProviders.includes(params.agent.defaultProvider)) {
        errors.push(`无效的提供商: ${params.agent.defaultProvider}`);
      }
      if (params.agent.maxTokens !== undefined && params.agent.maxTokens < 1) {
        errors.push("maxTokens 必须大于 0");
      }
    }

    // 验证服务器配置
    if (params.server) {
      const port = params.server.port;
      if (port !== undefined && (port < 1 || port > 65535)) {
        errors.push("端口必须在 1 到 65535 之间");
      }
    }

    // 验证日志配置
    if (params.logging) {
      const validLevels = ["debug", "info", "warn", "error"];
      if (params.logging.level && !validLevels.includes(params.logging.level)) {
        errors.push(`无效的日志级别: ${params.logging.level}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /** 保存配置到文件 */
export async function saveConfig(
  params: ConfigSaveParams,
  current: MoziConfig
): Promise<{ success: boolean; message: string; requiresRestart?: boolean }> {
    // 写回实际加载的那个文件，而不是固定的默认路径
    const configPath = getActiveConfigPath();
    const moziDir = dirname(configPath);

    // 验证配置
    const validation = validateConfig(params);
    if (!validation.valid) {
      return {
        success: false,
        message: "配置验证失败: " + validation.errors.join("; "),
      };
    }

    // 先读取现有配置，然后合并
    let existingConfig: Partial<MoziConfig> = {};
    if (existsSync(configPath)) {
      try {
        existingConfig = json5.parse(readFileSync(configPath, "utf-8"));
      } catch (e) {
        logger.warn({ error: e }, "Failed to parse existing config, creating new");
      }
    }

    // 构建要保存的配置
    const configToSave: Partial<MoziConfig> = { ...existingConfig };

    // 更新提供商
    if (params.providers) {
      const providers: MoziConfig["providers"] = {};
      // 保留原有的未修改的提供商
      if (existingConfig.providers) {
        for (const [id, p] of Object.entries(existingConfig.providers)) {
          if (id && p) {
            providers[id] = p;
          }
        }
      }
      // 更新/添加新的提供商
      for (const [id, p] of Object.entries(params.providers)) {
        if (!id || !p.hasApiKey) {
          // 删除提供商
          delete providers[id];
          continue;
        }
        // 以现有配置为基底，避免丢掉 UI 没有暴露的字段（models / headers / compat）
        const existing = (existingConfig.providers as any)?.[id];
        const merged: Record<string, unknown> = {
          ...existing,
          ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
          ...(p.name ? { name: p.name } : {}),
          ...(p.id ? { id: p.id } : {}),
          ...(p.groupId ? { groupId: p.groupId } : {}),
          // 逐条按 id 合并，保留 UI 没有暴露的字段（compat / supports* 等）
          ...(p.models && p.models.length > 0
            ? {
                models: p.models.map((model) => {
                  const previous = Array.isArray(existing?.models)
                    ? (existing.models as Array<Record<string, unknown>>).find((item) => item.id === model.id)
                    : undefined;
                  return { ...previous, ...model };
                }),
              }
            : {}),
          ...(p.headers && Object.keys(p.headers).length > 0 ? { headers: p.headers } : {}),
        };
        // 优先使用前端发送的 apiKey（新增/修改时），否则保留原有 apiKey
        const apiKey = (p as any).apiKey || existing?.apiKey;
        if (apiKey) merged.apiKey = apiKey;
        providers[id] = merged as any;
      }
      configToSave.providers = providers;
    }

    // 更新通道
    if (params.channels) {
      const channels: MoziConfig["channels"] = {
        feishu: existingConfig.channels?.feishu,
        dingtalk: existingConfig.channels?.dingtalk,
        qq: existingConfig.channels?.qq,
        wecom: existingConfig.channels?.wecom,
      };

      for (const [id, c] of Object.entries(params.channels)) {
        if (!c.hasConfig) {
          // 删除通道配置
          delete (channels as any)[id];
          continue;
        }
        const existing = (existingConfig.channels as any)?.[id];
        (channels as any)[id] = {
          ...existing,
          enabled: c.enabled,
          ...(c.appId && { appId: c.appId }),
          ...(c.appSecret && { appSecret: c.appSecret }),
          ...(c.appKey && { appKey: c.appKey }),
          ...(c.corpId && { corpId: c.corpId }),
          ...(c.corpSecret && { corpSecret: c.corpSecret }),
          ...(c.agentId && { agentId: c.agentId }),
          ...(c.token && { token: c.token }),
          ...(c.encodingAESKey && { encodingAESKey: c.encodingAESKey }),
          ...(c.clientSecret && { clientSecret: c.clientSecret }),
          ...(c.verificationToken && { verificationToken: c.verificationToken }),
          ...(c.encryptKey && { encryptKey: c.encryptKey }),
          ...(c.sandbox !== undefined && { sandbox: c.sandbox }),
          ...(c.robotCode && { robotCode: c.robotCode }),
        };
      }
      configToSave.channels = channels;
    }

    // 更新 Agent 配置
    if (params.agent) {
      configToSave.agent = {
        ...existingConfig.agent,
        ...params.agent,
        defaultProvider: (params.agent.defaultProvider as ProviderId) || existingConfig.agent?.defaultProvider || "deepseek",
        // 表单没填模型时沿用原值：写空字符串会让下一次启动无法解析模型
        defaultModel:
          params.agent.defaultModel?.trim() || existingConfig.agent?.defaultModel || current.agent.defaultModel,
      };
    }

    // 更新服务器配置
    if (params.server) {
      configToSave.server = {
        ...existingConfig.server,
        ...params.server,
        port: params.server.port ?? existingConfig.server?.port ?? current.server.port,
      };
    }

    // 更新日志配置
    if (params.logging) {
      configToSave.logging = {
        ...existingConfig.logging,
        ...params.logging,
        level: params.logging.level ?? existingConfig.logging?.level ?? current.logging.level,
      };
    }

    // 更新记忆系统配置
    if (params.memory) {
      configToSave.memory = {
        ...existingConfig.memory,
        ...params.memory,
        embeddingProvider: params.memory.embeddingProvider as ProviderId | undefined,
      };
    }

    // 更新 Skills 配置
    if (params.skills) {
      configToSave.skills = {
        ...existingConfig.skills,
        ...params.skills,
      };
    }

    // 确保目录存在
    if (!existsSync(moziDir)) {
      mkdirSync(moziDir, { recursive: true });
    }

    // 生成 JSON5 格式
    const json5Content = generateJson5(configToSave);

    // 写入文件
    writeFileSync(configPath, json5Content, "utf-8");

    logger.info({ configPath }, "Configuration saved");

    // 检查是否需要重启
    let requiresRestart = false;
    if (params.server?.port !== undefined && params.server.port !== current.server.port) {
      requiresRestart = true;
    }
    if (params.channels) {
      // 如果新增或删除了通道，需要重启
      for (const [id, c] of Object.entries(params.channels)) {
        const existingHasConfig = Boolean((existingConfig.channels as any)?.[id]);
        if (c.hasConfig !== existingHasConfig) {
          requiresRestart = true;
          break;
        }
      }
    }

    return {
      success: true,
      message: "配置已保存" + (requiresRestart ? "，需要重启服务才能生效" : ""),
      requiresRestart,
    };
  }

  /** 生成 JSON5 格式的配置字符串 */
function generateJson5(obj: unknown, indent = 0): string {
    const spaces = "  ".repeat(indent);
    const innerSpaces = "  ".repeat(indent + 1);

    if (obj === null || obj === undefined) {
      return "null";
    }

    if (typeof obj === "string") {
      return `"${obj.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }

    if (typeof obj === "number" || typeof obj === "boolean") {
      return String(obj);
    }

    if (Array.isArray(obj)) {
      if (obj.length === 0) return "[]";
      const items = obj.map((item) => `${innerSpaces}${generateJson5(item, indent + 1)}`);
      return `[\n${items.join(",\n")}\n${spaces}]`;
    }

    if (typeof obj === "object") {
      const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return "{}";

      const items = entries.map(([key, value]) => {
        // 使用不带引号的 key（如果是有效的 ECMAScript 标识符）
        const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : `"${key}"`;
        return `${innerSpaces}${safeKey}: ${generateJson5(value, indent + 1)}`;
      });

      return `{\n${items.join(",\n")}\n${spaces}}`;
    }

    return String(obj);
  }
