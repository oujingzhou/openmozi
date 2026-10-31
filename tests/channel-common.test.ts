/**
 * 通道公共层的单元测试
 *
 * 这四个适配器现在共用 ChannelHttpClient / TokenProvider / BaseChannelAdapter，
 * 所以这三处的行为等价于四个通道的行为，必须单独覆盖。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelHttpClient, ChannelHttpError } from "../src/channels/common/http.js";
import { TokenProvider } from "../src/channels/common/token.js";
import { BaseChannelAdapter } from "../src/channels/common/base.js";
import type { OutboundMessage } from "../src/types/index.js";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describe("ChannelHttpClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds URLs with query params and supports absolute paths", () => {
    const client = new ChannelHttpClient({ baseUrl: "https://api.example.com" });
    expect(client.buildUrl("/v1/messages", { a: "1", skip: undefined })).toBe(
      "https://api.example.com/v1/messages?a=1"
    );
    expect(client.buildUrl("https://other.example.com/token")).toBe("https://other.example.com/token");
  });

  it("does not retry 4xx responses", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 400 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new ChannelHttpClient({ baseUrl: "https://api.example.com", maxRetries: 3, retryDelayMs: 0 });
    await expect(client.requestJson({ path: "/x" })).rejects.toBeInstanceOf(ChannelHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries 5xx responses and eventually surfaces the failure", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 503 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new ChannelHttpClient({ baseUrl: "https://api.example.com", maxRetries: 2, retryDelayMs: 0 });
    await expect(client.requestJson({ path: "/x" })).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers when a retry succeeds", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response("boom", { status: 500 });
      return Response.json({ ok: true });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new ChannelHttpClient({ baseUrl: "https://api.example.com", maxRetries: 3, retryDelayMs: 0 });
    await expect(client.requestJson({ path: "/x" })).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});

describe("TokenProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shares one in-flight request between concurrent callers", async () => {
    const fetchToken = vi.fn(async () => {
      const { promise, resolve } = Promise.withResolvers<{ token: string; expiresInSec: number }>();
      queueMicrotask(() => resolve({ token: "tok", expiresInSec: 3600 }));
      return promise;
    });

    const provider = new TokenProvider({ fetch: fetchToken });
    const tokens = await Promise.all([provider.get(), provider.get(), provider.get()]);

    expect(tokens).toEqual(["tok", "tok", "tok"]);
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it("caches until the refresh skew is reached", async () => {
    let now = 1_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchToken = vi.fn(async () => ({ token: `tok-${fetchToken.mock.calls.length}`, expiresInSec: 100 }));

    const provider = new TokenProvider({ fetch: fetchToken, refreshSkewMs: 10_000 });
    expect(await provider.get()).toBe("tok-1");

    now += 50_000; // 仍在有效期内
    expect(await provider.get()).toBe("tok-1");

    now += 60_000; // 进入提前刷新窗口
    expect(await provider.get()).toBe("tok-2");

    dateSpy.mockRestore();
  });

  it("does not cache a failed fetch", async () => {
    const fetchToken = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ token: "recovered", expiresInSec: 60 });

    const provider = new TokenProvider({ fetch: fetchToken });
    await expect(provider.get()).rejects.toThrow("network");
    await expect(provider.get()).resolves.toBe("recovered");
  });

  it("refetches after invalidate", async () => {
    const fetchToken = vi.fn(async () => ({ token: `tok-${fetchToken.mock.calls.length}`, expiresInSec: 3600 }));
    const provider = new TokenProvider({ fetch: fetchToken });

    expect(await provider.get()).toBe("tok-1");
    provider.invalidate();
    expect(await provider.get()).toBe("tok-2");
  });
});

describe("BaseChannelAdapter.sendMessage", () => {
  class FakeChannel extends BaseChannelAdapter {
    readonly id = "webchat" as const;
    readonly meta = {
      id: "webchat" as const,
      name: "Fake",
      description: "",
      capabilities: {},
    };

    failWith: Error | null = null;
    returnId: string | undefined = "mid-1";

    protected async doSend(_message: OutboundMessage): Promise<string | void> {
      if (this.failWith) throw this.failWith;
      return this.returnId;
    }

    protected async checkHealth(): Promise<void> {}

    async initialize(): Promise<void> {}
    async shutdown(): Promise<void> {}
  }

  it("returns success with the platform message id", async () => {
    const channel = new FakeChannel();
    await expect(channel.sendMessage({ chatId: "c", content: "hi" })).resolves.toEqual({
      success: true,
      messageId: "mid-1",
    });
  });

  it("returns success without an id when the platform has none", async () => {
    const channel = new FakeChannel();
    channel.returnId = undefined;
    await expect(channel.sendMessage({ chatId: "c", content: "hi" })).resolves.toEqual({ success: true });
  });

  it("converts a thrown error into a failed SendResult instead of throwing", async () => {
    const channel = new FakeChannel();
    channel.failWith = new Error("platform down");

    await expect(channel.sendMessage({ chatId: "c", content: "hi" })).resolves.toEqual({
      success: false,
      error: "platform down",
    });
  });

  it("reports healthy only when checkHealth resolves", async () => {
    const channel = new FakeChannel();
    await expect(channel.isHealthy()).resolves.toBe(true);

    vi.spyOn(channel as unknown as { checkHealth: () => Promise<void> }, "checkHealth").mockRejectedValue(
      new Error("nope")
    );
    await expect(channel.isHealthy()).resolves.toBe(false);
  });
});
