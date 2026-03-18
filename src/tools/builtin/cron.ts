/**
 * 定时任务工具
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { CronService } from "../../cron/service.js";
import type { CronSchedule, CronJobCreate, CronPayload } from "../../cron/types.js";
import { TIME_CONSTANTS } from "../../cron/types.js";
import { formatSchedule, validateCronExpr } from "../../cron/schedule.js";

export interface CronToolsOptions { service: CronService; }

export function createCronTools(options: CronToolsOptions): AgentTool[] {
  const { service } = options;
  return [createCronListTool(service), createCronAddTool(service), createCronRemoveTool(service), createCronRunTool(service), createCronUpdateTool(service)];
}

function createCronListTool(service: CronService): AgentTool {
  return {
    name: "cron_list",
    label: "列出定时任务",
    description: "列出所有定时任务",
    parameters: Type.Object({ includeDisabled: Type.Optional(Type.Boolean({ description: "包含已禁用任务" })) }),
    execute: async (_toolCallId, args): Promise<AgentToolResult<unknown>> => {
      const { includeDisabled = false } = args as { includeDisabled?: boolean };
      const jobs = includeDisabled ? service.list({ includeDisabled: true }) : service.list();
      if (jobs.length === 0) return { content: [{ type: "text", text: "没有定时任务" }], details: {} };
      const lines = jobs.map(job => `${job.enabled ? "✅" : "❌"} **${job.name}** (ID: ${job.id})\n   调度: ${formatSchedule(job.schedule)}\n   下次执行: ${job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toLocaleString("zh-CN") : "无"}`);
      return { content: [{ type: "text", text: `定时任务列表 (共 ${jobs.length} 个):\n\n${lines.join("\n\n")}` }], details: { count: jobs.length } };
    },
  };
}

function createCronAddTool(service: CronService): AgentTool {
  return {
    name: "cron_add",
    label: "添加定时任务",
    description: "添加一个定时任务。支持 at/every/cron 调度类型。",
    parameters: Type.Object({
      name: Type.String({ description: "任务名称" }),
      scheduleType: Type.Union([Type.Literal("at"), Type.Literal("every"), Type.Literal("cron")], { description: "调度类型" }),
      atTime: Type.Optional(Type.String({ description: "一次性任务执行时间 (ISO 8601)" })),
      everyMs: Type.Optional(Type.Number({ description: "周期任务间隔(毫秒)" })),
      everyUnit: Type.Optional(Type.Union([Type.Literal("seconds"), Type.Literal("minutes"), Type.Literal("hours"), Type.Literal("days")], { description: "时间单位" })),
      everyValue: Type.Optional(Type.Number({ description: "时间值" })),
      cronExpr: Type.Optional(Type.String({ description: "Cron 表达式" })),
      cronTz: Type.Optional(Type.String({ description: "时区" })),
      message: Type.String({ description: "任务消息内容" }),
      payloadType: Type.Optional(Type.Union([Type.Literal("systemEvent"), Type.Literal("agentTurn")], { description: "任务类型" })),
      deliver: Type.Optional(Type.Boolean({ description: "投递结果到通道" })),
      channel: Type.Optional(Type.String({ description: "投递通道" })),
      to: Type.Optional(Type.String({ description: "投递目标ID" })),
      model: Type.Optional(Type.String({ description: "指定模型" })),
      timeoutSeconds: Type.Optional(Type.Number({ description: "超时时间(秒)" })),
    }),
    execute: async (_toolCallId, args): Promise<AgentToolResult<unknown>> => {
      const { name, scheduleType, atTime, everyMs, everyUnit, everyValue, cronExpr, cronTz, message, payloadType = "systemEvent", deliver, channel, to, model, timeoutSeconds } = args as any;

      // Validate agentTurn parameters
      if (payloadType === "agentTurn") {
        if (deliver && channel) {
          const validChannels = ["dingtalk", "feishu", "qq", "wecom", "webchat"];
          if (!validChannels.includes(channel)) {
            return { content: [{ type: "text", text: `错误: 无效的通道 "${channel}"，有效通道: ${validChannels.join(", ")}` }], details: { error: "invalid_channel" } };
          }
        }
        if (timeoutSeconds !== undefined && (timeoutSeconds < 1 || timeoutSeconds > 600)) {
          return { content: [{ type: "text", text: `错误: timeoutSeconds 必须在 1-600 秒之间` }], details: { error: "invalid_timeout" } };
        }
      }

      let schedule: CronSchedule;
      if (scheduleType === "at") {
        if (!atTime) return { content: [{ type: "text", text: "错误: 需要 atTime 参数" }], details: { error: "missing_atTime" } };
        const atMs = new Date(atTime).getTime();
        if (isNaN(atMs)) return { content: [{ type: "text", text: "错误: atTime 格式无效" }], details: { error: "invalid_atTime" } };
        schedule = { kind: "at", atMs };
      } else if (scheduleType === "every") {
        let intervalMs = everyMs;
        if (!intervalMs && everyUnit && everyValue) {
          const unitMap: Record<string, number> = { seconds: TIME_CONSTANTS.SECOND, minutes: TIME_CONSTANTS.MINUTE, hours: TIME_CONSTANTS.HOUR, days: TIME_CONSTANTS.DAY };
          intervalMs = everyValue * unitMap[everyUnit]!;
        }
        if (!intervalMs || intervalMs <= 0) return { content: [{ type: "text", text: "错误: 需要有效的间隔时间" }], details: { error: "invalid_interval" } };
        schedule = { kind: "every", everyMs: intervalMs };
      } else {
        if (!cronExpr) return { content: [{ type: "text", text: "错误: 需要 cronExpr 参数" }], details: { error: "missing_cronExpr" } };
        const validation = validateCronExpr(cronExpr);
        if (!validation.valid) return { content: [{ type: "text", text: `错误: Cron 表达式无效 - ${validation.error}` }], details: { error: "invalid_cron" } };
        schedule = { kind: "cron", expr: cronExpr, tz: cronTz };
      }

      let payload: CronPayload;
      let typeDesc: string;
      if (payloadType === "agentTurn") {
        payload = { kind: "agentTurn", message, model, timeoutSeconds, deliver, channel, to };
        typeDesc = "Agent 执行";
        if (deliver && channel) {
          typeDesc += ` → 投递到 ${channel}:${to}`;
        }
      } else {
        payload = { kind: "systemEvent", message };
        typeDesc = "系统事件";
      }

      const job = service.add({ name, schedule, payload } as CronJobCreate);
      return { content: [{ type: "text", text: `定时任务已创建:\n- ID: ${job.id}\n- 名称: ${job.name}\n- 类型: ${typeDesc}\n- 调度: ${formatSchedule(job.schedule)}` }], details: { jobId: job.id } };
    },
  };
}

function createCronRemoveTool(service: CronService): AgentTool {
  return {
    name: "cron_remove",
    label: "删除定时任务",
    description: "根据 ID 删除定时任务",
    parameters: Type.Object({ jobId: Type.String({ description: "任务 ID" }) }),
    execute: async (_toolCallId, args): Promise<AgentToolResult<unknown>> => {
      const { jobId } = args as { jobId: string };
      const job = service.get(jobId);
      if (!job) return { content: [{ type: "text", text: `错误: 找不到任务 ${jobId}` }], details: { error: "not_found" } };
      const removed = service.remove(jobId);
      if (!removed) return { content: [{ type: "text", text: "错误: 删除失败" }], details: { error: "remove_failed" } };
      return { content: [{ type: "text", text: `已删除定时任务: ${job.name} (ID: ${jobId})` }], details: {} };
    },
  };
}

function createCronRunTool(service: CronService): AgentTool {
  return {
    name: "cron_run",
    label: "立即执行任务",
    description: "立即执行一个定时任务",
    parameters: Type.Object({ jobId: Type.String({ description: "任务 ID" }) }),
    execute: async (_toolCallId, args): Promise<AgentToolResult<unknown>> => {
      const { jobId } = args as { jobId: string };
      const result = await service.run(jobId);
      if (result.status === "ok") return { content: [{ type: "text", text: "任务执行成功" }], details: {} };
      if (result.status === "not_found") return { content: [{ type: "text", text: `错误: 找不到任务 ${jobId}` }], details: { error: "not_found" } };
      return { content: [{ type: "text", text: `任务执行失败: ${result.error}` }], details: { error: result.error } };
    },
  };
}

function createCronUpdateTool(service: CronService): AgentTool {
  return {
    name: "cron_update",
    label: "更新定时任务",
    description: "更新定时任务的名称或启用状态",
    parameters: Type.Object({
      jobId: Type.String({ description: "任务 ID" }),
      name: Type.Optional(Type.String({ description: "新名称" })),
      enabled: Type.Optional(Type.Boolean({ description: "是否启用" })),
    }),
    execute: async (_toolCallId, args): Promise<AgentToolResult<unknown>> => {
      const { jobId, name, enabled } = args as { jobId: string; name?: string; enabled?: boolean };
      const updates: { name?: string; enabled?: boolean } = {};
      if (name !== undefined) updates.name = name;
      if (enabled !== undefined) updates.enabled = enabled;
      if (Object.keys(updates).length === 0) return { content: [{ type: "text", text: "错误: 没有要更新的字段" }], details: { error: "no_updates" } };
      const job = service.update(jobId, updates);
      if (!job) return { content: [{ type: "text", text: `错误: 找不到任务 ${jobId}` }], details: { error: "not_found" } };
      return { content: [{ type: "text", text: `定时任务已更新:\n- ID: ${job.id}\n- 名称: ${job.name}\n- 状态: ${job.enabled ? "已启用" : "已禁用"}` }], details: {} };
    },
  };
}