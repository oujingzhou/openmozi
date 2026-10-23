/**
 * 旧会话展示回退
 *
 * durable 日志是 v1.13 之后才有的。更早的会话只有转录文件（<sessionId>.jsonl），
 * 如果直接按日志渲染，升级后这些历史在 UI 里会整片消失。
 *
 * 这里把转录投影成一份**只用于展示**的快照：
 * - 绝不参与模型上下文（pi 自己的会话文件才是上下文来源）
 * - 不写入日志，不产生副作用
 */

import type { DurableSessionSnapshot, DurableTurnView } from "../durable/types.js";
import type { TranscriptMessage } from "../sessions/types.js";

/** 从转录消息重建展示用快照 */
export function snapshotFromTranscript(
  sessionKey: string,
  sessionId: string,
  messages: TranscriptMessage[]
): DurableSessionSnapshot {
  const turns: DurableTurnView[] = [];
  let pendingUser: { content: string; timestamp: number } | null = null;
  let assistantText = "";

  const flush = (timestamp: number) => {
    if (pendingUser === null && assistantText === "") return;
    const turnIndex = turns.length;
    turns.push({
      turnId: `legacy-${turnIndex}`,
      requestId: "",
      createdAt: pendingUser?.timestamp ?? timestamp,
      endedAt: timestamp,
      reason: "completed",
      content: pendingUser?.content ?? "",
      steps: assistantText
        ? [
            {
              type: "step",
              stepId: "legacy-0",
              text: assistantText,
              partial: false,
              tools: [],
            },
          ]
        : [],
      running: false,
      resumed: false,
    });
    pendingUser = null;
    assistantText = "";
  };

  for (const message of messages) {
    const text = typeof message.content === "string" ? message.content : "";
    if (message.role === "user") {
      flush(message.timestamp);
      pendingUser = { content: text, timestamp: message.timestamp };
      continue;
    }
    if (message.role === "assistant") {
      assistantText = assistantText ? `${assistantText}\n\n${text}` : text;
      continue;
    }
  }
  flush(Date.now());

  return {
    sessionKey,
    sessionId,
    updatedAt: turns.length > 0 ? (turns[turns.length - 1]!.endedAt ?? 0) : 0,
    running: false,
    turns,
    seq: 0,
    queued: [],
  };
}
