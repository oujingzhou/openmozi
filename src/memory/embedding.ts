/**
 * Simple Local Embedding Provider
 * TF-IDF based local embedding implementation without external dependencies
 */

import type { EmbeddingProvider } from "./types.js";

/**
 * Simple TF-IDF based embedding for local/offline use
 * No external API required
 */
export class SimpleEmbedding implements EmbeddingProvider {
  dimension = 256;

  // Vocabulary management
  private readonly maxVocabularySize = 50000;
  private vocabulary = new Map<
    string,
    { index: number; lastUsed: number; docFreq: number }
  >();
  private docCount = 0;
  private nextIndex = 0;

  // Tokenize text into words
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0);
  }

  // Update vocabulary with new tokens
  private updateVocabulary(tokens: string[]): void {
    const seen = new Set<string>();

    for (const token of tokens) {
      const existing = this.vocabulary.get(token);

      if (existing) {
        existing.lastUsed = this.docCount;
        if (!seen.has(token)) {
          existing.docFreq++;
        }
      } else {
        // Evict old entries if vocabulary is full
        if (this.vocabulary.size >= this.maxVocabularySize) {
          this.evictLeastRecentlyUsed();
        }

        this.vocabulary.set(token, {
          index: this.nextIndex++,
          lastUsed: this.docCount,
          docFreq: 1,
        });
      }

      if (!seen.has(token)) {
        seen.add(token);
      }
    }

    this.docCount++;
  }

  // Evict least recently used tokens
  private evictLeastRecentlyUsed(): void {
    const evictCount = Math.floor(this.maxVocabularySize * 0.1);
    const entries = Array.from(this.vocabulary.entries())
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      .slice(0, evictCount);

    for (const [token] of entries) {
      this.vocabulary.delete(token);
    }
  }

  // Compute TF-IDF vector
  private computeVector(tokens: string[]): number[] {
    const vector = new Array(this.dimension).fill(0);
    const tf = new Map<string, number>();

    // Calculate term frequency
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }

    // Build TF-IDF vector
    for (const [token, count] of tf) {
      const vocabEntry = this.vocabulary.get(token);
      if (!vocabEntry) continue;

      const idx = vocabEntry.index % this.dimension;
      const idf = Math.log((this.docCount + 1) / (vocabEntry.docFreq + 1)) + 1;
      vector[idx] += (count / tokens.length) * idf;
    }

    // Normalize vector
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vector.map((v) => v / norm);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const tokens = this.tokenize(text);
      this.updateVocabulary(tokens);
      return this.computeVector(tokens);
    });
  }

  async embedQuery(text: string): Promise<number[]> {
    const [embedding] = await this.embed([text]);
    return embedding ?? new Array(this.dimension).fill(0);
  }

  // Clear vocabulary (useful for testing)
  clear(): void {
    this.vocabulary.clear();
    this.docCount = 0;
    this.nextIndex = 0;
  }
}
