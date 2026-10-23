/**
 * 日志工具
 */

import pino, { type Logger as PinoLogger } from "pino";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

export type LogLevel = "debug" | "info" | "warn" | "error";

let globalLogger: PinoLogger | null = null;

/** 获取日志目录 */
export function getLogDir(): string {
  // 优先使用环境变量
  if (process.env.MOZI_LOG_DIR) {
    return process.env.MOZI_LOG_DIR;
  }
  // 默认在用户主目录下
  return join(homedir(), ".mozi", "logs");
}

/** 获取当前日志文件路径 */
export function getLogFile(): string {
  const logDir = getLogDir();
  const date = new Date().toISOString().split("T")[0];
  return join(logDir, `mozi-${date}.log`);
}

/** 确保日志目录存在 */
function ensureLogDir(): void {
  const logDir = getLogDir();
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
}

/** 创建日志器 */
export function createLogger(options: {
  level?: LogLevel;
  name?: string;
  pretty?: boolean;
  logToFile?: boolean;
  /** 是否同时输出到控制台；TUI 这类全屏场景应设为 false */
  console?: boolean;
}): PinoLogger {
  const {
    level = "info",
    name = "mozi",
    pretty = process.env.NODE_ENV !== "production",
    logToFile = true,
    console: logToConsole = true,
  } = options;

  // 如果需要写入文件，确保目录存在
  if (logToFile) {
    ensureLogDir();
  }

  // 配置多目标输出
  const targets: pino.TransportTargetOptions[] = [];

  // 控制台输出 (带格式化)
  if (!logToConsole) {
    // 只写文件
  } else if (pretty) {
    targets.push({
      target: "pino-pretty",
      level,
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    });
  } else {
    targets.push({
      target: "pino/file",
      level,
      options: { destination: 1 }, // stdout
    });
  }

  // 文件输出
  if (logToFile) {
    targets.push({
      target: "pino/file",
      level,
      options: { destination: getLogFile() },
    });
  }

  const logger = pino({
    name,
    level,
    transport: {
      targets,
    },
  });

  return logger;
}

/** 获取全局日志器 */
export function getLogger(): PinoLogger {
  if (!globalLogger) {
    globalLogger = createLogger({
      level: (process.env.LOG_LEVEL as LogLevel) || "info",
      pretty: process.env.NODE_ENV !== "production",
    });
  }
  return globalLogger;
}

/** 设置全局日志器 */
export function setLogger(logger: PinoLogger): void {
  globalLogger = logger;
}

/** 已创建的子日志器缓存：根日志器 -> 模块名 -> child */
const childLoggers = new WeakMap<PinoLogger, Map<string, PinoLogger>>();

/**
 * 创建子日志器。
 *
 * 返回代理而不是真实的 child：模块级 `const logger = getChildLogger(...)`
 * 在导入期就执行，如果直接捕获实例，之后的 setLogger() 不会影响它们。
 * 代理每次访问都从当前全局日志器解析，使运行时切换日志级别/目标生效。
 */
export function getChildLogger(name: string): PinoLogger {
  return new Proxy({} as PinoLogger, {
    get(_target, property) {
      const base = getLogger();
      let byModule = childLoggers.get(base);
      if (!byModule) {
        byModule = new Map();
        childLoggers.set(base, byModule);
      }
      let child = byModule.get(name);
      if (!child) {
        child = base.child({ module: name });
        byModule.set(name, child);
      }
      const value = (child as unknown as Record<string | symbol, unknown>)[property];
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(child) : value;
    },
  });
}

export { type PinoLogger as Logger };
