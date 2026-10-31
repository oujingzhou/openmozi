/**
 * 追加式日志（JSONL）
 *
 * 崩溃一致性规则：
 * - 一批记录与一个 commit 行一起写入，才被视为已提交。
 * - 加载时若尾部存在无 commit 的记录，一律丢弃（torn tail）。
 * - 单行 JSON 解析失败只丢弃该行并计数，不使整个会话不可用。
 */

import * as fs from "fs";
import * as path from "path";
import { JsonlAppender, atomicWriteFile } from "../storage/index.js";
import {
  DURABLE_FORMAT_VERSION,
  type DurableRecord,
  type JournalCommit,
  type JournalHeader,
  type JournalLine,
  type JournaledRecord,
} from "./types.js";

/** 日志写入选项 */
export interface JournalOptions {
  /** 每批提交后 fsync */
  fsync?: boolean;
  /** 单行解析失败上限，超过则判定文件损坏 */
  maxCorruptLines?: number;
}

/** 日志加载结果 */
export interface JournalLoadResult {
  header: JournalHeader | null;
  records: JournaledRecord[];
  /** 已提交的最大序号 */
  lastSeq: number;
  /** 被丢弃的尾部未提交记录数 */
  tornRecords: number;
  /** 被丢弃的损坏行数 */
  corruptLines: number;
}

export class DurableJournal {
  readonly filePath: string;
  private readonly options: Required<JournalOptions>;
  /** 头信息（load 之后可用） */
  header: JournalHeader | null = null;
  /** 已提交的最大序号（appending 会推进它） */
  lastSeq = 0;
  private initialized = false;
  private readonly appender: JsonlAppender;

  constructor(filePath: string, options: JournalOptions = {}) {
    this.filePath = filePath;
    this.options = {
      fsync: options.fsync ?? false,
      maxCorruptLines: options.maxCorruptLines ?? 100,
    };
    this.appender = new JsonlAppender(filePath, { fsync: this.options.fsync });
  }

  /**
   * 加载（或初始化）日志。
   * 返回丢弃信息，调用方可据此记录恢复过程中的数据损失。
   */
  load(init: { sessionKey: string; sessionId: string; cwd: string }): JournalLoadResult {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      this.header = {
        type: "header",
        version: DURABLE_FORMAT_VERSION,
        sessionKey: init.sessionKey,
        sessionId: init.sessionId,
        createdAt: Date.now(),
        cwd: init.cwd,
      };
      this.lastSeq = 0;
      this.initialized = true;
      this.writeLines([this.header]);
      return { header: this.header, records: [], lastSeq: 0, tornRecords: 0, corruptLines: 0 };
    }

    const result = this.parse(fs.readFileSync(this.filePath, "utf-8"));
    this.header = result.header;
    this.lastSeq = result.lastSeq;
    this.initialized = true;

    // 截断未提交尾部，避免后续追加被污染
    if (result.tornRecords > 0 || result.corruptLines > 0) {
      this.rewrite(result.header, result.records);
    }

    return result;
  }

  /** 追加一批记录，以 commit 行收尾即为原子提交 */
  append(records: DurableRecord[]): JournaledRecord[] {
    if (!this.initialized) {
      throw new Error("DurableJournal.load() must be called before append()");
    }
    // 空批次不写 commit，否则日志里会堆满无意义的行
    if (records.length === 0) return [];

    const at = Date.now();
    const journaled = records.map((record) => {
      this.lastSeq += 1;
      return { ...record, seq: this.lastSeq, at } as JournaledRecord;
    });

    const commit: JournalCommit = { type: "commit", seq: this.lastSeq, count: journaled.length, at };
    const lines: JournalLine[] = [
      ...journaled.map((record) => ({ ...record, type: "record" as const })),
      commit,
    ];

    this.writeLines(lines, this.options.fsync);
    return journaled;
  }

  /** 读取全部已提交记录（用于投影重建） */
  readAll(): JournaledRecord[] {
    if (!fs.existsSync(this.filePath)) return [];
    return this.parse(fs.readFileSync(this.filePath, "utf-8")).records;
  }

  private writeLines(lines: JournalLine[], fsync = false): void {
    this.appender.append(lines, fsync);
  }

  /** 原子重写（仅用于丢弃损坏/未提交尾部） */
  private rewrite(header: JournalHeader | null, records: JournaledRecord[]): void {
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const lines: string[] = [];
    if (header) lines.push(JSON.stringify(header));
    for (const record of records) {
      lines.push(JSON.stringify({ ...record, type: "record" }));
    }
    if (records.length > 0) {
      const commit: JournalCommit = {
        type: "commit",
        seq: records[records.length - 1]!.seq,
        count: records.length,
        at: Date.now(),
      };
      lines.push(JSON.stringify(commit));
    }
    // 用共享的原子写（tmp → fsync → rename → fsync(dir)）：
    // 之前这里既没 fsync 也没走统一实现，断电可能留下空日志。
    atomicWriteFile(this.filePath, lines.length > 0 ? lines.join("\n") + "\n" : "", {
      fsync: this.options.fsync,
    });
  }

  private parse(content: string): JournalLoadResult {
    const result: JournalLoadResult = {
      header: null,
      records: [],
      lastSeq: 0,
      tornRecords: 0,
      corruptLines: 0,
    };

    let pending: JournaledRecord[] = [];
    let corrupt = 0;

    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;

      let parsed: JournalLine | null = null;
      try {
        parsed = JSON.parse(line) as JournalLine;
      } catch {
        corrupt += 1;
        pending = [];
        continue;
      }

      if (!parsed || typeof parsed !== "object") {
        corrupt += 1;
        pending = [];
        continue;
      }

      if (parsed.type === "header") {
        result.header = parsed;
        continue;
      }

      if (parsed.type === "record") {
        const { type: _ignored, ...rest } = parsed as JournaledRecord & { type: "record" };
        pending.push(rest as JournaledRecord);
        continue;
      }

      if (parsed.type === "commit") {
        // count 不匹配说明该批次不完整，整批丢弃
        if (pending.length === parsed.count) {
          result.records.push(...pending);
          result.lastSeq = Math.max(result.lastSeq, parsed.seq);
        } else {
          corrupt += 1;
        }
        pending = [];
        continue;
      }

      corrupt += 1;
    }

    // 尾部剩余即未提交批次
    result.tornRecords = pending.length;
    result.corruptLines = corrupt;

    if (corrupt > this.options.maxCorruptLines) {
      throw new Error(`Journal ${this.filePath} is corrupt (${corrupt} bad lines)`);
    }

    return result;
  }
}
