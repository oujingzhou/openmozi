/**
 * 会话存储实现
 * 使用文件系统存储会话索引和转录记录
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";
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
      return new Map();
    }

    try {
      const content = await fs.promises.readFile(this.indexFile, "utf-8");
      const data = JSON.parse(content) as Record<string, SessionEntry>;
      this.cache = new Map(Object.entries(data));
      this.cacheTime = Date.now();
      return this.cache;
    } catch (error) {
      logger.error({ error }, "Failed to load session index");
      return new Map();
    }
  }

  /** 保存索引 */
  private async saveIndex(index: Map<string, SessionEntry>): Promise<void> {
    await this.writeLock.acquire();
    try {
      const data = Object.fromEntries(index);
      const content = JSON.stringify(data, null, 2);
      const tmpFile = `${this.indexFile}.${randomUUID()}.tmp`;

      await fs.promises.writeFile(tmpFile, content, "utf-8");
      await fs.promises.rename(tmpFile, this.indexFile);

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

    // 如果是新文件，先写入头部
    if (isNew) {
      const header: TranscriptHeader = {
        type: "session",
        version: TRANSCRIPT_VERSION,
        sessionId,
        sessionKey,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      };
      await fs.promises.appendFile(transcriptPath, JSON.stringify(header) + "\n");
    }

    // 追加消息
    await fs.promises.appendFile(transcriptPath, JSON.stringify(message) + "\n");

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
