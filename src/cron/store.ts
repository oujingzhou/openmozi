/**
 * 定时任务存储
 *
 * 参考 moltbot 的 store.ts 实现
 * JSON 文件存储，支持原子写入和备份
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import json5 from "json5";
import type { CronStoreFile, CronJob } from "./types.js";
import { atomicWriteJson } from "../storage/index.js";

/** 默认 Cron 数据目录 */
const CRON_DATA_DIR = join(homedir(), ".mozi", "cron");

/** 默认存储文件路径 */
export const DEFAULT_CRON_STORE_PATH = join(CRON_DATA_DIR, "jobs.json");

/**
 * 加载存储文件
 */
export function loadCronStore(storePath: string = DEFAULT_CRON_STORE_PATH): CronStoreFile {
  if (!existsSync(storePath)) {
    return { version: 1, jobs: [] };
  }

  try {
    const content = readFileSync(storePath, "utf-8");
    const data = json5.parse(content) as CronStoreFile;

    // 验证格式
    if (!data.version || !Array.isArray(data.jobs)) {
      return { version: 1, jobs: [] };
    }

    return data;
  } catch {
    return { version: 1, jobs: [] };
  }
}

/**
 * 保存存储文件 (原子写入)
 */
export function saveCronStore(store: CronStoreFile, storePath: string = DEFAULT_CRON_STORE_PATH): void {
  atomicWriteJson(storePath, store, { backup: true });
}

/**
 * Cron 存储管理器
 */
export class CronStore {
  private storePath: string;
  private store: CronStoreFile;
  private dirty: boolean = false;

  constructor(storePath: string = DEFAULT_CRON_STORE_PATH) {
    this.storePath = storePath;
    this.store = loadCronStore(storePath);
  }

  /** 获取所有任务 */
  getJobs(): CronJob[] {
    return this.store.jobs;
  }

  /** 获取单个任务 */
  getJob(id: string): CronJob | undefined {
    return this.store.jobs.find(j => j.id === id);
  }

  /** 按名称获取任务 */
  getJobByName(name: string): CronJob | undefined {
    return this.store.jobs.find(j => j.name === name);
  }

  /** 获取已启用的任务 */
  getEnabledJobs(): CronJob[] {
    return this.store.jobs.filter(j => j.enabled);
  }

  /** 添加任务 */
  addJob(job: CronJob): void {
    // 检查 ID 是否重复
    const existing = this.store.jobs.findIndex(j => j.id === job.id);
    if (existing >= 0) {
      this.store.jobs[existing] = job;
    } else {
      this.store.jobs.push(job);
    }
    this.dirty = true;
  }

  /** 更新任务 */
  updateJob(id: string, updates: Partial<CronJob>): CronJob | undefined {
    const index = this.store.jobs.findIndex(j => j.id === id);
    if (index < 0) return undefined;

    const job = this.store.jobs[index]!;
    Object.assign(job, updates, { updatedAtMs: Date.now() });
    this.dirty = true;
    return job;
  }

  /** 删除任务 */
  removeJob(id: string): boolean {
    const index = this.store.jobs.findIndex(j => j.id === id);
    if (index < 0) return false;

    this.store.jobs.splice(index, 1);
    this.dirty = true;
    return true;
  }

  /** 持久化 (如果有变更) */
  persist(): void {
    if (this.dirty) {
      saveCronStore(this.store, this.storePath);
      this.dirty = false;
    }
  }

  /** 强制持久化 */
  forcePersist(): void {
    saveCronStore(this.store, this.storePath);
    this.dirty = false;
  }

  /** 重新加载 */
  reload(): void {
    this.store = loadCronStore(this.storePath);
    this.dirty = false;
  }

  /** 清除所有任务 */
  clear(): void {
    this.store.jobs = [];
    this.dirty = true;
    // 与 addJob/updateJob/removeJob 不同，clear 表示破坏性意图，立即落盘以防丢失
    saveCronStore(this.store, this.storePath);
    this.dirty = false;
  }
}
