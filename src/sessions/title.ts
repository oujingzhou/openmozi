/**
 * 会话标题
 *
 * 两级策略：
 * 1. 兜底：直接截取首条用户消息（不调模型，立即有结果）
 * 2. 摘要：一次轻量模型调用，生成不超过 12 字的标题
 *
 * 标题只影响展示，不参与模型上下文；失败时保留兜底结果。
 */

import { completeSimple } from "@mariozechner/pi-ai";
import type { Model, Api } from "@mariozechner/pi-ai";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("session-title");

/** 标题最大长度（字符） */
const MAX_TITLE_LENGTH = 24;

/** 从首条用户消息生成兜底标题 */
export function fallbackTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "新会话";
  return flat.length > MAX_TITLE_LENGTH ? `${flat.slice(0, MAX_TITLE_LENGTH)}…` : flat;
}

/** 清洗模型输出：去掉引号、前缀、换行 */
function cleanTitle(raw: string): string {
  const firstLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";

  const cleaned = firstLine
    .replace(/^#{1,6}\s*/, "")
    .replace(/^(标题|摘要|会话摘要)[:：]\s*/, "")
    .replace(/^["'“”「」《》]+|["'“”「」《》]+$/g, "")
    .replace(/[。.!！?？]+$/g, "")
    .trim();

  return cleaned.length > MAX_TITLE_LENGTH ? `${cleaned.slice(0, MAX_TITLE_LENGTH)}…` : cleaned;
}

export interface SummarizeOptions {
  model: Model<Api>;
  apiKey: string;
  userText: string;
  assistantText: string;
  timeoutMs?: number;
}

/**
 * 用模型生成会话标题。
 * 抛错或超时都返回 undefined，由调用方保留兜底标题。
 */
export async function summarizeTitle(options: SummarizeOptions): Promise<string | undefined> {
  const userSnippet = options.userText.replace(/\s+/g, " ").slice(0, 400);
  const assistantSnippet = options.assistantText.replace(/\s+/g, " ").slice(0, 200);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20000);

  try {
    const response = await completeSimple(
      options.model,
      {
        systemPrompt:
          "你是会话标题生成器。只输出一个标题，不要解释、不要提问、不要续写对话。" +
          "标题不超过 12 个汉字，不要引号、句号或“标题：”前缀。",
        messages: [
          {
            role: "user",
            content: `用户：${userSnippet}\n助手：${assistantSnippet}`,
            timestamp: Date.now(),
          },
        ],
        // 不传 tools：部分 OpenAI 兼容端点会拒绝空的 tools 数组
      },
      // 关掉思考：推理模型会把预算全花在 thinking 上，拿不到标题。
      // pi-ai 的 ThinkingLevel 类型没有 "off"，但 provider 的 reasoningEffortMap
      // 会把 "off" 映射为 "none"，所以这里按实际参数类型断言。
      {
        apiKey: options.apiKey,
        maxTokens: 256,
        reasoning: "off",
        signal: controller.signal,
      } as unknown as Parameters<typeof completeSimple>[2]
    );

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");

    const title = cleanTitle(text);
    return title.length > 0 ? title : undefined;
  } catch (error) {
    logger.debug({ error }, "会话标题生成失败，保留兜底标题");
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
