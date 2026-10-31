/**
 * 定时任务模块测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  computeNextRunAtMs,
  computeJobNextRunAtMs,
  validateCronExpr,
  formatSchedule,
} from "../src/cron/schedule.js";
import { CronStore } from "../src/cron/store.js";
import { CronService } from "../src/cron/service.js";
import type { CronSchedule, CronJob, CronJobCreate } from "../src/cron/types.js";
import { TIME_CONSTANTS } from "../src/cron/types.js";

// Mock fs 模块：写路径走 shared storage 的原子写，因此 openSync/writeSync 也要提供
vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => '{"version":1,"jobs":[]}'),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  copyFileSync: vi.fn(),
  openSync: vi.fn(() => 1),
  writeSync: vi.fn(() => 0),
  fsyncSync: vi.fn(),
  closeSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

describe("cron/schedule", () => {
  describe("computeNextRunAtMs - at schedule", () => {
    it("should return atMs when in future", () => {
      const now = 1000;
      const schedule: CronSchedule = { kind: "at", atMs: 2000 };
      expect(computeNextRunAtMs(schedule, now)).toBe(2000);
    });

    it("should return undefined when atMs is in past", () => {
      const now = 3000;
      const schedule: CronSchedule = { kind: "at", atMs: 2000 };
      expect(computeNextRunAtMs(schedule, now)).toBeUndefined();
    });

    it("should return undefined when atMs equals now", () => {
      const now = 2000;
      const schedule: CronSchedule = { kind: "at", atMs: 2000 };
      expect(computeNextRunAtMs(schedule, now)).toBeUndefined();
    });
  });

  describe("computeNextRunAtMs - every schedule", () => {
    it("should compute next run based on interval", () => {
      const now = 5000;
      const schedule: CronSchedule = { kind: "every", everyMs: 1000, anchorMs: 0 };
      expect(computeNextRunAtMs(schedule, now)).toBe(6000);
    });

    it("should use anchor for alignment", () => {
      const now = 5500;
      const schedule: CronSchedule = { kind: "every", everyMs: 1000, anchorMs: 100 };
      // Elapsed from anchor: 5400, steps: ceil(5400/1000) = 6, next: 100 + 6000 = 6100
      expect(computeNextRunAtMs(schedule, now)).toBe(6100);
    });

    it("should return anchor when now is before anchor", () => {
      const now = 500;
      const schedule: CronSchedule = { kind: "every", everyMs: 1000, anchorMs: 1000 };
      expect(computeNextRunAtMs(schedule, now)).toBe(1000);
    });

    it("should return undefined for invalid interval", () => {
      const now = 5000;
      const schedule: CronSchedule = { kind: "every", everyMs: 0 };
      expect(computeNextRunAtMs(schedule, now)).toBeUndefined();
    });
  });

  describe("computeNextRunAtMs - cron schedule", () => {
    it("should compute next run for simple cron", () => {
      // 每分钟的第 0 秒
      const now = new Date("2024-01-01T10:00:30").getTime();
      const schedule: CronSchedule = { kind: "cron", expr: "0 * * * *" };
      const next = computeNextRunAtMs(schedule, now);

      expect(next).toBeDefined();
      expect(next).toBeGreaterThan(now);  // 下次运行应该在当前时间之后
      const nextDate = new Date(next!);
      expect(nextDate.getSeconds()).toBe(0);  // 秒应该是 0
    });

    it("should handle 6-field cron (with seconds)", () => {
      const now = new Date("2024-01-01T10:00:00").getTime();
      const schedule: CronSchedule = { kind: "cron", expr: "30 * * * * *" };  // 每分钟的第 30 秒
      const next = computeNextRunAtMs(schedule, now);

      expect(next).toBeDefined();
      const nextDate = new Date(next!);
      expect(nextDate.getSeconds()).toBe(30);
    });

    it("should handle cron ranges", () => {
      const now = new Date("2024-01-01T10:00:00").getTime();
      const schedule: CronSchedule = { kind: "cron", expr: "0 0 9-17 * * *" };  // 9-17 点的整点
      const next = computeNextRunAtMs(schedule, now);

      expect(next).toBeDefined();
    });

    it("should handle cron step values", () => {
      const now = new Date("2024-01-01T10:00:00").getTime();
      const schedule: CronSchedule = { kind: "cron", expr: "*/15 * * * *" };  // 每 15 分钟
      const next = computeNextRunAtMs(schedule, now);

      expect(next).toBeDefined();
      const nextDate = new Date(next!);
      expect(nextDate.getMinutes() % 15).toBe(0);
    });
  });

  describe("validateCronExpr", () => {
    it("should validate correct expressions", () => {
      expect(validateCronExpr("* * * * *").valid).toBe(true);
      expect(validateCronExpr("0 0 * * *").valid).toBe(true);
      expect(validateCronExpr("*/5 * * * *").valid).toBe(true);
      expect(validateCronExpr("0 9-17 * * 1-5").valid).toBe(true);
    });

    it("should reject invalid expressions", () => {
      expect(validateCronExpr("").valid).toBe(false);
      expect(validateCronExpr("* * *").valid).toBe(false);
      expect(validateCronExpr("* * * * * * *").valid).toBe(false);
    });
  });

  describe("formatSchedule", () => {
    it("should format at schedule", () => {
      const schedule: CronSchedule = { kind: "at", atMs: new Date("2024-01-01").getTime() };
      const formatted = formatSchedule(schedule);
      expect(formatted).toContain("Once at");
      expect(formatted).toContain("2024-01-01");
    });

    it("should format every schedule", () => {
      expect(formatSchedule({ kind: "every", everyMs: TIME_CONSTANTS.MINUTE })).toBe("Every 1m");
      expect(formatSchedule({ kind: "every", everyMs: TIME_CONSTANTS.HOUR })).toBe("Every 1h");
      expect(formatSchedule({ kind: "every", everyMs: TIME_CONSTANTS.DAY })).toBe("Every 1d");
      expect(formatSchedule({ kind: "every", everyMs: 30 * TIME_CONSTANTS.SECOND })).toBe("Every 30s");
    });

    it("should format cron schedule", () => {
      const schedule: CronSchedule = { kind: "cron", expr: "0 0 * * *", tz: "Asia/Shanghai" };
      const formatted = formatSchedule(schedule);
      expect(formatted).toContain("Cron: 0 0 * * *");
      expect(formatted).toContain("Asia/Shanghai");
    });
  });
});

describe("cron/store", () => {
  let store: CronStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new CronStore("/tmp/test-jobs.json");
  });

  describe("getJobs", () => {
    it("should return empty array initially", () => {
      expect(store.getJobs()).toEqual([]);
    });
  });

  describe("addJob", () => {
    it("should add a job", () => {
      const job: CronJob = {
        id: "test-1",
        name: "Test Job",
        enabled: true,
        schedule: { kind: "every", everyMs: 60000 },
        payload: { kind: "systemEvent", message: "test" },
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        state: {},
      };

      store.addJob(job);

      expect(store.getJobs()).toHaveLength(1);
      expect(store.getJob("test-1")).toBe(job);
    });

    it("should update existing job with same id", () => {
      const job1: CronJob = {
        id: "test-1",
        name: "Test Job 1",
        enabled: true,
        schedule: { kind: "every", everyMs: 60000 },
        payload: { kind: "systemEvent", message: "test" },
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        state: {},
      };
      const job2: CronJob = { ...job1, name: "Test Job 2" };

      store.addJob(job1);
      store.addJob(job2);

      expect(store.getJobs()).toHaveLength(1);
      expect(store.getJob("test-1")?.name).toBe("Test Job 2");
    });
  });

  describe("removeJob", () => {
    it("should remove a job", () => {
      const job: CronJob = {
        id: "test-1",
        name: "Test Job",
        enabled: true,
        schedule: { kind: "every", everyMs: 60000 },
        payload: { kind: "systemEvent", message: "test" },
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        state: {},
      };

      store.addJob(job);
      const removed = store.removeJob("test-1");

      expect(removed).toBe(true);
      expect(store.getJobs()).toHaveLength(0);
    });

    it("should return false for non-existent job", () => {
      const removed = store.removeJob("non-existent");
      expect(removed).toBe(false);
    });
  });

  describe("getEnabledJobs", () => {
    it("should only return enabled jobs", () => {
      const job1: CronJob = {
        id: "test-1",
        name: "Enabled Job",
        enabled: true,
        schedule: { kind: "every", everyMs: 60000 },
        payload: { kind: "systemEvent", message: "test" },
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        state: {},
      };
      const job2: CronJob = { ...job1, id: "test-2", name: "Disabled Job", enabled: false };

      store.addJob(job1);
      store.addJob(job2);

      const enabled = store.getEnabledJobs();
      expect(enabled).toHaveLength(1);
      expect(enabled[0]?.name).toBe("Enabled Job");
    });
  });
});

describe("cron/service", () => {
  let service: CronService;
  let events: Array<{ jobId: string; action: string }>;

  beforeEach(() => {
    vi.clearAllMocks();
    events = [];
    service = new CronService({
      nowMs: () => 1000000,
      storePath: "/tmp/test-service-jobs.json",
      enabled: false,  // 禁用调度器以便手动控制
      executeJob: async () => ({ status: "ok" as const }),
      onEvent: (event) => events.push({ jobId: event.jobId, action: event.action }),
    });
  });

  afterEach(() => {
    service.stop();
  });

  describe("add", () => {
    it("should add a job and emit event", () => {
      const input: CronJobCreate = {
        name: "Test Job",
        schedule: { kind: "every", everyMs: 60000 },
        payload: { kind: "systemEvent", message: "test" },
      };

      const job = service.add(input);

      expect(job.id).toBeDefined();
      expect(job.name).toBe("Test Job");
      expect(job.enabled).toBe(true);
      expect(events).toContainEqual({ jobId: job.id, action: "added" });
    });
  });

  describe("list", () => {
    it("should list all enabled jobs sorted by nextRunAtMs", () => {
      service.add({
        name: "Job A",
        schedule: { kind: "at", atMs: 2000000 },
        payload: { kind: "systemEvent", message: "a" },
      });
      service.add({
        name: "Job B",
        schedule: { kind: "at", atMs: 1500000 },
        payload: { kind: "systemEvent", message: "b" },
      });

      const jobs = service.list();

      expect(jobs).toHaveLength(2);
      expect(jobs[0]?.name).toBe("Job B");  // Earlier nextRunAtMs first
      expect(jobs[1]?.name).toBe("Job A");
    });
  });

  describe("update", () => {
    it("should update a job", () => {
      const job = service.add({
        name: "Original",
        schedule: { kind: "every", everyMs: 60000 },
        payload: { kind: "systemEvent", message: "test" },
      });

      const updated = service.update(job.id, { name: "Updated", enabled: false });

      expect(updated?.name).toBe("Updated");
      expect(updated?.enabled).toBe(false);
      expect(events).toContainEqual({ jobId: job.id, action: "updated" });
    });

    it("should return undefined for non-existent job", () => {
      const updated = service.update("non-existent", { name: "Updated" });
      expect(updated).toBeUndefined();
    });
  });

  describe("remove", () => {
    it("should remove a job", () => {
      const job = service.add({
        name: "To Remove",
        schedule: { kind: "every", everyMs: 60000 },
        payload: { kind: "systemEvent", message: "test" },
      });

      const removed = service.remove(job.id);

      expect(removed).toBe(true);
      expect(service.get(job.id)).toBeUndefined();
      expect(events).toContainEqual({ jobId: job.id, action: "removed" });
    });
  });

  describe("run", () => {
    it("should execute job immediately", async () => {
      const job = service.add({
        name: "To Run",
        schedule: { kind: "at", atMs: 9999999 },
        payload: { kind: "systemEvent", message: "test" },
      });

      const result = await service.run(job.id);

      expect(result.status).toBe("ok");
      expect(events).toContainEqual({ jobId: job.id, action: "started" });
      expect(events).toContainEqual({ jobId: job.id, action: "finished" });
    });

    it("should return not_found for non-existent job", async () => {
      const result = await service.run("non-existent");
      expect(result.status).toBe("not_found");
    });
  });
});
