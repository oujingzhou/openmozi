/**
 * 内置工具 - 进程管理工具
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { jsonResult, textResult, readStringParam, readNumberParam } from "../common.js";
import { getSession, getFinishedSession, listRunningSessions, listFinishedSessions, killSession, deleteSession, drainSession, sliceLogLines, tail, formatDuration } from "./process-registry.js";

type ProcessAction = "list" | "poll" | "log" | "write" | "kill" | "clear";

export function createProcessTool(): AgentTool {
  return {
    name: "process",
    label: "Process Manager",
    description: "Manage background bash processes. Actions: list, poll, log, write, kill, clear.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("poll"), Type.Literal("log"), Type.Literal("write"), Type.Literal("kill"), Type.Literal("clear")], { description: "The action to perform" }),
      session_id: Type.Optional(Type.String({ description: "The session ID of the process" })),
      input: Type.Optional(Type.String({ description: "Input to write to stdin (for write action)" })),
      offset: Type.Optional(Type.Number({ description: "Line offset for log output" })),
      limit: Type.Optional(Type.Number({ description: "Line limit for log output" })),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true })! as ProcessAction;
      const sessionId = readStringParam(params, "session_id");
      switch (action) {
        case "list": return handleList();
        case "poll": return handlePoll(sessionId);
        case "log": return handleLog(sessionId, params);
        case "write": return handleWrite(sessionId, params);
        case "kill": return handleKill(sessionId);
        case "clear": return handleClear(sessionId);
        default: return jsonResult({ status: "error", error: `Unknown action: ${action}` }, true);
      }
    },
  };
}

function handleList() {
  const running = listRunningSessions();
  const finished = listFinishedSessions();
  const processes = [...running.map(s => ({ session_id: s.id, command: s.command, pid: s.pid, status: s.status, started: new Date(s.startedAt).toISOString(), duration: formatDuration(Date.now() - s.startedAt), backgrounded: s.backgrounded, tail: tail(s.tail, 200) })), ...finished.map(s => ({ session_id: s.id, command: s.command, pid: s.pid, status: s.status, exitCode: s.exitCode, started: new Date(s.startedAt).toISOString(), ended: s.endedAt ? new Date(s.endedAt).toISOString() : undefined, duration: s.endedAt ? formatDuration(s.endedAt - s.startedAt) : undefined, backgrounded: s.backgrounded }))];
  if (processes.length === 0) return jsonResult({ status: "success", message: "No processes found", running: 0, finished: 0 });
  return jsonResult({ status: "success", running: running.length, finished: finished.length, processes });
}

function handlePoll(sessionId?: string) {
  if (!sessionId) return jsonResult({ status: "error", error: "session_id is required" }, true);
  let session = getSession(sessionId);
  let isFinished = false;
  if (!session) { session = getFinishedSession(sessionId); isFinished = true; }
  if (!session) return jsonResult({ status: "error", error: `Session not found: ${sessionId}` }, true);
  if (isFinished) return jsonResult({ status: "success", session_id: session.id, command: session.command, process_status: session.status, exitCode: session.exitCode, exitSignal: session.exitSignal, duration: session.endedAt ? formatDuration(session.endedAt - session.startedAt) : undefined, truncated: session.truncated, tail: tail(session.aggregated, 2000) });
  const { stdout, stderr } = drainSession(session);
  return jsonResult({ status: "success", session_id: session.id, command: session.command, process_status: session.status, pid: session.pid, duration: formatDuration(Date.now() - session.startedAt), has_output: stdout.length > 0 || stderr.length > 0, stdout: stdout || undefined, stderr: stderr || undefined, truncated: session.truncated });
}

function handleLog(sessionId?: string, params?: Record<string, unknown>) {
  if (!sessionId) return jsonResult({ status: "error", error: "session_id is required" }, true);
  const offset = params ? readNumberParam(params, "offset", { min: 1 }) : undefined;
  const limit = params ? readNumberParam(params, "limit", { min: 1, max: 10000 }) : undefined;
  const session = getSession(sessionId) ?? getFinishedSession(sessionId);
  if (!session) return jsonResult({ status: "error", error: `Session not found: ${sessionId}` }, true);
  const { slice, totalLines, totalChars } = sliceLogLines(session.aggregated, offset, limit ?? 500);
  return textResult(slice || "(no output)", { session_id: session.id, command: session.command, process_status: session.status, totalLines, totalChars, truncated: session.truncated, offset: offset ?? 1, limit: limit ?? 500 });
}

function handleWrite(sessionId?: string, params?: Record<string, unknown>) {
  if (!sessionId) return jsonResult({ status: "error", error: "session_id is required" }, true);
  const input = params ? readStringParam(params, "input", { required: true }) : undefined;
  if (!input) return jsonResult({ status: "error", error: "input is required" }, true);
  const session = getSession(sessionId);
  if (!session) return jsonResult({ status: "error", error: `Session not found or already finished: ${sessionId}` }, true);
  if (!session.child || session.child.killed) return jsonResult({ status: "error", error: "Process is not running" }, true);
  try { session.child.stdin?.write(input); return jsonResult({ status: "success", session_id: sessionId, message: `Wrote ${input.length} characters to stdin` }); }
  catch (error) { return jsonResult({ status: "error", error: error instanceof Error ? error.message : String(error) }, true); }
}

function handleKill(sessionId?: string) {
  if (!sessionId) return jsonResult({ status: "error", error: "session_id is required" }, true);
  const session = getSession(sessionId);
  if (!session) return jsonResult({ status: "error", error: `Session not found or already finished: ${sessionId}` }, true);
  killSession(session);
  return jsonResult({ status: "success", session_id: sessionId, message: "Kill signal sent to process" });
}

function handleClear(sessionId?: string) {
  if (!sessionId) return jsonResult({ status: "error", error: "session_id is required" }, true);
  const deleted = deleteSession(sessionId);
  if (!deleted) return jsonResult({ status: "error", error: `Session not found or still running: ${sessionId}` }, true);
  return jsonResult({ status: "success", session_id: sessionId, message: "Session cleared from history" });
}