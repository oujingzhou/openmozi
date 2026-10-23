/**
 * 会话管理类型定义
 * 参考 moltbot 的会话管理系统
 */

import type { ChatMessage } from "../types/index.js";

/** 会话条目 */
export interface SessionEntry {
  /** 会话 ID */
  sessionId: string;
  /** 会话 Key（用于索引） */
  sessionKey: string;
  /** 标签名称（展示用） */
  label?: string;
  /** 标题来源：fallback=首条消息截断，model=模型摘要，user=用户自定义 */
  labelSource?: "fallback" | "model" | "user";
  /** 创建时间 */
  createdAt: number;
  /** 最后更新时间 */
  updatedAt: number;
  /** 转录文件路径 */
  transcriptFile?: string;
  /** 来源渠道 */
  channel?: string;
  /** 消息数量 */
  messageCount?: number;
  /** 输入 token 统计 */
  inputTokens?: number;
  /** 输出 token 统计 */
  outputTokens?: number;
  /** 总 token 统计 */
  totalTokens?: number;
  /** 使用的模型 */
  model?: string;
  /** 使用的提供商 */
  provider?: string;
}

/** 会话列表项（用于前端展示） */
export interface SessionListItem {
  sessionKey: string;
  sessionId: string;
  label?: string;
  updatedAt: number;
  messageCount?: number;
  totalTokens?: number;
  model?: string;
}

/** 转录消息条目 */
export interface TranscriptMessage {
  /** 消息 ID */
  id?: string;
  /** 角色 */
  role: "user" | "assistant" | "system" | "tool";
  /** 内容 */
  content: string | ChatMessage["content"];
  /** 时间戳 */
  timestamp: number;
  /** 工具调用 */
  tool_calls?: ChatMessage["tool_calls"];
  /** 工具调用 ID */
  tool_call_id?: string;
  /** Token 使用量 */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  /** 模型 */
  model?: string;
  /** 提供商 */
  provider?: string;
}

/** 转录文件头 */
export interface TranscriptHeader {
  type: "session";
  version: number;
  sessionId: string;
  sessionKey: string;
  timestamp: string;
  cwd?: string;
}

/** 会话存储接口 */
export interface SessionStore {
  /** 列出所有会话 */
  list(options?: SessionListOptions): Promise<SessionListItem[]>;
  /** 获取会话 */
  get(sessionKey: string): Promise<SessionEntry | null>;
  /** 创建或更新会话 */
  upsert(entry: SessionEntry): Promise<void>;
  /** 删除会话 */
  delete(sessionKey: string): Promise<void>;
  /** 重置会话 */
  reset(sessionKey: string): Promise<SessionEntry>;
}

/** 会话列表选项 */
export interface SessionListOptions {
  /** 限制返回数量 */
  limit?: number;
  /** 按活跃时间过滤（分钟） */
  activeMinutes?: number;
  /** 搜索关键词 */
  search?: string;
}

/** 转录管理器接口 */
export interface TranscriptManager {
  /** 加载转录记录 */
  load(sessionId: string): Promise<TranscriptMessage[]>;
  /** 追加消息 */
  append(sessionId: string, message: TranscriptMessage): Promise<void>;
  /** 清空转录 */
  clear(sessionId: string): Promise<void>;
}
