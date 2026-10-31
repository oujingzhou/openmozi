/**
 * Web 控制台配置读写
 *
 * 与传输层解耦：这些函数只处理配置的脱敏、校验、合并与落盘。
 */

import { existsSync, readFileSync } from "fs";
import json5 from "json5";
import { PROVIDER_IDS, type MoziConfig, type ProviderId } from "../types/index.js";
import { getActiveConfigPath, MoziConfigSchema } from "../config/index.js";
import { atomicWriteFile, serializeJson5 } from "../storage/index.js";
import { getChildLogger } from "../utils/logger.js";
import type {
  ConfigInfo,
  ConfigSaveParams,
  ConfigValidateResult,
  ProviderConfigInfo,
  ChannelConfigInfo,
  ChannelSaveInfo,
} from "./types.js";

const logger = getChildLogger("web.config");

/** 读取通道对象上的字段：值来自已解析的配置，这里只做结构读取 */
function readField<T>(source: unknown, key: string): T | undefined {
  if (source === null || typeof source !== "object") return undefined;
  return (source as Record<string, unknown>)[key] as T | undefined;
}
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
      if (!channel) continue;
      const appId = readField<string>(channel, "appId");
      const appSecret = readField<string>(channel, "appSecret");
      const appKey = readField<string>(channel, "appKey");
      const clientSecret = readField<string>(channel, "clientSecret");
      const corpId = readField<string>(channel, "corpId");
      const corpSecret = readField<string>(channel, "corpSecret");
      const agentId = readField<number>(channel, "agentId");
      const token = readField<string>(channel, "token");
      const aesKey = readField<string>(channel, "encodingAESKey");

      const hasConfig = Boolean(
        (id === "feishu" && (appId || appSecret)) ||
          (id === "dingtalk" && (appKey || appSecret || readField<string>(channel, "robotCode"))) ||
          (id === "qq" && (appId || clientSecret)) ||
          (id === "wecom" && (corpId || corpSecret || agentId || token || aesKey))
      );

      const channelConfig: ChannelConfigInfo = {
        id,
        name: channelNames[id] || id,
        hasConfig,
        enabled: hasConfig && (readField<boolean>(channel, "enabled") ?? true),
      };

      // 只回非敏感字段；密钥一律只回"是否已配置"
      if (id === "feishu") {
        channelConfig.appId = appId;
        channelConfig.hasAppSecret = Boolean(appSecret);
        channelConfig.hasVerificationToken = Boolean(readField(channel, "verificationToken"));
        channelConfig.hasEncryptKey = Boolean(readField(channel, "encryptKey"));
      } else if (id === "dingtalk") {
        channelConfig.appKey = appKey;
        channelConfig.robotCode = readField<string>(channel, "robotCode");
        channelConfig.hasAppSecret = Boolean(appSecret);
      } else if (id === "qq") {
        channelConfig.appId = appId;
        channelConfig.sandbox = readField<boolean>(channel, "sandbox");
        channelConfig.hasClientSecret = Boolean(clientSecret);
      } else if (id === "wecom") {
        channelConfig.corpId = corpId;
        channelConfig.agentId = agentId;
        channelConfig.hasCorpSecret = Boolean(corpSecret);
        channelConfig.hasToken = Boolean(token);
        channelConfig.hasEncodingAESKey = Boolean(aesKey);
      }
      channels[id] = channelConfig;
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
      const validProviders: readonly string[] = PROVIDER_IDS;
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
        // 解析失败就拒绝写入：否则会把用户原有配置整体覆盖成空
        logger.error({ error: e, configPath }, "Existing config is unparseable, refusing to overwrite");
        return {
          success: false,
          message: `现有配置文件无法解析（${configPath}），为避免覆盖已有配置已中止保存。请先手工修复该文件。`,
        };
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
      const incoming: Record<string, ChannelSaveInfo> = params.channels;
      const channels: MoziConfig["channels"] = {
        feishu: existingConfig.channels?.feishu,
        dingtalk: existingConfig.channels?.dingtalk,
        qq: existingConfig.channels?.qq,
        wecom: existingConfig.channels?.wecom,
      };

      for (const [id, c] of Object.entries(incoming)) {
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

    // 落盘前用真实 schema 校验合并后的结果：
    // 缺字段/字段非法就拒绝写入，避免写出一个下次启动会炸的文件。
    const parsed = MoziConfigSchema.safeParse(configToSave);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      logger.warn({ error: detail, configPath }, "Merged config rejected by schema");
      return { success: false, message: `配置校验失败，未写入: ${detail}` };
    }

    // 原子写入（tmp → fsync → rename），覆盖前保留 .bak
    atomicWriteFile(configPath, serializeJson5(configToSave), { backup: true });

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
