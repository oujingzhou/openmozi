/**
 * Memory Types - Core type definitions for the memory system
 */

/** Memory entry - core data structure */
export interface MemoryEntry {
  id: string;
  content: string;
  embedding?: number[];
  metadata: {
    type: "conversation" | "fact" | "note" | "code";
    source?: string;
    timestamp: number;
    tags?: string[];
  };
  score?: number;
}

/** List filter for memory entries */
export interface MemoryListFilter {
  type?: string;
  tags?: string[];
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

/** Store-specific status information */
export interface MemoryStoreStatus {
  entries: number;
  size?: number;
  backend: "json";
  [key: string]: unknown;
}

/** Memory store interface - abstract storage layer */
export interface MemoryStore {
  add(entry: Omit<MemoryEntry, "id">): Promise<string>;
  search(query: string, limit?: number): Promise<MemoryEntry[]>;
  get(id: string): Promise<MemoryEntry | undefined>;
  delete(id: string): Promise<boolean>;
  list(filter?: MemoryListFilter): Promise<MemoryEntry[]>;
  clear(): Promise<void>;
  close?(): Promise<void>;
  status?(): MemoryStoreStatus;
}

/** Embedding provider interface */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  dimension: number;
}
