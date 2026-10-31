/**
 * 同会话并发的回归测试
 *
 * chat() 原来没有 busy 守卫（只有 chatStream 有），
 * 两个并发请求会共享同一个 TurnRecorder，durable 日志里的 step 归属会互相覆盖。
 * 这里用显式的"放行闸门"代替 sleep，确定性地证明：
 * 同会话的回合严格串行，不同会话之间仍然并发。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/** 当前正在执行的回合数 */
let activeTurns = 0;
/** 观察到的最大并发回合并发数 */
let maxConcurrent = 0;
/** 已进入 prompt、等待放行的回合放行器 */
const pendingReleases: Array<() => void> = [];
/** 状态变化通知器：有新回合进入或有回合结束时 resolve */
let notifyChange: (() => void) | null = null;

function signalChange(): void {
  const notify = notifyChange;
  notifyChange = null;
  notify?.();
}

/** 等待下一次状态变化（不依赖真实时钟） */
function waitForChange(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  notifyChange = resolve;
  return promise;
}

/** 等待至少有一个回合卡在闸门上 */
async function waitForPending(count = 1): Promise<void> {
  while (pendingReleases.length < count) {
    await waitForChange();
  }
}

/** 放行最早进入的回合 */
function releaseOne(): void {
  const release = pendingReleases.shift();
  release?.();
}

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: vi.fn(async () => ({
    session: {
      prompt: vi.fn(async () => {
        activeTurns += 1;
        maxConcurrent = Math.max(maxConcurrent, activeTurns);
        const { promise, resolve } = Promise.withResolvers<void>();
        pendingReleases.push(resolve);
        signalChange();
        await promise;
        activeTurns -= 1;
        signalChange();
      }),
      subscribe: vi.fn(() => () => {}),
      getLastAssistantText: vi.fn(() => "ok"),
      getSessionStats: vi.fn(() => ({ tokens: { input: 1, output: 1, total: 2 }, totalMessages: 1 })),
      messages: [],
      dispose: vi.fn(),
      agent: {
        setSystemPrompt: vi.fn(),
        setTools: vi.fn(),
        setAfterToolCall: vi.fn(),
        waitForIdle: vi.fn(async () => {}),
        abort: vi.fn(),
      },
    },
  })),
  SessionManager: {
    create: vi.fn(() => ({
      setSessionFile: vi.fn(),
      getEntries: vi.fn(() => []),
      getSessionId: vi.fn(() => "test-session-id"),
      appendMessage: vi.fn(),
    })),
  },
  AuthStorage: { inMemory: vi.fn(() => ({ set: vi.fn(), setFallbackResolver: vi.fn() })) },
  ModelRegistry: vi.fn(() => ({})),
}));

vi.mock("../src/providers/model-resolver.js", () => ({
  resolveModel: vi.fn(() => ({
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    provider: "test-provider",
    baseUrl: "https://api.test.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  })),
  initModelResolver: vi.fn(),
  getApiKeyForProvider: vi.fn(() => "test-api-key"),
}));

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../src/agents/system-prompt.js", () => ({
  buildSystemPrompt: vi.fn(() => "Test system prompt"),
}));

import { AgentRuntime } from "../src/agents/runtime.js";

describe("AgentRuntime concurrency", () => {
  let runtime: AgentRuntime;
  let testDir: string;

  const context = (sessionId: string, messageId: string) => ({
    channelId: "webchat" as const,
    chatId: `webchat:${sessionId}`,
    chatType: "direct" as const,
    senderId: sessionId,
    senderName: "tester",
    content: "hi",
    messageId,
    timestamp: Date.now(),
  });

  beforeEach(() => {
    activeTurns = 0;
    maxConcurrent = 0;
    pendingReleases.length = 0;
    notifyChange = null;
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-conc-"));
    runtime = new AgentRuntime({
      model: "test-model",
      provider: "test-provider" as never,
      workingDirectory: "/tmp/test",
      sessionDir: testDir,
      durableFsync: false,
    });
  });

  afterEach(() => {
    // 保险：任何残留闸门都放行，避免测试挂死
    while (pendingReleases.length > 0) releaseOne();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("serializes turns that target the same session", async () => {
    const turns = [
      runtime.chat(context("same", "m1")),
      runtime.chat(context("same", "m2")),
      runtime.chat(context("same", "m3")),
    ];

    // 逐个放行：每放行一个之前，都不能有第二个回合进来
    for (let index = 0; index < 3; index += 1) {
      await waitForPending(1);
      expect(activeTurns).toBe(1);
      expect(maxConcurrent).toBe(1);
      releaseOne();
      await Promise.resolve();
    }

    await Promise.all(turns);
    expect(maxConcurrent).toBe(1);
  });

  it("still runs different sessions in parallel", async () => {
    const turns = [runtime.chat(context("a", "m1")), runtime.chat(context("b", "m2"))];

    await waitForPending(2);
    expect(maxConcurrent).toBe(2);

    releaseOne();
    releaseOne();
    await Promise.all(turns);
  });

  it("records every concurrent turn separately in the durable log", async () => {
    const turns = [runtime.chat(context("same", "m1")), runtime.chat(context("same", "m2"))];

    for (let index = 0; index < 2; index += 1) {
      await waitForPending(1);
      releaseOne();
      await Promise.resolve();
    }
    await Promise.all(turns);

    const snapshot = runtime.getSnapshot("webchat:same");
    expect(snapshot?.turns).toHaveLength(2);
    expect(new Set(snapshot!.turns.map((turn) => turn.turnId)).size).toBe(2);
  });
});
