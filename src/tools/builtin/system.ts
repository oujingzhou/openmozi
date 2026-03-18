/**
 * 内置工具 - 系统工具
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { jsonResult, readStringParam, readNumberParam } from "../common.js";

/** 当前时间工具 */
export function createCurrentTimeTool(): AgentTool {
  return {
    name: "current_time",
    label: "Current Time",
    description: "Get the current date and time.",
    parameters: Type.Object({
      timezone: Type.Optional(Type.String({ description: "Timezone (e.g., 'Asia/Shanghai', 'UTC')" })),
      format: Type.Optional(Type.String({ description: "Format: 'iso', 'locale', or 'unix'" })),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const timezone = readStringParam(params, "timezone") ?? "Asia/Shanghai";
      const format = readStringParam(params, "format") ?? "locale";

      const now = new Date();

      let formatted: string | number;
      switch (format) {
        case "unix":
          formatted = Math.floor(now.getTime() / 1000);
          break;
        case "iso":
          formatted = now.toISOString();
          break;
        case "locale":
        default:
          formatted = now.toLocaleString("zh-CN", { timeZone: timezone });
      }

      return jsonResult({
        status: "success",
        time: formatted,
        timezone,
        timestamp: now.getTime(),
        iso: now.toISOString(),
      });
    },
  };
}

/** 计算器工具 */
export function createCalculatorTool(): AgentTool {
  return {
    name: "calculator",
    label: "Calculator",
    description: "Perform mathematical calculations. Supports basic arithmetic and common functions.",
    parameters: Type.Object({
      expression: Type.String({ description: "Mathematical expression to evaluate (e.g., '2 + 2', 'sqrt(16)', 'sin(PI/2)')" }),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const expression = readStringParam(params, "expression", { required: true })!;

      try {
        // 安全的数学表达式求值
        const result = evaluateMathExpression(expression);

        return jsonResult({
          status: "success",
          expression,
          result,
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          expression,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

/** 安全的数学表达式求值 */
function evaluateMathExpression(expr: string): number {
  // 替换常量
  let sanitized = expr
    .replace(/\bPI\b/gi, String(Math.PI))
    .replace(/\bE\b/g, String(Math.E));

  // 替换函数
  const mathFunctions: Record<string, (x: number) => number> = {
    sqrt: Math.sqrt,
    abs: Math.abs,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,
    log: Math.log,
    log10: Math.log10,
    exp: Math.exp,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
  };

  for (const [name, fn] of Object.entries(mathFunctions)) {
    const regex = new RegExp(`\\b${name}\\s*\\(([^)]+)\\)`, "gi");
    sanitized = sanitized.replace(regex, (_, arg) => {
      const value = evaluateMathExpression(arg);
      return String(fn(value));
    });
  }

  // 只允许数字、运算符和括号
  if (!/^[\d\s+\-*/().]+$/.test(sanitized)) {
    throw new Error("Invalid expression: contains disallowed characters");
  }

  // 使用 Function 安全求值 (只允许数学运算)
  const result = Function(`"use strict"; return (${sanitized})`)();

  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error("Result is not a valid number");
  }

  return result;
}

/** 延迟工具 (用于测试) */
export function createDelayTool(): AgentTool {
  return {
    name: "delay",
    label: "Delay",
    description: "Wait for a specified duration. Useful for testing or rate limiting.",
    parameters: Type.Object({
      seconds: Type.Number({ description: "Duration to wait in seconds (max 30)" }),
    }),
    execute: async (_toolCallId, args, signal) => {
      const params = args as Record<string, unknown>;
      const seconds = readNumberParam(params, "seconds", { required: true, min: 0, max: 30 })!;

      const ms = seconds * 1000;
      const start = Date.now();

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, ms);

        signal?.addEventListener("abort", () => {
          clearTimeout(timeout);
          reject(new Error("Aborted"));
        });
      });

      return jsonResult({
        status: "success",
        requested: seconds,
        actual: (Date.now() - start) / 1000,
      });
    },
  };
}