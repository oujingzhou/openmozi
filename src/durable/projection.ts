/**
 * 投影 - 从追加日志折叠出 UI 需要的视图
 *
 * 投影是纯函数：同样的记录序列永远得到同样的结果。
 * 任何需要"再看一遍历史"的地方都调用这里，而不是另建状态。
 */

import type {
  DurableSessionSnapshot,
  QueuedMessageView,
  DurableStepBlock,
  DurableToolBlock,
  DurableToolState,
  DurableTurnEndRecord,
  DurableTurnView,
  JournaledRecord,
} from "./types.js";

/** 折叠过程中的回合累加器 */
interface TurnAccumulator {
  turnId: string;
  requestId: string;
  createdAt: number;
  content: string;
  reason?: DurableTurnEndRecord["reason"];
  error?: string;
  endedAt?: number;
  model?: string;
  provider?: string;
  usage?: DurableTurnView["usage"];
  resumed: boolean;
  /** 按出现顺序的 step */
  steps: DurableStepBlock[];
  /** callId -> step（用于把工具结果回填到发起它的 step） */
  stepByCall: Map<string, DurableStepBlock>;
  /** 尚未归入任何 step 的悬空工具调用 */
  orphanTools: DurableToolBlock[];
}

/**
 * 按 (stepId, callId) 定位工具块。
 * provider 的 callId 在同一回合的多个 step 之间可能重复（模型复用了 id），
 * 只用 callId 会把后续 step 的结果错误地写回第一个 step。
 */
function findTool(
  steps: DurableStepBlock[],
  stepId: string | undefined,
  callId: string
): DurableToolBlock | undefined {
  if (stepId) {
    const step = steps.find((candidate) => candidate.stepId === stepId);
    const tool = step?.tools.find((candidate) => candidate.callId === callId);
    if (tool) return tool;
  }
  for (const step of steps) {
    const tool = step.tools.find((candidate) => candidate.callId === callId && candidate.state === "running");
    if (tool) return tool;
  }
  return undefined;
}

/**
 * 把记录折叠成回合视图。
 * 未结束的回合会被标记为 running，由调用方决定是否补写 interrupted。
 */
function foldTurns(records: JournaledRecord[]): DurableTurnView[] {
  const turns = new Map<string, TurnAccumulator>();
  const order: string[] = [];

  const startStep = (turn: TurnAccumulator, stepId: string): DurableStepBlock => {
    const existing = turn.steps.find((step) => step.stepId === stepId);
    if (existing) return existing;
    const step: DurableStepBlock = {
      type: "step",
      stepId,
      text: "",
      partial: false,
      tools: [],
    };
    turn.steps.push(step);
    return step;
  };

  for (const record of records) {
    switch (record.kind) {
      case "reset": {
        turns.clear();
        order.length = 0;
        break;
      }
      case "queued":
      case "dequeued":
        // 队列单独折叠，见 buildSnapshot
        break;
      case "turn": {
        if (turns.has(record.turnId)) break;
        turns.set(record.turnId, {
          turnId: record.turnId,
          requestId: record.requestId,
          createdAt: record.at,
          content: record.content,
          resumed: Boolean(record.resumedFrom),
          steps: [],
          stepByCall: new Map(),
          orphanTools: [],
        });
        order.push(record.turnId);
        break;
      }
      case "assistant": {
        const turn = turns.get(record.turnId);
        if (!turn) break;
        const step = startStep(turn, record.stepId);
        step.text = record.text;
        step.thinking = record.thinking;
        step.partial = record.partial ?? false;
        if (record.model) turn.model = record.model;
        if (record.provider) turn.provider = record.provider;
        if (record.usage) turn.usage = record.usage;
        break;
      }
      case "tool-intent": {
        const turn = turns.get(record.turnId);
        if (!turn) break;

        // 优先落到发起调用的 step；缺失时才回退到最后一个 step
        let owner = turn.steps.find((step) => step.stepId === record.stepId);
        if (!owner) owner = turn.steps[turn.steps.length - 1];

        const tool: DurableToolBlock = {
          type: "tool",
          callId: record.callId,
          name: record.name,
          args: record.args,
          state: "running",
        };
        if (owner) {
          owner.tools.push(tool);
          turn.stepByCall.set(record.callId, owner);
        } else {
          turn.orphanTools.push(tool);
        }
        break;
      }
      case "tool-result": {
        const turn = turns.get(record.turnId);
        if (!turn) break;
        const state: DurableToolState = record.interrupted
          ? "interrupted"
          : record.isError
            ? "error"
            : "done";

        let tool = findTool(turn.steps, record.stepId, record.callId);
        if (!tool) tool = turn.orphanTools.find((candidate) => candidate.callId === record.callId);
        if (tool) {
          tool.text = record.text;
          tool.isError = record.isError;
          tool.state = state;
          tool.durationMs = record.durationMs;
          break;
        }
        // 结果先于意图到达（异常路径）：独立成块
        const orphan: DurableToolBlock = {
          type: "tool",
          callId: record.callId,
          name: record.name,
          text: record.text,
          isError: record.isError,
          state,
          durationMs: record.durationMs,
        };
        turn.orphanTools.push(orphan);
        break;
      }
      case "turn-end": {
        const turn = turns.get(record.turnId);
        if (!turn) break;
        turn.reason = record.reason;
        turn.error = record.error;
        turn.endedAt = record.at;
        break;
      }
    }
  }

  return order.map((turnId) => {
    const turn = turns.get(turnId)!;
    // 已经结束的回合里，中间态 step 视为最终态
    const steps = turn.steps.map((step) => ({ ...step, partial: step.partial && turn.reason === undefined }));
    const lastStep = steps[steps.length - 1];
    if (turn.orphanTools.length > 0) {
      if (lastStep) lastStep.tools.push(...turn.orphanTools);
      else
        steps.push({
          type: "step",
          stepId: "orphan",
          text: "",
          partial: false,
          tools: [...turn.orphanTools],
        });
    }

    return {
      turnId: turn.turnId,
      requestId: turn.requestId,
      createdAt: turn.createdAt,
      endedAt: turn.endedAt,
      reason: turn.reason,
      error: turn.error,
      content: turn.content,
      steps,
      model: turn.model,
      provider: turn.provider,
      usage: turn.usage,
      running: turn.reason === undefined,
      resumed: turn.resumed,
    } satisfies DurableTurnView;
  });
}

/** 构造会话快照 */
export function buildSnapshot(params: {
  sessionKey: string;
  sessionId: string;
  records: JournaledRecord[];
  seq: number;
}): DurableSessionSnapshot {
  const turns = foldTurns(params.records);
  return {
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    updatedAt: params.records.length > 0 ? params.records[params.records.length - 1]!.at : 0,
    running: turns.some((turn) => turn.running),
    turns,
    seq: params.seq,
    queued: foldQueue(params.records),
  };
}

/** 折叠出仍在排队的消息 */
export function foldQueue(records: JournaledRecord[]): QueuedMessageView[] {
  const pending = new Map<string, QueuedMessageView>();

  for (const record of records) {
    if (record.kind === "queued") {
      pending.set(record.queueId, {
        id: record.queueId,
        content: record.content,
        behavior: record.behavior,
        createdAt: record.at,
      });
    } else if (record.kind === "dequeued") {
      pending.delete(record.queueId);
    } else if (record.kind === "reset") {
      pending.clear();
    }
  }

  return Array.from(pending.values()).sort((a, b) => a.createdAt - b.createdAt);
}

/** 仅折叠回合视图 */
export function projectTurns(records: JournaledRecord[]): DurableTurnView[] {
  return foldTurns(records);
}
