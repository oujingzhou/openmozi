/**
 * TUI 模块
 */

import { createAgent } from "../agents/agent.js";
import { createLogger, setLogger } from "../utils/logger.js";
import type { MoziConfig } from "../types/index.js";
import { TuiApp } from "./app.js";

export * from "./terminal.js";
export { TuiApp } from "./app.js";

/**
 * 启动终端聊天界面。
 * 日志写入文件，避免打断界面渲染。
 */
export async function startTui(config: MoziConfig): Promise<void> {
  // TUI 占满整个终端，日志只落文件，避免打断渲染
  setLogger(createLogger({ level: "error", console: false }));

  if (!process.stdin.isTTY) {
    throw new Error("TUI 模式需要交互式终端；非交互场景请使用 `mozi web` 或 `mozi --help`");
  }

  const agent = await createAgent(config);
  const app = new TuiApp(config, agent);

  try {
    await app.start();
  } finally {
    await agent.shutdown();
  }
}
