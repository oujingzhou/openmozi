/**
 * 会话存储实现
 * 使用文件系统存储会话索引和转录记录
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";
import { atomicWriteJson, JsonlAppender } from "../storage/index.js";
import { getChildLogger } from "../utils/logger.js";
import { generateId } from "../utils/index.js";
import type {
  SessionEntry,
  SessionListItem,
  SessionListOptions,
  TranscriptMessage,
  TranscriptHeader,
} from "./types.js";

const logger = getChildLogger("sessions");

/** 当前转录版本 */
const TRANSCRIPT_VERSION = 1;

/** 简单的写入锁实现 */
class WriteLock {
  private locked = false;
  private waitQueue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

/** 默认存储目录 */
function getDefaultStorePath(): string {
  return path.join(os.homedir(), ".mozi", "sessions");
}

/** 会话存储类 */
export class FileSessionStore {
  private storePath: string;
  private indexFile: string;
  private cache: Map<string, SessionEntry> = new Map();
  private cacheTime = 0;
  private cacheTTL = 30_000; // 30秒缓存
  private writeLock = new WriteLock();
  /** 索引解析失败置位；此时任何写入都会丢历史，必须拒绝 */
  private indexCorrupted = false;

  constructor(storePath?: string) {
    this.storePath = storePath ?? getDefaultStorePath();
    this.indexFile = path.join(this.storePath, "sessions.json");
    this.ensureDirectory();
  }

  /** 确保目录存在 */
  private ensureDirectory(): void {
    if (!fs.existsSync(this.storePath)) {
      fs.mkdirSync(this.storePath, { recursive: true });
      logger.info({ path: this.storePath }, "Created sessions directory");
    }
  }

  /** 加载索引 */
  private async loadIndex(): Promise<Map<string, SessionEntry>> {
    // 检查缓存
    if (this.cache.size > 0 && Date.now() - this.cacheTime < this.cacheTTL) {
      return this.cache;
    }

    if (!fs.existsSync(this.indexFile)) {
      this.indexCorrupted = false;
      return new Map();
    }

    try {
      this.cache = this.parseIndex(await fs.promises.readFile(this.indexFile, "utf-8"));
      this.cacheTime = Date.now();
      this.indexCorrupted = false;
      return this.cache;
    } catch (error) {
      // 主文件损坏：先尝试用 .bak 恢复，避免历史整体消失。
      logger.error({ error, indexFile: this.indexFile }, "Session index is corrupt, trying backup");
      const backupFile = `${this.indexFile}.bak`;
      if (fs.existsSync(backupFile)) {
        try {
          const restored = this.parseIndex(await fs.promises.readFile(backupFile, "utf-8"));
          this.cache = restored;
          this.cacheTime = Date.now();
          this.indexCorrupted = false;
          logger.warn(
            { indexFile: this.indexFile, entries: restored.size },
            "Session index restored from backup; corrupt file kept alongside"
          );
          return restored;
        } catch (backupError) {
          logger.error({ error: backupError, backupFile }, "Session index backup is also corrupt");
        }
      }

      // 两份都读不了：拒绝写入，保留现场等待人工处理。
      this.indexCorrupted = true;
      return new Map();
    }
  }

  /** 解析索引文件内容，结构不符即抛错 */
  private parseIndex(content: string): Map<string, SessionEntry> {
    const data = JSON.parse(content) as unknown;
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Session index is not a JSON object");
    }
    return new Map(Object.entries(data as Record<string, SessionEntry>));
   }

  /** 保存索引 */
  private async saveIndex(index: Map<string, SessionEntry>): Promise<void> {
    if (this.indexCorrupted) {
      throw new Error(
        `会话索引已损坏（${this.indexFile}），已拒绝写入以免覆盖历史。请修复或删除该文件后重试。`
      );
    }

    await this.writeLock.acquire();
    try {
      atomicWriteJson(this.indexFile, Object.fromEntries(index), { backup: true, fsync: false });
      this.cache = index;
      this.cacheTime = Date.now();
    } finally {
      this.writeLock.release();
    }
  }

  /** 列出所有会话 */
  async list(options?: SessionListOptions): Promise<SessionListItem[]> {
    const index = await this.loadIndex();
    let entries = Array.from(index.values());

    // 按活跃时间过滤
    if (options?.activeMinutes) {
      const cutoff = Date.now() - options.activeMinutes * 60 * 1000;
      entries = entries.filter((e) => e.updatedAt >= cutoff);
    }

    // 搜索过滤
    if (options?.search) {
      const search = options.search.toLowerCase();
      entries = entries.filter(
        (e) =>
          e.sessionKey.toLowerCase().includes(search) ||
          e.label?.toLowerCase().includes(search)
      );
    }

    // 按更新时间排序（最新的在前）
    entries.sort((a, b) => b.updatedAt - a.updatedAt);

    // 限制返回数量
    if (options?.limit) {
      entries = entries.slice(0, options.limit);
    }

    return entries.map((e) => ({
      sessionKey: e.sessionKey,
      sessionId: e.sessionId,
      label: e.label,
      updatedAt: e.updatedAt,
      messageCount: e.messageCount,
      totalTokens: e.totalTokens,
      model: e.model,
    }));
  }

  /** 获取会话 */
  async get(sessionKey: string): Promise<SessionEntry | null> {
    const index = await this.loadIndex();
    return index.get(sessionKey) ?? null;
  }

  /** 创建或更新会话 */
  async upsert(entry: SessionEntry): Promise<void> {
    const index = await this.loadIndex();
    index.set(entry.sessionKey, entry);
    await this.saveIndex(index);
    logger.debug({ sessionKey: entry.sessionKey }, "Session upserted");
  }

  /** 删除会话 */
  async delete(sessionKey: string): Promise<void> {
    const index = await this.loadIndex();
    const entry = index.get(sessionKey);

    if (entry) {
      // 删除转录文件
      const transcriptPath = this.getTranscriptPath(entry.sessionId);
      if (fs.existsSync(transcriptPath)) {
        // 归档而不是删除
        const archivePath = `${transcriptPath}.deleted.${Date.now()}`;
        await fs.promises.rename(transcriptPath, archivePath);
      }

      index.delete(sessionKey);
      await this.saveIndex(index);
      logger.info({ sessionKey }, "Session deleted");
    }
  }

  /** 重置会话（创建新会话） */
  async reset(sessionKey: string): Promise<SessionEntry> {
    const index = await this.loadIndex();
    const existing = index.get(sessionKey);
    const now = Date.now();

    // 从旧 sessionKey 提取 channel 前缀（如 "webchat:"）
    const channelPrefix = sessionKey.includes(":") ? sessionKey.split(":")[0] + ":" : "";

    // 生成新的 sessionKey
    const newSessionKey = `${channelPrefix}${generateId("session")}`;

    // 创建新会话
    const newEntry: SessionEntry = {
      sessionId: randomUUID(),
      sessionKey: newSessionKey,
      label: undefined,  // 新会话不继承 label
      createdAt: now,
      updatedAt: now,
      channel: existing?.channel,
      model: existing?.model,
      provider: existing?.provider,
      messageCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };

    // 保留旧会话（不删除）
    // 添加新会话到索引
    index.set(newSessionKey, newEntry);
    await this.saveIndex(index);

    logger.info({ oldSessionKey: sessionKey, newSessionKey, sessionId: newEntry.sessionId }, "New session created");
    return newEntry;
  }

  /** 设置会话标题 */
  async setLabel(sessionKey: string, label: string, source: SessionEntry["labelSource"]): Promise<void> {
    const index = await this.loadIndex();
    const entry = index.get(sessionKey);
    if (!entry) return;
    // 用户自定义的标题不被自动生成的覆盖
    if (entry.labelSource === "user" && source !== "user") return;
    entry.label = label;
    entry.labelSource = source;
    entry.updatedAt = Date.now();
    await this.saveIndex(index);
  }

  /** 获取或创建会话 */
  async getOrCreate(sessionKey: string): Promise<SessionEntry> {
    const existing = await this.get(sessionKey);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const entry: SessionEntry = {
      sessionId: randomUUID(),
      sessionKey,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };

    await this.upsert(entry);
    return entry;
  }

  /** 获取转录文件路径 */
  getTranscriptPath(sessionId: string): string {
    return path.join(this.storePath, `${sessionId}.jsonl`);
  }

  /** 加载转录记录 */
  async loadTranscript(sessionId: string): Promise<TranscriptMessage[]> {
    const transcriptPath = this.getTranscriptPath(sessionId);
    if (!fs.existsSync(transcriptPath)) {
      return [];
    }

    try {
      const content = await fs.promises.readFile(transcriptPath, "utf-8");
      const lines = content.trim().split("\n");
      const messages: TranscriptMessage[] = [];

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          // 跳过文件头
          if (entry.type === "session") continue;
          messages.push(entry as TranscriptMessage);
        } catch {
          // 忽略解析错误的行
        }
      }

      return messages;
    } catch (error) {
      logger.error({ error, sessionId }, "Failed to load transcript");
      return [];
    }
  }

  /** 追加转录消息 */
  async appendTranscript(
    sessionId: string,
    sessionKey: string,
    message: TranscriptMessage
  ): Promise<void> {
    const transcriptPath = this.getTranscriptPath(sessionId);
    const isNew = !fs.existsSync(transcriptPath);

    // 头部与消息一次写入，避免中途崩溃留下"有头无消息"的半截文件
    const lines: unknown[] = [];
    if (isNew) {
      const header: TranscriptHeader = {
        type: "session",
        version: TRANSCRIPT_VERSION,
        sessionId,
        sessionKey,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      };
      lines.push(header);
    }
    lines.push(message);

    new JsonlAppender(transcriptPath).append(lines);

    // 更新会话索引
    const entry = await this.get(sessionKey);
    if (entry) {
      entry.updatedAt = Date.now();
      entry.messageCount = (entry.messageCount ?? 0) + 1;
      if (message.usage) {
        entry.inputTokens = (entry.inputTokens ?? 0) + (message.usage.promptTokens ?? 0);
        entry.outputTokens = (entry.outputTokens ?? 0) + (message.usage.completionTokens ?? 0);
        entry.totalTokens = (entry.totalTokens ?? 0) + (message.usage.totalTokens ?? 0);
      }
      if (message.model) entry.model = message.model;
      if (message.provider) entry.provider = message.provider;
      await this.upsert(entry);
    }
  }

  /** 清空转录 */
  async clearTranscript(sessionId: string): Promise<void> {
    const transcriptPath = this.getTranscriptPath(sessionId);
    if (fs.existsSync(transcriptPath)) {
      await fs.promises.unlink(transcriptPath);
    }
  }
}

/** 全局会话存储实例 */
let globalStore: FileSessionStore | null = null;

/** 获取全局会话存储 */
export function getSessionStore(): FileSessionStore {
  if (!globalStore) {
    globalStore = new FileSessionStore();
  }
  return globalStore;
}

/** 初始化会话存储 */
export function initSessionStore(storePath?: string): FileSessionStore {
  globalStore = new FileSessionStore(storePath);
  return globalStore;
}
