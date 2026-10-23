/**
 * Web 模块类型定义
 *
 * 协议对齐 deepseek-harness 的思路：
 * - 命令走 request/response，业务错误用 ok:false 而不是连接错误。
 * - 服务端推送分为"快照"与"增量事件"，增量事件带 seq，客户端据此检测缺口。
 * - 订阅按 sessionKey 精确投递，一个连接可以同时观察多个会话。
 */

import type { DurableSessionSnapshot, SequencedLiveEvent } from "../durable/types.js";

/** WebSocket 请求帧 */
export interface WsRequestFrame {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
}

/** WebSocket 响应帧 */
export interface WsResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** WebSocket 事件帧 */
export interface WsEventFrame {
  type: "event";
  event: string;
  payload?: unknown;
}

/** WebSocket 帧类型 */
export type WsFrame = WsRequestFrame | WsResponseFrame | WsEventFrame;

/** 聊天发送参数 */
export interface ChatSendParams {
  message: string;
  /** 幂等键；同一会话内重复提交返回同一回合 */
  requestId?: string;
  sessionKey?: string;
  /** 回合运行期间的行为：followUp=排队等待，steer=中断当前回合立即执行 */
  whenBusy?: "steer" | "followUp";
}

/** 会话列表请求参数 */
export interface SessionsListParams {
  limit?: number;
  activeMinutes?: number;
  search?: string;
}

/** 会话历史请求参数 */
export interface SessionsHistoryParams {
  sessionKey: string;
}

/** 会话删除请求参数 */
export interface SessionsDeleteParams {
  sessionKey: string;
}

/** 会话重置请求参数 */
export interface SessionsResetParams {
  sessionKey: string;
}

/** 恢复会话请求参数 */
export interface SessionsRestoreParams {
  sessionKey: string;
}

/** 订阅会话事件 */
export interface SessionsSubscribeParams {
  sessionKeys: string[];
}

/** 聊天流事件（旧协议保留，供纯文本通道使用） */
export interface ChatDeltaEvent {
  sessionId: string | null;
  delta: string;
  done: boolean;
  cancelled?: boolean;
}

/** 会话信息 */
export interface SessionInfo {
  sessionKey: string;
  sessionId: string;
  messageCount?: number;
  totalTokens?: number;
  model?: string;
  label?: string;
  updatedAt?: number;
}

/** 系统状态 */
export interface SystemStatus {
  version: string;
  uptime: number;
  providers: Array<{ id: string; name: string; available: boolean }>;
  channels: Array<{ id: string; name: string; connected: boolean }>;
  sessions: number;
  /** durable 日志目录 */
  durableDir: string;
}

/** 提供商配置信息（脱敏） */
export interface ProviderConfigInfo {
  id: string;
  name: string;
  baseUrl?: string;
  hasApiKey: boolean;
  groupId?: string;
  /** 自定义提供商的模型列表（不含任何密钥） */
  models?: Array<{
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    supportsVision?: boolean;
    supportsReasoning?: boolean;
  }>;
}

/** 通道配置信息（脱敏） */
export interface ChannelConfigInfo {
  id: string;
  name: string;
  hasConfig: boolean;
  enabled: boolean;
  appId?: string;
  appKey?: string;
  corpId?: string;
  agentId?: number;
  token?: string;
  encodingAESKey?: string;
  robotCode?: string;
  sandbox?: boolean;
  verificationToken?: string;
  encryptKey?: string;
  appSecret?: string;
  corpSecret?: string;
  clientSecret?: string;
}

/** Agent 配置信息 */
export interface AgentConfigInfo {
  defaultProvider: string;
  defaultModel: string;
  maxTokens?: number;
  systemPrompt?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

/** 服务器配置信息 */
export interface ServerConfigInfo {
  port: number;
  host: string;
}

/** 日志配置信息 */
export interface LoggingConfigInfo {
  level: "debug" | "info" | "warn" | "error";
}

/** 记忆系统配置信息 */
export interface MemoryConfigInfo {
  enabled?: boolean;
  directory?: string;
  embeddingModel?: string;
  embeddingProvider?: string;
}

/** Skills 配置信息 */
export interface SkillsConfigInfo {
  enabled?: boolean;
  userDir?: string;
  workspaceDir?: string;
  disabled?: string[];
  only?: string[];
}

/** 配置信息 */
export interface ConfigInfo {
  providers: Record<string, ProviderConfigInfo>;
  channels: Record<string, ChannelConfigInfo>;
  agent: AgentConfigInfo;
  server: ServerConfigInfo;
  logging: LoggingConfigInfo;
  memory?: MemoryConfigInfo;
  skills?: SkillsConfigInfo;
}

/** 保存配置请求参数 */
export interface ConfigSaveParams {
  providers?: Record<
    string,
    ProviderConfigInfo & {
      apiKey?: string;
      /** 自定义提供商的模型列表；内置 provider 不需要 */
      models?: Array<{
        id: string;
        name?: string;
        contextWindow?: number;
        maxTokens?: number;
        supportsVision?: boolean;
        supportsReasoning?: boolean;
        compat?: Record<string, unknown>;
      }>;
      headers?: Record<string, string>;
    }
  >;
  channels?: Record<string, ChannelConfigInfo>;
  agent?: Partial<AgentConfigInfo>;
  server?: Partial<ServerConfigInfo>;
  logging?: Partial<LoggingConfigInfo>;
  memory?: MemoryConfigInfo;
  skills?: SkillsConfigInfo;
}

/** 配置验证结果 */
export interface ConfigValidateResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** 会话快照事件 */
export interface SessionSnapshotEvent {
  sessionKey: string;
  snapshot: DurableSessionSnapshot;
}

/** 订阅确认 */
export interface SessionSubscribedEvent {
  sessionKey: string;
  lastSeq: number;
}

/** 会话运行状态 */
export interface SessionStatusEvent {
  sessionKey: string;
  running: boolean;
}

/** 供 UI 使用的实时事件类型 */
export type { SequencedLiveEvent };
