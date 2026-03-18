/**
 * 内置工具 - 记忆系统
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { jsonResult, errorResult, readStringParam, readNumberParam, readStringArrayParam } from "../common.js";
import { MemoryManager } from "../../memory/index.js";
import { getChildLogger } from "../../utils/logger.js";

const logger = getChildLogger("memory-tools");

export interface MemoryToolsOptions { manager?: MemoryManager; }

let memoryManager: MemoryManager | null = null;

export function setMemoryManager(manager: MemoryManager): void { memoryManager = manager; }
function getManager(): MemoryManager | null { return memoryManager; }

export function createMemorySearchTool(): AgentTool {
  return {
    name: "memory_search",
    label: "Memory Search",
    description: "Search stored memories by semantic similarity.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      type: Type.Optional(Type.String({ description: "Filter by type: conversation, fact, note, code", enum: ["conversation", "fact", "note", "code"] })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Filter by tags" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 5)", minimum: 1, maximum: 20 })),
      min_score: Type.Optional(Type.Number({ description: "Min relevance score 0-1", minimum: 0, maximum: 1 })),
    }),
    execute: async (_toolCallId, args) => {
      const manager = getManager();
      if (!manager) return jsonResult({ status: "disabled", message: "Memory system not enabled", results: [] });
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true })!;
      const type = readStringParam(params, "type");
      const tags = readStringArrayParam(params, "tags");
      const limit = readNumberParam(params, "limit", { min: 1, max: 20 }) ?? 5;
      const minScore = readNumberParam(params, "min_score", { min: 0, max: 1 }) ?? 0.1;
      try {
        let results = await manager.recall(query, limit * 2);
        if (type) results = results.filter(r => r.metadata.type === type);
        if (tags?.length) results = results.filter(r => tags.some(tag => r.metadata.tags?.includes(tag)));
        results = results.filter(r => (r.score ?? 0) >= minScore).slice(0, limit);
        return jsonResult({ status: "success", query, count: results.length, results: results.map(r => ({ id: r.id, content: r.content, type: r.metadata.type, tags: r.metadata.tags, score: r.score ? Math.round(r.score * 100) / 100 : undefined, date: new Date(r.metadata.timestamp).toISOString() })) });
      } catch (error) { return errorResult(`Memory search failed: ${error instanceof Error ? error.message : String(error)}`); }
    },
  };
}

export function createMemoryStoreTool(): AgentTool {
  return {
    name: "memory_store",
    label: "Memory Store",
    description: "Store important information for future reference.",
    parameters: Type.Object({
      content: Type.String({ description: "Content to store", minLength: 1 }),
      type: Type.Optional(Type.String({ description: "Type: fact, note, code, conversation", enum: ["fact", "note", "code", "conversation"] })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" })),
      source: Type.Optional(Type.String({ description: "Source of the information" })),
    }),
    execute: async (_toolCallId, args) => {
      const manager = getManager();
      if (!manager) return jsonResult({ status: "disabled", message: "Memory system not enabled" });
      const params = args as Record<string, unknown>;
      const content = readStringParam(params, "content", { required: true })!;
      const type = (readStringParam(params, "type") ?? "note") as "fact" | "note" | "code" | "conversation";
      const tags = readStringArrayParam(params, "tags");
      const source = readStringParam(params, "source");
      try {
        const id = await manager.remember(content, { type, tags: tags ?? undefined, source: source ?? undefined });
        return jsonResult({ status: "success", id, type, tags, message: "Memory stored" });
      } catch (error) { return errorResult(`Memory store failed: ${error instanceof Error ? error.message : String(error)}`); }
    },
  };
}

export function createMemoryListTool(): AgentTool {
  return {
    name: "memory_list",
    label: "Memory List",
    description: "List stored memories with optional filtering.",
    parameters: Type.Object({
      type: Type.Optional(Type.String({ description: "Filter by type", enum: ["conversation", "fact", "note", "code"] })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Filter by tags" })),
      limit: Type.Optional(Type.Number({ description: "Max entries (default: 20)", minimum: 1, maximum: 100 })),
    }),
    execute: async (_toolCallId, args) => {
      const manager = getManager();
      if (!manager) return jsonResult({ status: "disabled", message: "Memory system not enabled", entries: [] });
      const params = args as Record<string, unknown>;
      const type = readStringParam(params, "type");
      const tags = readStringArrayParam(params, "tags");
      const limit = readNumberParam(params, "limit", { min: 1, max: 100 }) ?? 20;
      try {
        let entries = await manager.list({ type: type ?? undefined, tags: tags ?? undefined });
        entries.sort((a, b) => b.metadata.timestamp - a.metadata.timestamp);
        entries = entries.slice(0, limit);
        return jsonResult({ status: "success", count: entries.length, entries: entries.map(e => ({ id: e.id, content: e.content.length > 200 ? e.content.slice(0, 200) + "..." : e.content, type: e.metadata.type, tags: e.metadata.tags, date: new Date(e.metadata.timestamp).toISOString() })) });
      } catch (error) { return errorResult(`Memory list failed: ${error instanceof Error ? error.message : String(error)}`); }
    },
  };
}

export function createMemoryDeleteTool(): AgentTool {
  return {
    name: "memory_delete",
    label: "Memory Delete",
    description: "Delete a specific memory entry by ID.",
    parameters: Type.Object({ id: Type.String({ description: "Memory entry ID to delete" }) }),
    execute: async (_toolCallId, args) => {
      const manager = getManager();
      if (!manager) return jsonResult({ status: "disabled", message: "Memory system not enabled" });
      const params = args as Record<string, unknown>;
      const id = readStringParam(params, "id", { required: true })!;
      try {
        const deleted = await manager.forget(id);
        if (deleted) return jsonResult({ status: "success", id, message: "Memory deleted" });
        return jsonResult({ status: "not_found", id, message: "Memory entry not found" });
      } catch (error) { return errorResult(`Memory delete failed: ${error instanceof Error ? error.message : String(error)}`); }
    },
  };
}

export function createMemoryTools(options?: MemoryToolsOptions): AgentTool[] {
  if (options?.manager) setMemoryManager(options.manager);
  return [createMemorySearchTool(), createMemoryStoreTool(), createMemoryListTool(), createMemoryDeleteTool()];
}