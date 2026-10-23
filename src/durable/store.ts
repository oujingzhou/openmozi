/**
 * Durable store - 会话日志的生命周期管理
 *
 * 职责：
 * 1. 每个会话一个日志文件，按 sessionKey 索引。
 * 2. 打开时执行恢复：任何"已开始未结束"的回合与工具调用都被补写为 interrupted，
 *    保证模型上下文与 UI 都不会看到悬空的 tool call。
 * 3. 提供 append + 订阅（实时事件带 seq，客户端据此检测缺口）。
 */

import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";
import { getChildLogger } from "../utils/logger.js";
import { DurableJournal } from "./journal.js";
import { buildSnapshot, projectTurns } from "./projection.js";
import type {
  DurableLiveEvent,
  DurableRecord,
  DurableSessionSnapshot,
  JournaledRecord,
  SequencedLiveEvent,
} from "./types.js";

const logger = getChildLogger("durable");

/** 单个会话的日志句柄 */
export interface DurableSession {
  sessionKey: string;
  sessionId: string;
  journal: DurableJournal;
  /** 日志文件路径 */
  file: string;
}

/** 事件订阅者 */
export type DurableListener = (event: SequencedLiveEvent) => void;

/** 恢复报告 */
export interface RecoveryReport {
  sessionKey: string;
  /** 被强制结束的回合 */
  interruptedTurns: string[];
  /** 被标注为中断的工具调用 */
  interruptedTools: string[];
  /** 被丢弃的未提交尾部记录数 */
  tornRecords: number;
  corruptLines: number;
}

export interface DurableStoreOptions {
  /** 日志目录，默认 ~/.mozi/sessions */
  directory?: string;
  /** 每批写入后 fsync（默认开启，durable 的意义所在） */
  fsync?: boolean;
}

/** 会话 key 到文件名的安全映射 */
function toFileName(sessionKey: string): string {
  const safe = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safe}.jsonl`;
}

export class DurableStore {
  private readonly directory: string;
  private readonly fsync: boolean;
  private readonly sessions = new Map<string, DurableSession>();
  private readonly listeners = new Set<DurableListener>();

  constructor(options: DurableStoreOptions = {}) {
    this.directory = options.directory ?? path.join(os.homedir(), ".mozi", "sessions");
    this.fsync = options.fsync ?? true;
  }

  /** 打开（或创建）会话，并完成崩溃恢复 */
  open(sessionKey: string, cwd = process.cwd()): { session: DurableSession; recovery: RecoveryReport } {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      return {
        session: existing,
        recovery: { sessionKey, interruptedTurns: [], interruptedTools: [], tornRecords: 0, corruptLines: 0 },
      };
    }

    const file = path.join(this.directory, toFileName(sessionKey));
    const journal = new DurableJournal(file, { fsync: this.fsync });
    const loaded = journal.load({ sessionKey, sessionId: randomUUID(), cwd });
    const sessionId = loaded.header?.sessionId ?? randomUUID();
    const session: DurableSession = { sessionKey, sessionId, journal, file };
    this.sessions.set(sessionKey, session);

    const recovery = this.recover(session, loaded.records, loaded.tornRecords, loaded.corruptLines);
    if (
      recovery.interruptedTurns.length > 0 ||
      recovery.tornRecords > 0 ||
      recovery.corruptLines > 0
    ) {
      logger.warn(recovery, "Recovered session with interrupted work");
    }

    return { session, recovery };
  }

  /**
   * 恢复：把未完成的回合与工具调用补写为 interrupted。
   *
   * 这一步是 durable execution 的核心——它把"进程死掉时正在做什么"变成
   * 显式的历史记录，而不是让下一次 prompt 面对一个悬空的 tool_call。
   */
  private recover(
    session: DurableSession,
    records: JournaledRecord[],
    tornRecords: number,
    corruptLines: number
  ): RecoveryReport {
    const report: RecoveryReport = {
      sessionKey: session.sessionKey,
      interruptedTurns: [],
      interruptedTools: [],
      tornRecords,
      corruptLines,
    };

    const turns = projectTurns(records);
    const repairs: DurableRecord[] = [];

    for (const turn of turns) {
      if (!turn.running) continue;
      report.interruptedTurns.push(turn.turnId);

      for (const step of turn.steps) {
        for (const tool of step.tools) {
          if (tool.state !== "running") continue;
          report.interruptedTools.push(tool.callId);
          repairs.push({
            kind: "tool-result",
            turnId: turn.turnId,
            callId: tool.callId,
            name: tool.name,
            text: `Tool ${tool.name} was interrupted before completion. Its effects may be partial; re-check the result before relying on it.`,
            isError: true,
            interrupted: true,
          });
        }
      }

      repairs.push({ kind: "turn-end", turnId: turn.turnId, reason: "interrupted" });
    }


    if (repairs.length > 0) session.journal.append(repairs);

    return report;
  }

  /** 写入一批记录并广播对应事件 */
  append(sessionKey: string, records: DurableRecord[], events: DurableLiveEvent[] = []): JournaledRecord[] {
    const session = this.get(sessionKey);
    const journaled = session.journal.append(records);
    this.publish(sessionKey, journaled, events);
    return journaled;
  }

  /**
   * 只广播、不写日志。
   * 流式增量用它：界面需要高频推送，但日志只需要低频中间态。
   */
  publishLive(sessionKey: string, events: DurableLiveEvent[]): void {
    if (events.length === 0) return;
    const session = this.get(sessionKey);
    const seq = session.journal.lastSeq;
    for (const event of events) {
      const sequenced: SequencedLiveEvent = { ...event, seq, sessionKey, transient: true };
      for (const listener of this.listeners) {
        try {
          listener(sequenced);
        } catch (error) {
          logger.warn({ error }, "Durable listener failed");
        }
      }
    }
  }

  /** 只写日志、不广播（用于内部修复） */
  appendSilently(sessionKey: string, records: DurableRecord[]): JournaledRecord[] {
    return this.get(sessionKey).journal.append(records);
  }

  /**
   * 广播事件。
   * events 与 records 按位置对应：第 i 个事件继承第 i 条记录的 seq，
   * 数量不一致时退回最后一条记录的 seq。
   */
  private publish(sessionKey: string, journaled: JournaledRecord[], events: DurableLiveEvent[]): void {
    if (events.length === 0) return;
    // 纯事件（不落盘）沿用当前日志序号，保证 seq 单调
    const lastSeq =
      journaled.length > 0 ? journaled[journaled.length - 1]!.seq : this.sessions.get(sessionKey)?.journal.lastSeq ?? 0;

    events.forEach((event, index) => {
      const seq = journaled[index]?.seq ?? lastSeq;
      const sequenced: SequencedLiveEvent = { ...event, seq, sessionKey };
      for (const listener of this.listeners) {
        try {
          listener(sequenced);
        } catch (error) {
          logger.warn({ error }, "Durable listener failed");
        }
      }
    });
  }

  /** 订阅所有会话的实时事件 */
  subscribe(listener: DurableListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 获取已打开的会话 */
  get(sessionKey: string): DurableSession {
    const session = this.sessions.get(sessionKey);
    if (!session) throw new Error(`Durable session not opened: ${sessionKey}`);
    return session;
  }

  has(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  /** 读取全部记录（含最新提交） */
  readRecords(sessionKey: string): JournaledRecord[] {
    return this.get(sessionKey).journal.readAll();
  }

  /** 构造当前快照 */
  snapshot(sessionKey: string): DurableSessionSnapshot {
    const session = this.get(sessionKey);
    return buildSnapshot({
      sessionKey,
      sessionId: session.sessionId,
      records: session.journal.readAll(),
      seq: session.journal.lastSeq,
    });
  }

  /** 列出所有已知会话（含未打开的） */
  listKnownSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  close(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }
}

/** 全局 store */
let globalStore: DurableStore | null = null;

export function getDurableStore(options?: DurableStoreOptions): DurableStore {
  if (!globalStore) globalStore = new DurableStore(options);
  return globalStore;
}

export function initDurableStore(options?: DurableStoreOptions): DurableStore {
  globalStore = new DurableStore(options);
  return globalStore;
}
