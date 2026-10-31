/**
 * JSON5 序列化
 *
 * 只负责"key 不带引号、缩进两格"的排版；字符串一律交给
 * `JSON.stringify` 处理，因此换行、制表符、引号、控制字符都不会破坏文件。
 */

const IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

export function serializeJson5(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  const inner = "  ".repeat(indent + 1);

  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    // JSON.stringify 负责全部转义；undefined 由调用方过滤
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value
      .filter((item) => item !== undefined)
      .map((item) => `${inner}${serializeJson5(item, indent + 1)}`);
    if (items.length === 0) return "[]";
    return `[\n${items.join(",\n")}\n${pad}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, item]) => item !== undefined
    );
    if (entries.length === 0) return "{}";
    const lines = entries.map(([key, item]) => {
      const safeKey = IDENTIFIER.test(key) ? key : JSON.stringify(key);
      return `${inner}${safeKey}: ${serializeJson5(item, indent + 1)}`;
    });
    return `{\n${lines.join(",\n")}\n${pad}}`;
  }

  return "null";
}
