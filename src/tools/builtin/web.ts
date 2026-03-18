/**
 * 内置工具 - 网络搜索和获取
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { jsonResult, errorResult, readStringParam, readNumberParam } from "../common.js";
import { getChildLogger } from "../../utils/logger.js";

const logger = getChildLogger("web-tools");

// ============== Brave Search API ==============

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;
const DEFAULT_TIMEOUT_MS = 30000;

/** 搜索结果缓存 */
const searchCache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5分钟

/** Brave Search 返回结构 */
type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type BraveSearchResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
};

/** 获取 API Key */
function getSearchApiKey(): string | undefined {
  return process.env.BRAVE_API_KEY?.trim() || undefined;
}

/** 从 URL 提取站点名称 */
function extractSiteName(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** 生成缓存 Key */
function generateCacheKey(query: string, count: number, country?: string): string {
  return `${query}:${count}:${country || "default"}`.toLowerCase();
}

/** 读取缓存 */
function readCache(key: string): unknown | undefined {
  const entry = searchCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    searchCache.delete(key);
    return undefined;
  }
  return entry.data;
}

/** 写入缓存 */
function writeCache(key: string, data: unknown): void {
  // 清理过期缓存
  const now = Date.now();
  for (const [k, v] of searchCache) {
    if (now - v.timestamp > CACHE_TTL_MS) {
      searchCache.delete(k);
    }
  }
  searchCache.set(key, { data, timestamp: now });
}

/** 执行 Brave Search */
async function runBraveSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  country?: string;
}): Promise<{
  query: string;
  count: number;
  results: Array<{
    title: string;
    url: string;
    description: string;
    published?: string;
    siteName?: string;
  }>;
  tookMs: number;
}> {
  const { query, count, apiKey, country } = params;
  const startTime = Date.now();

  // 构建 URL
  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  if (country) {
    url.searchParams.set("country", country);
  }

  // 发起请求
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Brave Search API error (${response.status}): ${text || response.statusText}`);
    }

    const data = (await response.json()) as BraveSearchResponse;
    const rawResults = Array.isArray(data.web?.results) ? data.web.results : [];

    const results = rawResults.map((entry) => ({
      title: entry.title ?? "",
      url: entry.url ?? "",
      description: entry.description ?? "",
      published: entry.age,
      siteName: extractSiteName(entry.url),
    }));

    return {
      query,
      count: results.length,
      results,
      tookMs: Date.now() - startTime,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** 网络搜索工具 */
export function createWebSearchTool(): AgentTool {
  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Brave Search API. Returns titles, URLs, and snippets for research. Set BRAVE_API_KEY environment variable to enable.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      count: Type.Optional(
        Type.Number({
          description: "Number of results (1-10, default: 5)",
          minimum: 1,
          maximum: MAX_SEARCH_COUNT,
        })
      ),
      country: Type.Optional(
        Type.String({
          description: "2-letter country code for region-specific results (e.g., 'CN', 'US')",
        })
      ),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true })!;
      const count = Math.min(
        MAX_SEARCH_COUNT,
        Math.max(1, readNumberParam(params, "count", { min: 1, max: MAX_SEARCH_COUNT }) ?? DEFAULT_SEARCH_COUNT)
      );
      const country = readStringParam(params, "country");

      // 检查 API Key
      const apiKey = getSearchApiKey();
      if (!apiKey) {
        return jsonResult({
          error: "missing_api_key",
          message:
            "web_search requires BRAVE_API_KEY environment variable. Get a free API key at https://brave.com/search/api/",
        });
      }

      // 检查缓存
      const cacheKey = generateCacheKey(query, count, country);
      const cached = readCache(cacheKey);
      if (cached) {
        logger.debug({ query }, "Returning cached search results");
        return jsonResult({ ...cached as object, cached: true });
      }

      try {
        const result = await runBraveSearch({ query, count, apiKey, country });
        writeCache(cacheKey, result);
        logger.info({ query, count: result.count, tookMs: result.tookMs }, "Web search completed");
        return jsonResult(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ query, error: message }, "Web search failed");
        return errorResult(`Search failed: ${message}`);
      }
    },
  };
}

/** 网页获取工具 */
export function createWebFetchTool(): AgentTool {
  return {
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch content from a URL. Returns the page content as text.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      maxLength: Type.Optional(Type.Number({ description: "Maximum content length (default: 10000)" })),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const url = readStringParam(params, "url", { required: true })!;
      const maxLength = readNumberParam(params, "maxLength", { min: 100 }) ?? 10000;

      try {
        // 验证 URL
        new URL(url);

        const response = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; MoziBot/1.0)",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        });

        if (!response.ok) {
          return errorResult(`HTTP ${response.status}: ${response.statusText}`);
        }

        const contentType = response.headers.get("content-type") ?? "";
        let content = await response.text();

        // 截断过长内容
        if (content.length > maxLength) {
          content = content.slice(0, maxLength) + "\n...[truncated]";
        }

        // 简单的 HTML 清理 (移除脚本和样式)
        if (contentType.includes("text/html")) {
          content = content
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        }

        return jsonResult({
          status: "success",
          url,
          contentType,
          length: content.length,
          content,
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}