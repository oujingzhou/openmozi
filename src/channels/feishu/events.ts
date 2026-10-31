/**
 * 飞书事件处理
 */

import type { FeishuConfig, InboundMessageContext, ChatType } from "../../types/index.js";
import { getChildLogger } from "../../utils/logger.js";
import { aesDecrypt } from "../../utils/index.js";
import { isFreshTimestamp, safeEqual, sha256Hex } from "../common/signature.js";

const logger = getChildLogger("feishu-events");

/** 飞书事件类型 */
export type FeishuEventType =
  | "url_verification"
  | "im.message.receive_v1"
  | "im.message.message_read_v1"
  | "im.chat.member.bot.added_v1"
  | "im.chat.member.bot.deleted_v1";

/** 飞书事件头 */
export interface FeishuEventHeader {
  event_id: string;
  event_type: FeishuEventType;
  create_time: string;
  token: string;
  app_id: string;
  tenant_key: string;
}

/** URL 验证事件 */
export interface UrlVerificationEvent {
  challenge: string;
  token: string;
  type: "url_verification";
}

/** 消息接收事件 */
export interface MessageReceiveEvent {
  schema: string;
  header: FeishuEventHeader;
  event: {
    sender: {
      sender_id: {
        open_id: string;
        user_id?: string;
        union_id?: string;
      };
      sender_type: string;
      tenant_key: string;
    };
    message: {
      message_id: string;
      root_id?: string;
      parent_id?: string;
      create_time: string;
      chat_id: string;
      chat_type: "p2p" | "group";
      message_type: string;
      content: string;
      mentions?: Array<{
        key: string;
        id: {
          open_id: string;
          user_id?: string;
          union_id?: string;
        };
        name: string;
        tenant_key: string;
      }>;
    };
  };
}

/** 加密事件 */
export interface EncryptedEvent {
  encrypt: string;
}

/** 飞书事件处理器 */
export class FeishuEventHandler {
  private config: FeishuConfig;
  /** 已处理事件缓存: eventId -> timestamp */
  private processedEvents = new Map<string, number>();
  /** 事件缓存过期时间 (5分钟) */
  private readonly EVENT_CACHE_TTL = 5 * 60 * 1000;
  /** 事件缓存最大数量 */
  private readonly EVENT_CACHE_MAX_SIZE = 10000;

  constructor(config: FeishuConfig) {
    this.config = config;
  }

  /**
   * 验证事件签名。
   *
   * - 未配置 verificationToken 时**失败关闭**：宁可拒绝回调也不放行伪造请求。
   * - 校验时间戳窗口，避免抓包重放。
   * - 常量时间比较，避免按字节泄露签名。
   */
  verifySignature(timestamp: string, nonce: string, body: string, signature: string): boolean {
    if (!this.config.verificationToken) {
      logger.error("No verification token configured; rejecting callback");
      return false;
    }
    if (!isFreshTimestamp(timestamp)) {
      logger.warn({ timestamp }, "Feishu callback timestamp outside allowed window");
      return false;
    }

    const content = timestamp + nonce + this.config.verificationToken + body;
    return safeEqual(sha256Hex(content), signature);
  }

  /** 解密事件 */
  decryptEvent(encrypted: string): unknown {
    if (!this.config.encryptKey) {
      throw new Error("Encrypt key not configured");
    }

    const decrypted = aesDecrypt(this.config.encryptKey, encrypted);
    return JSON.parse(decrypted);
  }

  /** 解析事件 */
  parseEvent(body: unknown): { type: FeishuEventType; data: unknown } {
    // 检查是否为加密事件
    if (typeof body === "object" && body !== null && "encrypt" in body) {
      const encrypted = body as EncryptedEvent;
      body = this.decryptEvent(encrypted.encrypt);
    }

    // URL 验证
    if (typeof body === "object" && body !== null && "type" in body) {
      const verification = body as UrlVerificationEvent;
      if (verification.type === "url_verification") {
        return { type: "url_verification", data: verification };
      }
    }

    // 其他事件
    if (typeof body === "object" && body !== null && "header" in body) {
      const event = body as MessageReceiveEvent;
      return { type: event.header.event_type, data: event };
    }

    throw new Error("Unknown event format");
  }

  /** 处理 URL 验证 */
  handleUrlVerification(event: UrlVerificationEvent): { challenge: string } {
    // 验证 token
    if (this.config.verificationToken && event.token !== this.config.verificationToken) {
      throw new Error("Invalid verification token");
    }

    return { challenge: event.challenge };
  }

  /** 检查事件是否已处理 (去重) */
  isEventProcessed(eventId: string): boolean {
    if (this.processedEvents.has(eventId)) {
      return true;
    }

    const now = Date.now();

    // 添加到已处理缓存
    this.processedEvents.set(eventId, now);

    // 按时间过期清理
    if (this.processedEvents.size > this.EVENT_CACHE_MAX_SIZE) {
      for (const [id, timestamp] of this.processedEvents) {
        if (now - timestamp > this.EVENT_CACHE_TTL) {
          this.processedEvents.delete(id);
        }
      }
    }

    return false;
  }

  /** 将飞书消息事件转换为通用消息上下文 */
  convertToMessageContext(event: MessageReceiveEvent): InboundMessageContext | null {
    const { header, event: eventData } = event;

    // 检查事件去重
    if (this.isEventProcessed(header.event_id)) {
      logger.debug({ eventId: header.event_id }, "Event already processed");
      return null;
    }

    const { sender, message } = eventData;

    // 解析消息内容
    let content = "";
    let mediaUrls: string[] | undefined;

    try {
      const contentObj = JSON.parse(message.content);

      switch (message.message_type) {
        case "text":
          content = contentObj.text || "";
          break;
        case "post":
          // 富文本消息，提取纯文本
          content = this.extractPostText(contentObj);
          break;
        case "image":
          content = "[图片]";
          mediaUrls = [contentObj.image_key];
          break;
        case "file":
          content = `[文件: ${contentObj.file_name}]`;
          break;
        default:
          content = `[${message.message_type}]`;
      }
    } catch {
      content = message.content;
    }

    // 移除 @机器人 的内容
    if (message.mentions) {
      for (const mention of message.mentions) {
        if (!mention.key) continue;
        // 全局替换并转义正则元字符，避免 key 含元字符时漏替换或抛错
        const escaped = mention.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        content = content.replace(new RegExp(escaped, "g"), "").trim();
      }
    }

    const chatType: ChatType = message.chat_type === "p2p" ? "direct" : "group";

    return {
      channelId: "feishu",
      messageId: message.message_id,
      chatId: message.chat_id,
      chatType,
      senderId: sender.sender_id.open_id,
      senderName: undefined, // 需要额外 API 调用获取
      content: content.trim(),
      mediaUrls,
      replyToId: message.parent_id,
      mentions: message.mentions?.map((m) => m.id.open_id),
      timestamp: parseInt(message.create_time, 10),
      raw: event,
    };
  }

  /** 从富文本消息中提取纯文本 */
  private extractPostText(content: unknown): string {
    const texts: string[] = [];

    const extract = (obj: unknown) => {
      if (Array.isArray(obj)) {
        for (const item of obj) {
          extract(item);
        }
      } else if (typeof obj === "object" && obj !== null) {
        const record = obj as Record<string, unknown>;
        if (record.tag === "text" && typeof record.text === "string") {
          texts.push(record.text);
        } else if (record.tag === "a" && typeof record.text === "string") {
          texts.push(record.text);
        } else if (record.content) {
          extract(record.content);
        } else if (record.zh_cn) {
          extract(record.zh_cn);
        }
      }
    };

    extract(content);
    return texts.join("");
  }
}
