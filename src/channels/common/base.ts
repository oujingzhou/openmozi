/**
 * 通道基类和接口
 */

import type {
  ChannelId,
  ChannelMeta,
  ChannelCapabilities,
  InboundMessageContext,
  OutboundMessage,
  SendResult,
} from "../../types/index.js";
import { getChildLogger } from "../../utils/logger.js";

/** 通道适配器接口 */
export interface ChannelAdapter {
  /** 通道 ID */
  id: ChannelId;

  /** 通道元数据 */
  meta: ChannelMeta;

  /** 初始化通道 */
  initialize(): Promise<void>;

  /** 关闭通道 */
  shutdown(): Promise<void>;

  /** 发送消息 */
  sendMessage(message: OutboundMessage): Promise<SendResult>;

  /** 发送文本消息 */
  sendText(chatId: string, text: string, replyToId?: string): Promise<SendResult>;

  /**
   * 根据入站消息上下文回复（由 Gateway 统一调用，通道可覆盖以实现会话级回复等）
   */
  replyToContext(context: InboundMessageContext, text: string): Promise<SendResult>;

  /** 检查通道状态 */
  isHealthy(): Promise<boolean>;
}

/** 消息处理器类型 */
export type MessageHandler = (context: InboundMessageContext) => Promise<void>;

/** 通道基类 */
export abstract class BaseChannelAdapter implements ChannelAdapter {
  abstract id: ChannelId;
  abstract meta: ChannelMeta;

  protected logger = getChildLogger("channel");
  protected messageHandler?: MessageHandler;

  /** 设置消息处理器 */
  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /** 处理入站消息 */
  protected async handleInboundMessage(context: InboundMessageContext): Promise<void> {
    if (this.messageHandler) {
      await this.messageHandler(context);
    } else {
      this.logger.warn("No message handler registered");
    }
  }

  abstract initialize(): Promise<void>;
  abstract shutdown(): Promise<void>;

  /**
   * 发送消息 —— 统一模板方法。
   *
   * 四个适配器原来各自复制了一份 try/catch → SendResult 的包装，
   * 这里收敛：子类只实现 doSend，错误捕获与日志在基类做一次。
   */
  async sendMessage(message: OutboundMessage): Promise<SendResult> {
    try {
      const messageId = await this.doSend(message);
      return messageId ? { success: true, messageId } : { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error({ error, channel: this.id }, "Failed to send message");
      return { success: false, error: errorMessage };
    }
  }

  /** 子类实现：真正发送，返回平台消息 ID（没有则返回 void） */
  protected abstract doSend(message: OutboundMessage): Promise<string | void>;

  /** 默认实现：转成 OutboundMessage 走统一模板 */
  async sendText(chatId: string, text: string, replyToId?: string): Promise<SendResult> {
    return this.sendMessage({ chatId, content: text, replyToId });
  }

  /** 默认实现：使用 chatId 与 messageId 调用 sendText */
  async replyToContext(context: InboundMessageContext, text: string): Promise<SendResult> {
    return this.sendText(context.chatId, text, context.messageId);
  }

  /** 默认健康检查：能拿到 access token 即视为健康 */
  async isHealthy(): Promise<boolean> {
    try {
      await this.checkHealth();
      return true;
    } catch {
      return false;
    }
  }

  /** 子类实现：拿一次凭证或探活；抛错表示不健康 */
  protected abstract checkHealth(): Promise<void>;
}
