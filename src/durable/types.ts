/**
 * Durable execution - 类型定义
 *
 * 设计约束（参考 pi-durable / everagent）：
 * 1. 日志是唯一事实来源，只追加，不改写。
 * 2. 每个 step 先写"意图"再产生副作用，恢复时按意图重放或标记中断。
 * 3. 派生的视图（feed / turns）永远是投影，不参与持久化。
 */

/** 持久化格式版本 */
export const DURABLE_FORMAT_VERSION = 1;

/** 工具副作用分类：safe 可在恢复后重放，unsafe 只做标记 */
export type ReplayClass = "safe" | "unsafe";

/** 回合结束原因 */
export type TurnEndReason = "completed" | "aborted" | "error" | "interrupted";

/** token 使用量 */
export interface DurableUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 回合开始（用户输入） */
export interface DurableTurnRecord {
  kind: "turn";
  /** 回合 ID */
  turnId: string;
  /** 幂等键：同一会话内重复提交返回同一回合 */
  requestId: string;
  /** 用户输入 */
  content: string;
  /** 来源（webchat / feishu / cron ...） */
  source: string;
  /** 恢复时用于标注这是从中断中接管的回合 */
  resumedFrom?: string;
}

/** 助手消息（一个 step 的最终产物；partial=true 表示流式中间态） */
export interface DurableAssistantRecord {
  kind: "assistant";
  turnId: string;
  /** 同一 turn 内按出现顺序的 step 标识 */
  stepId: string;
  text: string;
  thinking?: string;
  /** 流式中间态：同 stepId 的后续记录会覆盖它 */
  partial?: boolean;
  model?: string;
  provider?: string;
  usage?: DurableUsage;
  stopReason?: string;
}

/** 工具调用意图：副作用发生前写入 */
export interface DurableToolIntentRecord {
  kind: "tool-intent";
  turnId: string;
  /** 发起该调用的 step；与 callId 一起构成唯一键 */
  stepId: string;
  callId: string;
  name: string;
  args: unknown;
  /** 该调用是否可安全重放 */
  replay: ReplayClass;
}

/** 工具调用结果 */
export interface DurableToolResultRecord {
  kind: "tool-result";
  turnId: string;
  /** 发起该调用的 step；缺省时按 callId 回退匹配（兼容旧日志） */
  stepId?: string;
  callId: string;
  name: string;
  text: string;
  isError: boolean;
  durationMs?: number;
  /** 恢复时补写的合成结果 */
  interrupted?: boolean;
}

/** 回合结束 */
export interface DurableTurnEndRecord {
  kind: "turn-end";
  turnId: string;
  reason: TurnEndReason;
  error?: string;
}

/** 排队中的用户消息（回合运行期间输入） */
export interface DurableQueuedRecord {
  kind: "queued";
  queueId: string;
  content: string;
  /** followUp=当前回合结束后执行；steer=中断当前回合立即执行 */
  behavior: "steer" | "followUp";
  /** 重建上下文所需的最小信息 */
  channelId: string;
  chatId: string;
  senderId: string;
}

/** 出队（已执行或被删除） */
export interface DurableDequeuedRecord {
  kind: "dequeued";
  queueId: string;
  reason: "delivered" | "removed";
}

/** 上下文重置（清空对话） */
export interface DurableResetRecord {
  kind: "reset";
  reason: string;
}

/** 业务记录联合类型 */
export type DurableRecord =
  | DurableQueuedRecord
  | DurableDequeuedRecord
  | DurableTurnRecord
  | DurableAssistantRecord
  | DurableToolIntentRecord
  | DurableToolResultRecord
  | DurableTurnEndRecord
  | DurableResetRecord;

/** 落盘后的记录：带序号与时间戳 */
export type JournaledRecord = DurableRecord & { seq: number; at: number };

/** 日志文件头 */
export interface JournalHeader {
  type: "header";
  version: number;
  sessionKey: string;
  sessionId: string;
  createdAt: number;
  cwd: string;
}

/** 提交标记：一条记录批次以 commit 收尾，未提交的尾部在加载时丢弃 */
export interface JournalCommit {
  type: "commit";
  seq: number;
  count: number;
  at: number;
}

/** 日志行 */
export type JournalLine = JournalHeader | (JournaledRecord & { type: "record" }) | JournalCommit;

/** 工具调用在 feed 中的状态 */
export type DurableToolState = "running" | "done" | "error" | "interrupted";

/** 一个 step（一次模型调用）在对话流中的呈现 */
export interface DurableStepBlock {
  type: "step";
  stepId: string;
  text: string;
  thinking?: string;
  partial: boolean;
  /** 该 step 内产生的工具调用 */
  tools: DurableToolBlock[];
}

/** 工具调用块 */
export interface DurableToolBlock {
  type: "tool";
  callId: string;
  name: string;
  args?: unknown;
  text?: string;
  isError?: boolean;
  state: DurableToolState;
  durationMs?: number;
}

/** 对话流中的一个块 */
export type DurableFeedBlock = DurableStepBlock | DurableToolBlock;

/** 回合投影（供 UI 渲染） */
export interface DurableTurnView {
  turnId: string;
  requestId: string;
  createdAt: number;
  endedAt?: number;
  reason?: TurnEndReason;
  error?: string;
  content: string;
  steps: DurableStepBlock[];
  model?: string;
  provider?: string;
  usage?: DurableUsage;
  /** 该回合是否仍在进行 */
  running: boolean;
  /** 是否从中断恢复 */
  resumed: boolean;
}

/** 排队中的消息（供 UI 展示） */
export interface QueuedMessageView {
  id: string;
  content: string;
  behavior: "steer" | "followUp";
  createdAt: number;
}

/** 会话投影 */
export interface DurableSessionSnapshot {
  sessionKey: string;
  sessionId: string;
  updatedAt: number;
  running: boolean;
  turns: DurableTurnView[];
  /** 最近一次序号，客户端用于检测缺口 */
  seq: number;
  /** 仍在排队的用户消息 */
  queued: QueuedMessageView[];
}

/** 实时事件（服务端 -> 客户端） */
export type DurableLiveEvent =
  | {
      type: "turn_start";
      turnId: string;
      requestId: string;
      createdAt: number;
      resumed: boolean;
      /** 用户输入，便于其它标签页直接渲染 */
      content: string;
    }
  | { type: "step_start"; turnId: string; stepId: string }
  | { type: "text_delta"; turnId: string; stepId: string; delta: string }
  | { type: "thinking_delta"; turnId: string; stepId: string; delta: string }
  | { type: "assistant"; turnId: string; stepId: string; text: string; thinking?: string; partial: boolean }
  | { type: "tool_start"; turnId: string; stepId: string; callId: string; name: string; args?: unknown }
  | { type: "tool_update"; turnId: string; callId: string; text: string }
  | {
      type: "tool_end";
      turnId: string;
      callId: string;
      isError: boolean;
      text?: string;
      interrupted?: boolean;
      durationMs?: number;
    }
  | { type: "turn_end"; turnId: string; reason: TurnEndReason; error?: string }
  | { type: "queue_added"; queueId: string; content: string; behavior: "steer" | "followUp" }
  | { type: "queue_removed"; queueId: string; reason: "delivered" | "removed" }
  | { type: "reset"; reason: string };

/**
 * 带序号的实时事件。
 * transient=true 表示"只推送、不落盘"（如流式增量）：
 * 这类事件复用当前日志序号，不参与缺口检测与去重。
 */
export type SequencedLiveEvent = DurableLiveEvent & {
  seq: number;
  sessionKey: string;
  transient?: boolean;
};
