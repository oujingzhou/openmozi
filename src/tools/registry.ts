/**
 * 工具注册表 (简化版)
 * 用于插件系统注册自定义工具
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Tool, ToolPolicy } from "./types.js";
import { TOOL_GROUPS } from "./types.js";

// 工具注册表 (case-insensitive keys)
const toolRegistry = new Map<string, AgentTool>();

/** 规范化工具名称 (转小写) */
function normalizeName(name: string): string {
  return name.toLowerCase();
}

/** 注册单个工具 */
export function registerTool(tool: Tool): void {
  const normalizedName = normalizeName(tool.name);
  toolRegistry.set(normalizedName, tool as AgentTool);
}

/** 批量注册工具 */
export function registerTools(tools: Tool[]): void {
  for (const tool of tools) {
    registerTool(tool);
  }
}

/** 获取工具 (case-insensitive) */
export function getTool(name: string): AgentTool | undefined {
  return toolRegistry.get(normalizeName(name));
}

/** 获取所有工具 */
export function getAllTools(): AgentTool[] {
  return Array.from(toolRegistry.values());
}

/** 清空注册表 */
export function clearTools(): void {
  toolRegistry.clear();
}

/** 展开工具组 */
function expandToolGroups(patterns: string[]): string[] {
  const expanded: string[] = [];

  for (const pattern of patterns) {
    if (pattern.startsWith("group:")) {
      // TOOL_GROUPS keys include "group:" prefix
      const groupTools = TOOL_GROUPS[pattern];
      if (groupTools) {
        expanded.push(...groupTools);
      }
    } else {
      expanded.push(pattern);
    }
  }

  return expanded;
}

/** 匹配通配符模式 */
function matchPattern(toolName: string, pattern: string): boolean {
  const normalizedTool = normalizeName(toolName);
  const normalizedPattern = normalizeName(pattern);

  if (normalizedPattern === "*") return true;
  if (normalizedPattern.includes("*")) {
    const regex = new RegExp("^" + normalizedPattern.replace(/\*/g, ".*") + "$");
    return regex.test(normalizedTool);
  }
  return normalizedTool === normalizedPattern;
}

/**
 * 根据策略过滤工具
 */
export function filterToolsByPolicy(tools: AgentTool[], policy: ToolPolicy = {}): AgentTool[] {
  if (!policy.allow && !policy.deny) return tools;

  const expandedAllow = policy.allow ? expandToolGroups(policy.allow) : undefined;
  const expandedDeny = policy.deny ? expandToolGroups(policy.deny) : undefined;

  return tools.filter((tool) => {
    // 检查 deny 列表
    if (expandedDeny) {
      for (const pattern of expandedDeny) {
        if (matchPattern(tool.name, pattern)) return false;
      }
    }

    // 检查 allow 列表
    if (expandedAllow) {
      for (const pattern of expandedAllow) {
        if (matchPattern(tool.name, pattern)) return true;
      }
      return false;
    }

    return true;
  });
}

/**
 * 执行工具调用 (占位实现，实际执行由 pi-coding-agent 处理)
 */
export async function executeToolCalls(
  _toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  _tools: AgentTool[]
): Promise<Array<{ toolCallId: string; name: string; result: unknown; isError: boolean }>> {
  // 实际执行由 pi-coding-agent 框架处理
  return [];
}

/**
 * 将工具转换为 OpenAI Functions 格式
 */
export function toolsToOpenAIFunctions(tools: AgentTool[]): Array<{ type: string; function: { name: string; description: string; parameters: unknown } }> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}