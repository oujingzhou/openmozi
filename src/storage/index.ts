/**
 * 持久化基础原语
 *
 * 全仓只有这一个地方实现「原子写 JSON」「追加 JSONL」「JSON5 序列化」，
 * 供 sessions / cron / memory / durable / config 共用。
 */

export { atomicWriteJson, atomicWriteFile, readJsonFile, type AtomicWriteOptions } from "./atomic.js";
export { JsonlAppender, type JsonlAppenderOptions } from "./jsonl.js";
export { serializeJson5 } from "./json5-writer.js";
