/**
 * 钉钉事件处理
 */

import type { DingtalkConfig, InboundMessageContext, ChatType } from "../../types/index.js";
import { getChildLogger } from "../../utils/logger.js";
import { computeHmacSha256 } from "../../utils/index.js";
import { isFreshTimestamp, safeEqual } from "../common/signature.js";

const logger = getChildLogger("dingtalk-events");

/** 钉钉消息类型 */
export type DingtalkMsgType =
  | "text"
  | "richText"
  | "picture"
  | "video"
  | "file"
  | "audio";

/** 钉钉回调消息 */
export interface DingtalkCallbackMessage {
  /** 加密的消息ID */
  msgId: string;
  /** 消息类型 */
  msgtype: DingtalkMsgType;
  /** 文本内容 */
  text?: {
    content: string;
  };
  /** 富文本内容 */
  richText?: Array<{
    text?: string;
    pictureDownloadCode?: string;
  }>;
  /** 发送者ID */
  senderStaffId?: string;
  /** 发送者昵称 */
  senderNick?: string;
  /** 发送者企业ID */
  senderCorpId?: string;
  /** 会话ID */
  sessionWebhook?: string;
  /** 会话过期时间 */
  sessionWebhookExpiredTime?: number;
  /** 会话类型 1:单聊 2:群聊 */
  conversationType?: "1" | "2";
  /** 群聊 ID */
  openConversationId?: string;
  /** @机器人信息 */
  atUsers?: Array<{
    dingtalkId: string;
    staffId?: string;
  }>;
  /** 是否被 @全员 */
  isAtAll?: boolean;
  /** 机器人编码 */
  robotCode?: string;
  /** 创建时间 */
  createAt?: number;
  /** 是否在 @列表中 */
  isInAtList?: boolean;
}

/** 钉钉 Stream 消息 */
export interface DingtalkStreamMessage {
  specVersion: string;
  type: string;
  headers: {
    appId: string;
    connectionId: string;
    contentType: string;
    messageId: string;
    time: string;
    topic: string;
  };
  data: string; // JSON string of DingtalkCallbackMessage
}

/** 钉钉事件处理器 */
export class DingtalkEventHandler {
  private config: DingtalkConfig;
  /** 已处理消息缓存: msgId -> timestamp */
  private processedMessages = new Map<string, number>();
  /** 消息缓存过期时间 (5分钟) */
  private readonly MESSAGE_CACHE_TTL = 5 * 60 * 1000;
  /** 消息缓存最大数量 */
  private readonly MESSAGE_CACHE_MAX_SIZE = 10000;

  constructor(config: DingtalkConfig) {
    this.config = config;
  }

  /** 验证回调签名：未配置密钥失败关闭、校验时间窗、常量时间比较 */
  verifySignature(timestamp: string, sign: string): boolean {
    if (!this.config.appSecret) {
      logger.error("No app secret configured; rejecting callback");
      return false;
    }
    if (!isFreshTimestamp(timestamp)) {
      logger.warn({ timestamp }, "DingTalk callback timestamp outside allowed window");
      return false;
    }

    const stringToSign = timestamp + "\n" + this.config.appSecret;
    const expectedSign = computeHmacSha256(this.config.appSecret, stringToSign);
    return safeEqual(expectedSign, sign);
  }

  /** 检查消息是否已处理 (去重) */
  isMessageProcessed(msgId: string): boolean {
    if (this.processedMessages.has(msgId)) {
      return true;
    }

    const now = Date.now();

    // 添加到已处理缓存
    this.processedMessages.set(msgId, now);

    // 按时间过期清理
    if (this.processedMessages.size > this.MESSAGE_CACHE_MAX_SIZE) {
      for (const [id, timestamp] of this.processedMessages) {
        if (now - timestamp > this.MESSAGE_CACHE_TTL) {
          this.processedMessages.delete(id);
        }
      }
    }

    return false;
  }

  /** 解析消息内容 */
  parseMessageContent(message: DingtalkCallbackMessage): string {
    switch (message.msgtype) {
      case "text":
        return message.text?.content || "";

      case "richText":
        return (
          message.richText
            ?.map((item) => item.text || "[图片]")
            .join("") || ""
        );

      case "picture":
        return "[图片]";

      case "video":
        return "[视频]";

      case "file":
        return "[文件]";

      case "audio":
        return "[语音]";

      default:
        return `[${message.msgtype}]`;
    }
  }

  /** 将钉钉消息转换为通用消息上下文 */
  convertToMessageContext(message: DingtalkCallbackMessage): InboundMessageContext | null {
    // 检查消息去重
    if (this.isMessageProcessed(message.msgId)) {
      logger.debug({ msgId: message.msgId }, "Message already processed");
      return null;
    }

    const content = this.parseMessageContent(message);

    // 移除 @机器人 的内容
    let cleanContent = content;
    if (message.atUsers) {
      // 钉钉的 @ 格式通常是 @nickname
      cleanContent = content.replace(/@\S+\s?/g, "").trim();
    }

    const chatType: ChatType = message.conversationType === "2" ? "group" : "direct";

    return {
      channelId: "dingtalk",
      messageId: message.msgId,
      chatId: message.openConversationId || message.senderStaffId || "",
      chatType,
      senderId: message.senderStaffId || "",
      senderName: message.senderNick,
      content: cleanContent,
      mediaUrls: undefined,
      replyToId: undefined,
      mentions: message.atUsers?.map((u) => u.staffId || u.dingtalkId),
      timestamp: message.createAt || Date.now(),
      raw: message,
    };
  }

  /** 解析 Stream 消息 */
  parseStreamMessage(streamMessage: DingtalkStreamMessage): DingtalkCallbackMessage {
    return JSON.parse(streamMessage.data) as DingtalkCallbackMessage;
  }
}
