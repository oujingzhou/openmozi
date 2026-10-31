/**
 * 通道 Token 缓存
 *
 * 四个通道原来各写了一份 token 缓存（两套不同实现、两种过期策略）。
 * 这里统一：单航班（并发请求只发一次）、提前刷新、失败不缓存。
 */

export interface TokenProviderOptions {
  /** 取新 token 的实现 */
  fetch: () => Promise<{ token: string; expiresInSec?: number }>;
  /** 默认有效期（秒），接口没返回时使用 */
  defaultTtlSec?: number;
  /** 提前多少毫秒视为过期，默认 60s */
  refreshSkewMs?: number;
}

export class TokenProvider {
  private token: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<string> | null = null;
  private readonly fetchToken: TokenProviderOptions["fetch"];
  private readonly defaultTtlSec: number;
  private readonly refreshSkewMs: number;

  constructor(options: TokenProviderOptions) {
    this.fetchToken = options.fetch;
    this.defaultTtlSec = options.defaultTtlSec ?? 7200;
    this.refreshSkewMs = options.refreshSkewMs ?? 60_000;
  }

  /** 取可用 token；并发调用共享同一次请求 */
  async get(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - this.refreshSkewMs) {
      return this.token;
    }

    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      const { token, expiresInSec } = await this.fetchToken();
      const ttlSec = expiresInSec && expiresInSec > 0 ? expiresInSec : this.defaultTtlSec;
      this.token = token;
      this.expiresAt = Date.now() + ttlSec * 1000;
      return token;
    })();

    try {
      return await this.inflight;
    } finally {
      // 失败时不留下已缓存 token，下次会重新获取
      this.inflight = null;
    }
  }

  /** 立即作废（收到 401 时调用） */
  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }
}
