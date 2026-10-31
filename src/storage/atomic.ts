/**
 * 原子文件写入
 *
 * 语义：写 tmp → fsync → rename → fsync(dir)。
 * 任何一步失败都不会破坏原文件；可选在覆盖前留一份 .bak。
 */

import * as fs from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";

export interface AtomicWriteOptions {
  /** 覆盖前把旧文件复制为 `<path>.bak`（best-effort） */
  backup?: boolean;
  /** 是否 fsync 数据与目录，默认 true */
  fsync?: boolean;
  /** 文件权限，默认 0o600（配置文件里常有密钥） */
  mode?: number;
}

/** fsync 一个目录，确保 rename 落盘 */
function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    // 某些平台/文件系统不支持对目录 fsync，忽略
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // 忽略
      }
    }
  }
}

/** 原子写入任意文本内容 */
export function atomicWriteFile(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {}
): void {
  const { backup = false, fsync = true, mode = 0o600 } = options;
  const dir = dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  if (backup && fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, `${filePath}.bak`);
    } catch {
      // 备份是 best-effort，不影响主流程
    }
  }

  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, "w", mode);
  try {
    fs.writeFileSync(fd, content, "utf-8");
    if (fsync) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 忽略
    }
    throw error;
  }

  if (fsync) fsyncDir(dir);
}

/**
 * 序列化成 JSON 后原子写入。
 *
 * `serialize` 用于需要保留 JSON5 风格（无引号 key）的配置文件；
 * 默认走 `JSON.stringify`，字符串转义天然正确。
 */
export function atomicWriteJson(
  filePath: string,
  value: unknown,
  options: AtomicWriteOptions & {
    indent?: number;
    serialize?: (value: unknown) => string;
  } = {}
): void {
  const { indent = 2, serialize, ...writeOptions } = options;
  const content = serialize ? serialize(value) : JSON.stringify(value, null, indent);
  atomicWriteFile(filePath, content, writeOptions);
}

/**
 * 读取并解析 JSON；文件不存在返回 undefined。
 * 解析失败向上抛出，由调用方决定是拒绝写入还是降级。
 */
export function readJsonFile<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}
