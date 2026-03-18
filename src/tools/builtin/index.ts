/**
 * 内置工具导出
 */

export * from "./web.js";
export * from "./system.js";
export * from "./image.js";
export * from "./browser.js";
export * from "./filesystem.js";
export * from "./bash.js";
export * from "./process-registry.js";
export * from "./process-tool.js";
export * from "./apply-patch.js";
export * from "./subagent.js";
export * from "./memory.js";
export * from "./cron.js";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createWebSearchTool, createWebFetchTool } from "./web.js";
import { createCurrentTimeTool, createCalculatorTool, createDelayTool } from "./system.js";
import { createImageAnalyzeTool, type ImageAnalyzeToolOptions } from "./image.js";
import { createBrowserTool } from "./browser.js";
import { createFilesystemTools, type FilesystemToolsOptions } from "./filesystem.js";
import { createBashTool, type BashToolOptions } from "./bash.js";
import { createProcessTool } from "./process-tool.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { createMemoryTools, type MemoryToolsOptions } from "./memory.js";
import { createCronTools, type CronToolsOptions } from "./cron.js";
import type { MemoryManager } from "../../memory/index.js";
import type { CronService } from "../../cron/service.js";

/** 内置工具选项 */
export interface BuiltinToolsOptions {
  image?: ImageAnalyzeToolOptions;
  filesystem?: FilesystemToolsOptions;
  bash?: BashToolOptions;
  memory?: MemoryToolsOptions;
  enableBrowser?: boolean;
  enableFilesystem?: boolean;
  enableBash?: boolean;
  enableProcess?: boolean;
  enableMemory?: boolean;
  enableCron?: boolean;
  /** MemoryManager 实例 */
  memoryManager?: MemoryManager;
  /** CronService 实例 */
  cronService?: CronService;
}

/** 创建所有内置工具 */
export function createBuiltinTools(options?: BuiltinToolsOptions): AgentTool[] {
  const tools: AgentTool[] = [
    createCurrentTimeTool(),
    createCalculatorTool(),
    createWebSearchTool(),
    createWebFetchTool(),
    createImageAnalyzeTool(options?.image),
    createDelayTool(),
  ];

  // 文件系统工具 (默认启用)
  if (options?.enableFilesystem !== false) {
    tools.push(...createFilesystemTools(options?.filesystem));
  }

  // Bash 工具 (默认启用)
  if (options?.enableBash !== false) {
    tools.push(createBashTool(options?.bash));
  }

  // 进程管理工具 (默认启用，随 Bash 工具)
  if (options?.enableProcess !== false && options?.enableBash !== false) {
    tools.push(createProcessTool());
  }

  // apply_patch 工具 (默认启用)
  if (options?.enableFilesystem !== false) {
    const allowedPaths = options?.filesystem?.allowedPaths ?? [process.cwd()];
    tools.push(createApplyPatchTool(allowedPaths));
  }

  // 浏览器工具是可选的，因为需要安装 playwright-core
  if (options?.enableBrowser) {
    tools.push(createBrowserTool());
  }

  // 记忆工具 (需要 MemoryManager 实例)
  if (options?.enableMemory !== false && options?.memoryManager) {
    tools.push(...createMemoryTools({ manager: options.memoryManager }));
  }

  // 定时任务工具 (需要 CronService 实例)
  if (options?.enableCron && options?.cronService) {
    tools.push(...createCronTools({ service: options.cronService }));
  }

  return tools;
}