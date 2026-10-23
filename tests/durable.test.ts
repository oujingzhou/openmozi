/**
 * Durable execution 测试
 *
 * 重点覆盖崩溃语义，而不是 happy path：
 * - 未提交的尾部必须被丢弃
 * - 已开始未结束的回合/工具调用必须被补写为 interrupted
 * - requestId 幂等
 * - 投影按 step / tool 正确折叠
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { DurableJournal } from "../src/durable/journal.js";
import { DurableStore } from "../src/durable/store.js";
import { buildSnapshot, foldQueue, projectTurns } from "../src/durable/projection.js";
import { replayClassFor } from "../src/durable/recorder.js";
import type { DurableRecord } from "../src/durable/types.js";

describe("durable/journal", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-journal-"));
    file = path.join(dir, "session.jsonl");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates a header for a new journal", () => {
    const journal = new DurableJournal(file);
    const loaded = journal.load({ sessionKey: "webchat:1", sessionId: "sid-1", cwd: "/tmp" });

    expect(loaded.header?.version).toBe(1);
    expect(loaded.header?.sessionKey).toBe("webchat:1");
    expect(loaded.records).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("commits a batch so it survives reload", () => {
    const journal = new DurableJournal(file);
    journal.load({ sessionKey: "k", sessionId: "s", cwd: "/tmp" });
    journal.append([{ kind: "turn", turnId: "t1", requestId: "r1", content: "hi", source: "test" }]);

    const reopened = new DurableJournal(file);
    const loaded = reopened.load({ sessionKey: "k", sessionId: "s", cwd: "/tmp" });

    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0]?.kind).toBe("turn");
    expect(loaded.lastSeq).toBe(1);
    expect(loaded.tornRecords).toBe(0);
  });

  it("drops an uncommitted tail (simulated crash mid-append)", () => {
    const journal = new DurableJournal(file);
    journal.load({ sessionKey: "k", sessionId: "s", cwd: "/tmp" });
    journal.append([{ kind: "turn", turnId: "t1", requestId: "r1", content: "hi", source: "test" }]);

    // 模拟写了一半：有 record 但没有 commit
    fs.appendFileSync(
      file,
      JSON.stringify({ kind: "turn", turnId: "t2", requestId: "r2", content: "lost", source: "test", seq: 2, at: Date.now(), type: "record" }) + "\n"
    );

    const reopened = new DurableJournal(file);
    const loaded = reopened.load({ sessionKey: "k", sessionId: "s", cwd: "/tmp" });

    expect(loaded.records).toHaveLength(1);
    expect(loaded.tornRecords).toBe(1);
    // 截断后继续追加，序号必须连贯
    expect(journal.lastSeq).toBe(1);
    reopened.append([{ kind: "turn-end", turnId: "t1", reason: "completed" }]);
    expect(reopened.lastSeq).toBe(2);

    const final = new DurableJournal(file).load({ sessionKey: "k", sessionId: "s", cwd: "/tmp" });
    expect(final.records.map((record) => record.kind)).toEqual(["turn", "turn-end"]);
    expect(final.tornRecords).toBe(0);
  });

  it("rejects a batch whose record count does not match its commit", () => {
    const journal = new DurableJournal(file);
    journal.load({ sessionKey: "k", sessionId: "s", cwd: "/tmp" });

    // 2 条记录但 commit 声称 3 条
    fs.appendFileSync(
      file,
      [
        JSON.stringify({ kind: "turn", turnId: "t1", requestId: "r1", content: "a", source: "t", seq: 1, at: 1, type: "record" }),
        JSON.stringify({ kind: "turn", turnId: "t2", requestId: "r2", content: "b", source: "t", seq: 2, at: 1, type: "record" }),
        JSON.stringify({ type: "commit", seq: 3, count: 3, at: 1 }),
      ].join("\n") + "\n"
    );

    const loaded = new DurableJournal(file).load({ sessionKey: "k", sessionId: "s", cwd: "/tmp" });
    expect(loaded.records).toHaveLength(0);
  });

  it("tolerates corrupt lines and counts them", () => {
    const journal = new DurableJournal(file);
    journal.load({ sessionKey: "k", sessionId: "s", cwd: "/tmp" });
    fs.appendFileSync(file, "not json at all\n");

    const loaded = new DurableJournal(file).load({ sessionKey: "k", sessionId: "s", cwd: "/tmp" });
    expect(loaded.corruptLines).toBe(1);
  });
});

describe("durable/projection", () => {
  const at = (seq: number): { seq: number; at: number } => ({ seq, at: seq });

  it("folds a turn into user content, steps and tools", () => {
    const records: DurableRecord[] = [
      { kind: "turn", turnId: "t1", requestId: "r1", content: "list files", source: "webchat" },
      { kind: "assistant", turnId: "t1", stepId: "step-0", text: "Sure" },
      { kind: "tool-intent", turnId: "t1", callId: "c1", name: "bash", args: { command: "ls" }, replay: "unsafe" },
      { kind: "tool-result", turnId: "t1", callId: "c1", name: "bash", text: "a.txt", isError: false, durationMs: 42 },
      { kind: "assistant", turnId: "t1", stepId: "step-1", text: "Found a.txt" },
      { kind: "turn-end", turnId: "t1", reason: "completed" },
    ].map((record, index) => ({ ...record, ...at(index + 1) }));

    const turns = projectTurns(records);
    expect(turns).toHaveLength(1);

    const turn = turns[0]!;
    expect(turn.content).toBe("list files");
    expect(turn.running).toBe(false);
    expect(turn.reason).toBe("completed");
    expect(turn.steps.map((step) => step.stepId)).toEqual(["step-0", "step-1"]);

    const tool = turn.steps[0]!.tools[0]!;
    expect(tool.callId).toBe("c1");
    expect(tool.state).toBe("done");
    expect(tool.durationMs).toBe(42);
    expect(turn.steps[1]!.text).toBe("Found a.txt");
  });

  it("keeps tool results in the step that issued them even when callIds repeat", () => {
    // provider 在多个 step 复用同一个 callId 时必须按 step 归属
    const records = [
      { kind: "turn", turnId: "t1", requestId: "r1", content: "go", source: "webchat", seq: 1, at: 1 },
      { kind: "assistant", turnId: "t1", stepId: "step-0", text: "", seq: 2, at: 2 },
      { kind: "tool-intent", turnId: "t1", stepId: "step-0", callId: "dup", name: "read", args: {}, replay: "safe", seq: 3, at: 3 },
      { kind: "tool-result", turnId: "t1", stepId: "step-0", callId: "dup", name: "read", text: "first", isError: true, seq: 4, at: 4 },
      { kind: "assistant", turnId: "t1", stepId: "step-1", text: "", seq: 5, at: 5 },
      { kind: "tool-intent", turnId: "t1", stepId: "step-1", callId: "dup", name: "read", args: {}, replay: "safe", seq: 6, at: 6 },
      { kind: "tool-result", turnId: "t1", stepId: "step-1", callId: "dup", name: "read", text: "second", isError: false, seq: 7, at: 7 },
      { kind: "turn-end", turnId: "t1", reason: "completed", seq: 8, at: 8 },
    ] as DurableRecord[];

    const turn = projectTurns(records)[0]!;
    expect(turn.steps).toHaveLength(2);
    expect(turn.steps[0]!.tools[0]!.text).toBe("first");
    expect(turn.steps[0]!.tools[0]!.state).toBe("error");
    expect(turn.steps[1]!.tools[0]!.text).toBe("second");
    expect(turn.steps[1]!.tools[0]!.state).toBe("done");
  });

  it("marks a turn without turn-end as running", () => {
    const records = [
      { kind: "turn", turnId: "t1", requestId: "r1", content: "hi", source: "webchat", seq: 1, at: 1 },
      { kind: "tool-intent", turnId: "t1", callId: "c1", name: "bash", args: {}, replay: "unsafe", seq: 2, at: 2 },
    ] as DurableRecord[];

    const turns = projectTurns(records);
    expect(turns[0]!.running).toBe(true);
    expect(turns[0]!.steps[0]!.tools[0]!.state).toBe("running");
  });

  it("clears history on reset", () => {
    const records = [
      { kind: "turn", turnId: "t1", requestId: "r1", content: "hi", source: "webchat", seq: 1, at: 1 },
      { kind: "turn-end", turnId: "t1", reason: "completed", seq: 2, at: 2 },
      { kind: "reset", reason: "user", seq: 3, at: 3 },
      { kind: "turn", turnId: "t2", requestId: "r2", content: "new", source: "webchat", seq: 4, at: 4 },
    ] as DurableRecord[];

    const turns = projectTurns(records);
    expect(turns.map((turn) => turn.turnId)).toEqual(["t2"]);
  });

  it("builds a snapshot with running state and seq", () => {
    const records = [
      { kind: "turn", turnId: "t1", requestId: "r1", content: "hi", source: "webchat", seq: 1, at: 1 },
    ] as DurableRecord[];

    const snapshot = buildSnapshot({ sessionKey: "k", sessionId: "s", records, seq: 7 });
    expect(snapshot.seq).toBe(7);
    expect(snapshot.running).toBe(true);
    expect(snapshot.turns).toHaveLength(1);
  });
});

describe("durable/store recovery", () => {
  let dir: string;
  let store: DurableStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-store-"));
    store = new DurableStore({ directory: dir, fsync: false });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rewrites an interrupted turn and its in-flight tool call", () => {
    const { session } = store.open("webchat:client1", "/tmp");
    session.journal.append([
      { kind: "turn", turnId: "t1", requestId: "r1", content: "run it", source: "webchat" },
      { kind: "assistant", turnId: "t1", stepId: "step-0", text: "running" },
      { kind: "tool-intent", turnId: "t1", callId: "c1", name: "bash", args: { command: "sleep 100" }, replay: "unsafe" },
    ]);

    // 新 store 实例 = 进程重启
    const restarted = new DurableStore({ directory: dir, fsync: false });
    const { recovery } = restarted.open("webchat:client1", "/tmp");

    expect(recovery.interruptedTurns).toEqual(["t1"]);
    expect(recovery.interruptedTools).toEqual(["c1"]);

    const snapshot = restarted.snapshot("webchat:client1");
    expect(snapshot.running).toBe(false);
    const turn = snapshot.turns[0]!;
    expect(turn.reason).toBe("interrupted");

    const tool = turn.steps[0]!.tools[0]!;
    expect(tool.state).toBe("interrupted");
    expect(tool.isError).toBe(true);
    expect(tool.text).toContain("interrupted");
  });

  it("resolves every in-flight tool when a session crashes mid tool loop", () => {
    const { session } = store.open("webchat:loop", "/tmp");
    session.journal.append([
      { kind: "turn", turnId: "t1", requestId: "r1", content: "go", source: "webchat" },
      { kind: "assistant", turnId: "t1", stepId: "step-0", text: "" },
      { kind: "tool-intent", turnId: "t1", stepId: "step-0", callId: "c1", name: "bash", args: {}, replay: "unsafe" },
      { kind: "tool-result", turnId: "t1", stepId: "step-0", callId: "c1", name: "bash", text: "ok", isError: false },
      { kind: "assistant", turnId: "t1", stepId: "step-1", text: "" },
      { kind: "tool-intent", turnId: "t1", stepId: "step-1", callId: "c1", name: "bash", args: {}, replay: "unsafe" },
    ]);

    const restarted = new DurableStore({ directory: dir, fsync: false });
    const { recovery } = restarted.open("webchat:loop", "/tmp");
    expect(recovery.interruptedTools).toEqual(["c1"]);

    const steps = restarted.snapshot("webchat:loop").turns[0]!.steps;
    expect(steps[0]!.tools[0]!.state).toBe("done");
    expect(steps[1]!.tools[0]!.state).toBe("interrupted");
  });

  it("leaves completed sessions untouched", () => {
    const { session } = store.open("webchat:done", "/tmp");
    session.journal.append([
      { kind: "turn", turnId: "t1", requestId: "r1", content: "hi", source: "webchat" },
      { kind: "turn-end", turnId: "t1", reason: "completed" },
    ]);

    const restarted = new DurableStore({ directory: dir, fsync: false });
    const { recovery } = restarted.open("webchat:done", "/tmp");
    expect(recovery.interruptedTurns).toHaveLength(0);

    const snapshot = restarted.snapshot("webchat:done");
    expect(snapshot.running).toBe(false);
    expect(snapshot.turns[0]!.reason).toBe("completed");
  });

  it("publishes sequenced live events for appended records", () => {
    const { session } = store.open("webchat:events", "/tmp");
    const received: Array<{ type: string; seq: number }> = [];
    const unsubscribe = store.subscribe((event) => {
      received.push({ type: event.type, seq: event.seq });
    });

    store.append(
      "webchat:events",
      [{ kind: "turn", turnId: "t1", requestId: "r1", content: "hi", source: "webchat" }],
      [{ type: "turn_start", turnId: "t1", requestId: "r1", createdAt: 1, resumed: false, content: "hi" }]
    );
    unsubscribe();

    expect(received).toEqual([{ type: "turn_start", seq: 1 }]);
    expect(session.journal.lastSeq).toBe(1);
  });

  it("isolates sessions by key", () => {
    store.open("a", "/tmp");
    store.open("b", "/tmp");
    store.append("a", [{ kind: "turn", turnId: "t1", requestId: "r1", content: "A", source: "t" }]);
    store.append("b", [{ kind: "turn", turnId: "t2", requestId: "r2", content: "B", source: "t" }]);

    expect(store.snapshot("a").turns[0]!.content).toBe("A");
    expect(store.snapshot("b").turns[0]!.content).toBe("B");
  });
});

describe("durable/queue projection", () => {
  const queued = (queueId: string, at: number): DurableRecord =>
    ({
      kind: "queued",
      queueId,
      content: `消息 ${queueId}`,
      behavior: "followUp",
      channelId: "webchat",
      chatId: "webchat:test",
      senderId: "u",
      seq: at,
      at,
    }) as DurableRecord;

  it("keeps pending messages in order", () => {
    const queue = foldQueue([queued("a", 2), queued("b", 1)]);
    expect(queue.map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("drops delivered and removed items", () => {
    const records = [
      queued("a", 1),
      queued("b", 2),
      { kind: "dequeued", queueId: "a", reason: "delivered", seq: 3, at: 3 } as DurableRecord,
      { kind: "dequeued", queueId: "b", reason: "removed", seq: 4, at: 4 } as DurableRecord,
    ];
    expect(foldQueue(records)).toHaveLength(0);
  });

  it("clears on reset", () => {
    const records = [queued("a", 1), { kind: "reset", reason: "user", seq: 2, at: 2 } as DurableRecord];
    expect(foldQueue(records)).toHaveLength(0);
  });

  it("is exposed on the snapshot", () => {
    const snapshot = buildSnapshot({
      sessionKey: "webchat:test",
      sessionId: "s",
      records: [queued("a", 1)],
      seq: 1,
    });
    expect(snapshot.queued).toHaveLength(1);
    expect(snapshot.queued[0]!.content).toBe("消息 a");
  });

  it("never re-queues an item that was dequeued", () => {
    const records = [
      queued("a", 1),
      { kind: "dequeued", queueId: "a", reason: "delivered", seq: 2, at: 2 } as DurableRecord,
      queued("a", 3),
    ];
    expect(foldQueue(records).map((item) => item.id)).toEqual(["a"]);
  });
});

describe("durable/replay classification", () => {
  it("treats read-only tools as replay-safe", () => {
    expect(replayClassFor("read")).toBe("safe");
    expect(replayClassFor("grep")).toBe("safe");
    expect(replayClassFor("web_search")).toBe("safe");
  });

  it("treats side-effecting tools as unsafe", () => {
    expect(replayClassFor("bash")).toBe("unsafe");
    expect(replayClassFor("write")).toBe("unsafe");
    expect(replayClassFor("apply_patch")).toBe("unsafe");
  });
});
