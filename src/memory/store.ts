/**
 * Memory Store Implementation
 * JSON storage backend for memory entries
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getChildLogger } from "../utils/logger.js";
import type {
  MemoryEntry,
  MemoryStore,
  MemoryListFilter,
  MemoryStoreStatus,
} from "./types.js";

const logger = getChildLogger("memory-store");

/** Generate unique ID */
export function generateMemoryId(): string {
  return crypto.randomBytes(8).toString("hex");
}

/** Cosine similarity for two vectors */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

/**
 * JSON file-based memory store
 */
export class JsonMemoryStore implements MemoryStore {
  private directory: string;
  private indexFile: string;
  private entries: Map<string, MemoryEntry>;
  private embeddingCache: Map<string, number[]>;
  private maxCacheEntries: number;
  private dirty = false;

  constructor(options: {
    directory?: string;
    maxCacheEntries?: number;
  } = {}) {
    this.directory = options.directory ?? path.join(os.homedir(), ".mozi", "memory");
    this.indexFile = path.join(this.directory, "index.json");
    this.maxCacheEntries = options.maxCacheEntries ?? 1000;
    this.entries = new Map();
    this.embeddingCache = new Map();
    this.ensureDirectory();
    this.loadIndex();
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.directory)) {
      fs.mkdirSync(this.directory, { recursive: true });
    }
  }

  private loadIndex(): void {
    this.entries.clear();
    this.embeddingCache.clear();

    if (!fs.existsSync(this.indexFile)) {
      logger.debug({ path: this.indexFile }, "Memory index file not found, starting fresh");
      return;
    }

    try {
      const data = JSON.parse(fs.readFileSync(this.indexFile, "utf-8"));
      const entries = data.entries ?? [];

      for (const entry of entries) {
        this.entries.set(entry.id, entry);
      }

      if (data.embeddings && Array.isArray(data.embeddings)) {
        for (const item of data.embeddings) {
          if (item.hash && Array.isArray(item.embedding)) {
            this.embeddingCache.set(item.hash, item.embedding);
          }
        }
        this.pruneCache();
      }

      logger.debug({ count: this.entries.size }, "Memory index loaded");
    } catch (error) {
      logger.error({ error }, "Failed to load memory index");
    }
  }

  private saveIndex(): void {
    if (!this.dirty) return;

    try {
      const embeddings = Array.from(this.embeddingCache.entries()).map(([hash, embedding]) => ({
        hash,
        embedding,
      }));

      const data = {
        version: 2,
        entries: Array.from(this.entries.values()),
        embeddings,
      };

      fs.writeFileSync(this.indexFile, JSON.stringify(data, null, 2), "utf-8");
      this.dirty = false;
      logger.debug("Memory index saved");
    } catch (error) {
      logger.error({ error }, "Failed to save memory index");
    }
  }

  private pruneCache(): void {
    if (this.embeddingCache.size <= this.maxCacheEntries) return;

    const entries = Array.from(this.embeddingCache.entries());
    const toRemove = entries.slice(0, entries.length - this.maxCacheEntries);
    for (const [hash] of toRemove) {
      this.embeddingCache.delete(hash);
    }
    logger.debug({ removed: toRemove.length }, "Pruned embedding cache");
  }

  async add(entry: Omit<MemoryEntry, "id">): Promise<string> {
    const id = generateMemoryId();
    const fullEntry: MemoryEntry = {
      id,
      content: entry.content,
      embedding: entry.embedding,
      metadata: entry.metadata,
    };

    this.entries.set(id, fullEntry);
    this.dirty = true;
    this.saveIndex();

    logger.debug({ id, type: entry.metadata.type }, "Memory entry added");
    return id;
  }

  async search(query: string, limit = 10): Promise<MemoryEntry[]> {
    const normalizedQuery = query.toLowerCase();
    const results: Array<MemoryEntry & { score: number }> = [];

    for (const entry of this.entries.values()) {
      const contentLower = entry.content.toLowerCase();
      const score = this.computeKeywordScore(normalizedQuery, contentLower);
      if (score > 0) {
        results.push({ ...entry, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private computeKeywordScore(query: string, content: string): number {
    const queryWords = query.split(/\s+/).filter((w) => w.length > 1);
    if (queryWords.length === 0) return 1;

    let matches = 0;
    for (const word of queryWords) {
      if (content.includes(word)) matches++;
    }
    return matches / queryWords.length;
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    return this.entries.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const existed = this.entries.has(id);
    this.entries.delete(id);
    if (existed) {
      this.dirty = true;
      this.saveIndex();
    }
    return existed;
  }

  async list(filter?: MemoryListFilter): Promise<MemoryEntry[]> {
    let entries = Array.from(this.entries.values());

    if (filter?.type) {
      entries = entries.filter((e) => e.metadata.type === filter.type);
    }

    if (filter?.tags && filter.tags.length > 0) {
      entries = entries.filter((e) =>
        filter.tags!.some((tag) => e.metadata.tags?.includes(tag)),
      );
    }

    if (filter?.since) {
      entries = entries.filter((e) => e.metadata.timestamp >= filter.since!);
    }

    if (filter?.until) {
      entries = entries.filter((e) => e.metadata.timestamp <= filter.until!);
    }

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? entries.length;

    return entries.slice(offset, offset + limit);
  }

  async clear(): Promise<void> {
    this.entries.clear();
    this.embeddingCache.clear();
    this.dirty = true;

    if (fs.existsSync(this.indexFile)) {
      fs.unlinkSync(this.indexFile);
    }
  }

  async close(): Promise<void> {
    this.saveIndex();
  }

  status(): MemoryStoreStatus {
    return {
      entries: this.entries.size,
      backend: "json",
      cacheSize: this.embeddingCache.size,
    };
  }

  /** Get entries count */
  get count(): number {
    return this.entries.size;
  }
}
