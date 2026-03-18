/**
 * 子 Agent 工具
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { jsonResult, textResult, readStringParam } from "../common.js";
import { getChildLogger } from "../../utils/logger.js";

const logger = getChildLogger("subagent");

export interface SubAgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  provider?: string;
}

export type SubAgentRunner = (agentId: string, prompt: string, context?: Record<string, unknown>) => Promise<{ content: string; error?: string }>;

const subAgentRegistry = new Map<string, SubAgentDefinition>();
let subAgentRunner: SubAgentRunner | null = null;

export function registerSubAgent(agent: SubAgentDefinition): void {
  subAgentRegistry.set(agent.id, agent);
}

export function setSubAgentRunner(runner: SubAgentRunner): void {
  subAgentRunner = runner;
}

export function getAllSubAgents(): SubAgentDefinition[] {
  return Array.from(subAgentRegistry.values());
}

export function getSubAgent(id: string): SubAgentDefinition | undefined {
  return subAgentRegistry.get(id);
}

export function createSubAgentTool(): AgentTool {
  return {
    name: "subagent",
    label: "Sub-Agent",
    description: "Delegate a task to a specialized sub-agent.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("run")], { description: "Action to perform" }),
      agent_id: Type.Optional(Type.String({ description: "ID of the sub-agent to run" })),
      prompt: Type.Optional(Type.String({ description: "The prompt/task to send to the sub-agent" })),
      context: Type.Optional(Type.Object({}, { description: "Additional context to pass to the sub-agent" })),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true })!;
      if (action === "list") {
        const agents = getAllSubAgents();
        return jsonResult({ status: "success", agents: agents.map(a => ({ id: a.id, name: a.name, description: a.description })) });
      }
      if (action === "run") {
        const agentId = readStringParam(params, "agent_id");
        const prompt = readStringParam(params, "prompt");
        if (!agentId) return jsonResult({ status: "error", error: "agent_id is required" }, true);
        if (!prompt) return jsonResult({ status: "error", error: "prompt is required" }, true);
        const agent = getSubAgent(agentId);
        if (!agent) return jsonResult({ status: "error", error: `Sub-agent not found: ${agentId}` }, true);
        if (!subAgentRunner) return jsonResult({ status: "error", error: "Sub-agent runner not configured" }, true);
        try {
          logger.info({ agentId, promptLength: prompt.length }, "Running sub-agent");
          const context = params.context as Record<string, unknown> | undefined;
          const result = await subAgentRunner(agentId, prompt, context);
          if (result.error) return jsonResult({ status: "error", error: result.error, partialContent: result.content }, true);
          return textResult(result.content, { agentId, agentName: agent.name });
        } catch (error) {
          return jsonResult({ status: "error", error: error instanceof Error ? error.message : String(error) }, true);
        }
      }
      return jsonResult({ status: "error", error: `Unknown action: ${action}` }, true);
    },
  };
}

export const PREDEFINED_SUBAGENTS: SubAgentDefinition[] = [
  { id: "researcher", name: "Research Agent", description: "Specialized in gathering information", systemPrompt: "You are a Research Agent specialized in finding and reading documentation." },
  { id: "coder", name: "Coding Agent", description: "Specialized in writing code", systemPrompt: "You are a Coding Agent specialized in writing clean, efficient code." },
  { id: "reviewer", name: "Code Review Agent", description: "Specialized in reviewing code", systemPrompt: "You are a Code Review Agent specialized in identifying bugs and suggesting improvements." },
  { id: "planner", name: "Planning Agent", description: "Specialized in breaking down tasks", systemPrompt: "You are a Planning Agent specialized in creating actionable plans." },
];

export function registerPredefinedSubAgents(): void {
  for (const agent of PREDEFINED_SUBAGENTS) registerSubAgent(agent);
}