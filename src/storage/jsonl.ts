/**
 * JSONL 追加日志
 *
 * 单次 `writeSync` 写完整批，保证每条记录要么整行落盘、要么不出现；
 * 可选 fsync。读取时按行解析，坏行计数后跳过。
 */

import * as fs from "fs";
import { dirname } from "path";

export interface JsonlAppenderOptions {
  /** 每批写入后 fsync，默认 true */
  fsync?: boolean;
}

interface ParseResult<T> {
  records: T[];
  corruptLines: number;
  tornRecords: number;
}

export class JsonlAppender {
  private readonly fsync: boolean;

  constructor(
    private readonly filePath: string,
    options: JsonlAppenderOptions = {}
  ) {
    this.fsync = options.fsync ?? true;
  }

  /** 追加一批记录（一次 write 调用写完整批）；fsync 可按调用覆盖 */
  append(records: unknown[], fsync = this.fsync): void {
    if (records.length === 0) return;
    fs.mkdirSync(dirname(this.filePath), { recursive: true });

    const payload = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    const fd = fs.openSync(this.filePath, "a");
    try {
      fs.writeSync(fd, payload);
      if (fsync) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** 读取并解析全部记录；坏行被跳过并计数 */
  readAll<T>(): ParseResult<T> {
    if (!fs.existsSync(this.filePath)) {
      return { records: [], corruptLines: 0, tornRecords: 0 };
    }
    return this.parse<T>(fs.readFileSync(this.filePath, "utf-8"));
  }

  /** 解析一段 JSONL 文本 */
  parse<T>(content: string): ParseResult<T> {
    const records: T[] = [];
    let corruptLines = 0;
    let tornRecords = 0;

    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as T);
      } catch {
        corruptLines += 1;
        // 最后一行没有换行符，通常是写入中途崩溃留下的残行
        if (index === lines.length - 1) tornRecords += 1;
      }
    }

    return { records, corruptLines, tornRecords };
  }
}
