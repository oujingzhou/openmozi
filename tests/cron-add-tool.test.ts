/**
 * cron_add 工具 agentTurn 支持测试
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCronTools } from "../src/tools/builtin/cron.js";
import { CronService } from "../src/cron/service.js";

// Mock fs
vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => '{"version":1,"jobs":[]}'),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  copyFileSync: vi.fn(),
}));

describe("cron_add tool - agentTurn support", () => {
  let service: CronService;
  let cronAddTool: ReturnType<typeof createCronTools>[number];

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CronService({
      nowMs: () => 1000000,
      storePath: "/tmp/test-cron-add-tools.json",
      enabled: false,
      executeJob: async () => ({ status: "ok" as const }),
      onEvent: () => {},
    });

    const tools = createCronTools({ service });
    cronAddTool = tools.find((t) => t.name === "cron_add")!;
  });

  it("should create systemEvent job by default", async () => {
    const result = await cronAddTool.execute("tc-1", {
      name: "Test Event",
      scheduleType: "every",
      everyUnit: "minutes",
      everyValue: 5,
      message: "hello world",
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("定时任务已创建");
    expect(text).toContain("系统事件");

    const jobs = service.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload.kind).toBe("systemEvent");
  });

  it("should create agentTurn job with delivery", async () => {
    const result = await cronAddTool.execute("tc-2", {
      name: "Daily Report",
      scheduleType: "cron",
      cronExpr: "0 9 * * *",
      cronTz: "Asia/Shanghai",
      message: "生成今日工作报告",
      payloadType: "agentTurn",
      deliver: true,
      channel: "dingtalk",
      to: "user123",
      model: "deepseek-chat",
      timeoutSeconds: 120,
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("定时任务已创建");
    expect(text).toContain("Agent 执行");
    expect(text).toContain("dingtalk");
    expect(text).toContain("user123");

    const jobs = service.list();
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.payload.kind).toBe("agentTurn");

    if (job.payload.kind === "agentTurn") {
      expect(job.payload.message).toBe("生成今日工作报告");
      expect(job.payload.deliver).toBe(true);
      expect(job.payload.channel).toBe("dingtalk");
      expect(job.payload.to).toBe("user123");
      expect(job.payload.model).toBe("deepseek-chat");
      expect(job.payload.timeoutSeconds).toBe(120);
    }
  });

  it("should create agentTurn job without delivery", async () => {
    const result = await cronAddTool.execute("tc-3", {
      name: "Background Task",
      scheduleType: "every",
      everyUnit: "hours",
      everyValue: 1,
      message: "执行后台清理",
      payloadType: "agentTurn",
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("定时任务已创建");
    expect(text).toContain("Agent 执行");
    expect(text).not.toContain("投递目标");

    const jobs = service.list();
    const job = jobs[0]!;
    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.deliver).toBeUndefined();
    }
  });

  it("should create one-shot agentTurn job", async () => {
    const futureTime = new Date(Date.now() + 3600000).toISOString();
    const result = await cronAddTool.execute("tc-4", {
      name: "One-shot Report",
      scheduleType: "at",
      atTime: futureTime,
      message: "一次性发送消息",
      payloadType: "agentTurn",
      deliver: true,
      channel: "feishu",
      to: "group456",
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("定时任务已创建");
    expect(text).toContain("Agent 执行");
    expect(text).toContain("feishu");
  });

  it("should still validate schedule params for agentTurn", async () => {
    const result = await cronAddTool.execute("tc-5", {
      name: "Bad Job",
      scheduleType: "cron",
      // missing cronExpr
      message: "test",
      payloadType: "agentTurn",
      deliver: true,
      channel: "dingtalk",
      to: "user123",
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("错误");
    expect(text).toContain("cronExpr");
  });

  it("should reject invalid channel", async () => {
    const result = await cronAddTool.execute("tc-6", {
      name: "Bad Channel",
      scheduleType: "every",
      everyUnit: "minutes",
      everyValue: 5,
      message: "test",
      payloadType: "agentTurn",
      deliver: true,
      channel: "invalid_channel",
      to: "user123",
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("错误");
    expect(text).toContain("无效的通道");
    expect(text).toContain("invalid_channel");
  });

  it("should reject invalid timeoutSeconds", async () => {
    const result = await cronAddTool.execute("tc-7", {
      name: "Bad Timeout",
      scheduleType: "every",
      everyUnit: "minutes",
      everyValue: 5,
      message: "test",
      payloadType: "agentTurn",
      timeoutSeconds: 1000, // too large
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("错误");
    expect(text).toContain("timeoutSeconds");
    expect(text).toContain("1-600");
  });

  it("should accept valid channels", async () => {
    for (const channel of ["dingtalk", "feishu", "qq", "wecom", "webchat"]) {
      const result = await cronAddTool.execute(`tc-valid-${channel}`, {
        name: `Valid ${channel}`,
        scheduleType: "every",
        everyUnit: "minutes",
        everyValue: 5,
        message: "test",
        payloadType: "agentTurn",
        deliver: true,
        channel,
        to: "user123",
      });

      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      expect(text).toContain("定时任务已创建");
    }
  });
});