/**
 * 通道 HTTP 客户端
 *
 * 四个通道适配器原来各写了一套 fetch/axios 封装与错误码约定，
 * 这里统一成一处：重试、超时、响应解析、错误信息。
 */

import { getChildLogger } from "../../utils/logger.js";
import { delay } from "../../utils/index.js";

const logger = getChildLogger("channel-http");

/** 带状态码的 HTTP 错误；4xx 不重试 */
export class ChannelHttpError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly status: number,
    method: string,
    path: string,
    body: string
  ) {
    super(`HTTP ${status} ${method} ${path}: ${body.slice(0, 200)}`);
    this.name = "ChannelHttpError";
    this.retryable = status >= 500 || status === 429;
  }
}

export interface ChannelHttpOptions {
  baseUrl: string;
  /** 默认请求头（鉴权头由调用方每次传入，token 会轮换） */
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  /** 重试基础退避，默认 1s；测试里可以设 0 */
  retryDelayMs?: number;
}

export interface ChannelRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

export class ChannelHttpClient {
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(options: ChannelHttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.defaultHeaders = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
  }

  /** 拼接完整 URL；path 为绝对地址时直接使用 */
  buildUrl(path: string, query?: ChannelRequestOptions["query"]): string {
    const absolute = /^https?:\/\//.test(path);
    const url = new URL(absolute ? path : `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * 发请求并返回解析后的 JSON。
   * 网络错误与 5xx 会重试；4xx 直接抛出（重试也不会成功）。
   */
  async requestJson<T>(options: ChannelRequestOptions): Promise<T> {
    const url = this.buildUrl(options.path, options.query);
    const method = options.method ?? "GET";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.defaultHeaders,
      ...options.headers,
    };

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new ChannelHttpError(res.status, method, options.path, text);
        }
        return (await res.json()) as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // 4xx 是调用方的问题，重试无意义
        if (error instanceof ChannelHttpError && !error.retryable) throw error;
        if (attempt < this.maxRetries) {
          logger.debug({ attempt, error: lastError.message, path: options.path }, "Retrying channel request");
          if (this.retryDelayMs > 0) await delay(this.retryDelayMs * attempt);
        }
      }
    }

    throw lastError ?? new Error(`Request failed: ${options.path}`);
  }

  /** 发请求但不关心响应体 */
  async requestVoid(options: ChannelRequestOptions): Promise<void> {
    await this.requestJson<unknown>(options);
  }

  /**
   * 向绝对地址 POST（webhook 回复场景，baseUrl 不适用）。
   */
  async postAbsolute(url: string, body: unknown): Promise<void> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} POST ${url.slice(0, 60)}`);
    }
  }
}
