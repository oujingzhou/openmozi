/**
 * 内置工具 - Bash 命令执行工具
 */

import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { resolve, sep } from "path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { jsonResult, textResult, readStringParam, readNumberParam, readBooleanParam } from "../common.js";
import {
  createSessionId,
  addSession,
  markBackgrounded,
  markExited,
  appendOutput,
  drainSession,
  deriveSessionName,
  formatDuration,
  truncateMiddle,
  type ProcessSession,
} from "./process-registry.js";

export interface BashToolOptions {
  allowedPaths?: string[];
  defaultTimeout?: number;
  maxTimeout?: number;
  maxOutputSize?: number;
  blockedCommands?: RegExp[];
  enabled?: boolean;
}

const DEFAULT_OPTIONS: Required<BashToolOptions> = {
  allowedPaths: [process.cwd()],
  defaultTimeout: 120000,
  maxTimeout: 600000,
  maxOutputSize: 100000,
  blockedCommands: [
    /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?[\/~]/i,
    /\bmkfs\b/i,
    /\bdd\s+.*of=\/dev/i,
    /\b(poweroff|reboot|shutdown|halt)\b/i,
    /\bkill\s+(-\d+\s+)?(-1|1)\b/,
    />\s*\/dev\/(sda|hda|nvme|vda)/i,
    />\s*\/etc\/(passwd|shadow|sudoers)/i,
  ],
  enabled: true,
};

function isPathAllowed(path: string, allowedPaths: string[]): boolean {
  const resolved = resolve(path);
  return allowedPaths.some((allowed) => {
    const ra = resolve(allowed);
    return resolved === ra || resolved.startsWith(ra + sep);
  });
}

function isCommandBlocked(command: string, blockedPatterns: RegExp[]): boolean {
  return blockedPatterns.some((pattern) => pattern.test(command));
}

const isWindows = process.platform === "win32";

function getShellCommand(command: string): { shell: string; args: string[] } {
  if (isWindows) return { shell: "cmd.exe", args: ["/c", command] };
  return { shell: "bash", args: ["-c", command] };
}

function killProcess(proc: ReturnType<typeof spawn>, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    if (isWindows && proc.pid) spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { stdio: "ignore" });
    else proc.kill(signal);
  } catch {}
}

export function createBashTool(options?: BashToolOptions): AgentTool {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  return {
    name: "bash",
    label: "Bash",
    description: "Execute a bash command with optional background execution.",
    parameters: Type.Object({
      command: Type.String({ description: "The bash command to execute" }),
      cwd: Type.Optional(Type.String({ description: "Working directory for the command" })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (max 600000)" })),
      run_in_background: Type.Optional(Type.Boolean({ description: "Run in background and return session ID" })),
      description: Type.Optional(Type.String({ description: "Brief description of what the command does" })),
    }),
    execute: async (_toolCallId, args, signal) => {
      if (!opts.enabled) return jsonResult({ status: "error", error: "Bash tool is disabled" }, true);
      const params = args as Record<string, unknown>;
      const command = readStringParam(params, "command", { required: true })!;
      const cwd = readStringParam(params, "cwd") ?? process.cwd();
      const timeout = Math.min(readNumberParam(params, "timeout") ?? opts.defaultTimeout, opts.maxTimeout);
      const runInBackground = readBooleanParam(params, "run_in_background");
      const description = readStringParam(params, "description");
      if (!isPathAllowed(cwd, opts.allowedPaths)) return jsonResult({ status: "error", error: `Access denied: ${cwd}` }, true);
      if (isCommandBlocked(command, opts.blockedCommands)) return jsonResult({ status: "error", error: "Command blocked for security" }, true);

      const sessionId = createSessionId();
      const session: ProcessSession = {
        id: sessionId, command: truncateMiddle(command, 200), startedAt: Date.now(), cwd, status: "running",
        stdout: "", stderr: "", aggregated: "", tail: "", truncated: false, backgrounded: runInBackground ?? false, maxOutputChars: opts.maxOutputSize,
      };
      const { shell, args: shellArgs } = getShellCommand(command);
      const proc = spawn(shell, shellArgs, { cwd, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
      session.child = proc; session.pid = proc.pid; addSession(session);
      proc.stdout?.on("data", (data) => appendOutput(session, "stdout", data.toString()));
      proc.stderr?.on("data", (data) => appendOutput(session, "stderr", data.toString()));
      proc.on("close", (code, sig) => markExited(session, code, sig, code === 0 ? "completed" : "failed"));
      proc.on("error", (error) => { appendOutput(session, "stderr", `Process error: ${error.message}`); markExited(session, null, null, "failed"); });

      if (runInBackground) {
        markBackgrounded(session);
        return jsonResult({ status: "backgrounded", session_id: sessionId, pid: proc.pid, command: session.command, description: description ?? deriveSessionName(command) });
      }
      return new Promise((resolvePromise) => {
        let killed = false;
        const timeoutId = setTimeout(() => { killed = true; killProcess(proc, "SIGTERM"); setTimeout(() => { if (!proc.killed) killProcess(proc, "SIGKILL"); }, 5000); }, timeout);
        signal?.addEventListener("abort", () => { killed = true; killProcess(proc, "SIGTERM"); });
        proc.on("close", (code) => {
          clearTimeout(timeoutId);
          const { stdout, stderr } = drainSession(session);
          if (killed) resolvePromise(jsonResult({ status: "killed", reason: signal?.aborted ? "aborted" : "timeout", session_id: sessionId, stdout: stdout.trim(), stderr: stderr.trim(), duration: formatDuration(Date.now() - session.startedAt) }, true));
          else {
            let output = (stdout.trim() + (stderr.trim() ? "\n\n[stderr]\n" + stderr.trim() : "")).trim() || "(no output)";
            if (code === 0) resolvePromise(textResult(output, { exitCode: code, command: session.command, session_id: sessionId, duration: formatDuration(Date.now() - session.startedAt) }));
            else resolvePromise(jsonResult({ status: "error", exitCode: code, session_id: sessionId, stdout: stdout.trim(), stderr: stderr.trim(), duration: formatDuration(Date.now() - session.startedAt) }, true));
          }
        });
      });
    },
  };
}

export function createBashTools(options?: BashToolOptions): AgentTool[] {
  return [createBashTool(options)];
}