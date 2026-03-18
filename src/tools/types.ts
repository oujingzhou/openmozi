/**
 * 工具系统 - 类型定义
 * 使用 pi-agent-core 的 AgentTool 类型
 */

import type { TSchema, Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

// 重新导出 AgentTool 作为 Tool 类型
export type Tool<TParameters extends TSchema = TSchema, TDetails = unknown> = AgentTool<TParameters, TDetails>;

/** 工具结果内容项 */
export type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** 工具执行结果 */
export interface ToolResult {
  content: ToolResultContent[];
  details?: unknown;
  isError?: boolean;
}

/** 工具更新回调 */
export type ToolUpdateCallback = (partial: { text?: string }) => void;

/** 工具调用 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 工具调用结果 */
export interface ToolCallResult {
  toolCallId: string;
  name: string;
  result: ToolResult;
  isError: boolean;
  durationMs: number;
}

/** 工具策略 */
export interface ToolPolicy {
  allow?: string[];
  deny?: string[];
}

/** 工具组定义 */
export const TOOL_GROUPS: Record<string, string[]> = {
  "group:web": ["web_search", "web_fetch"],
  "group:memory": ["memory_search", "memory_store"],
  "group:media": ["image_analyze"],
  "group:system": ["current_time", "calculator"],
};

/** 创建 AgentTool 结果 */
export function createToolResult(text: string, details?: unknown, isError = false): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details: details ?? {},
  };
}

/** 创建错误结果 */
export function createErrorToolResult(error: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify({ status: "error", error }, null, 2) }],
    details: { status: "error", error },
  };
}