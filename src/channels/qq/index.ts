/**
 * QQ 通道适配器
 *
 * 使用 WebSocket 长连接模式，无需公网部署
 */

import type {
  QQConfig,
  ChannelMeta,
  OutboundMessage,
} from "../../types/index.js";
import { BaseChannelAdapter } from "../common/base.js";
import { QQApiClient } from "./api.js";
import { QQWebSocketClient } from "./websocket.js";
import { getChildLogger } from "../../utils/logger.js";

/** QQ 通道元数据 */
const QQ_META: ChannelMeta = {
  id: "qq",
  name: "QQ",
  description: "QQ 机器人 (官方 API)",
  capabilities: {
    chatTypes: ["direct", "group"],
    supportsMedia: true,
    supportsReply: true,
    supportsMention: true,
    supportsReaction: false,
    supportsThread: false,
    supportsEdit: false,
    maxMessageLength: 4096,
  },
};

export class QQChannel extends BaseChannelAdapter {
  readonly id = "qq" as const;
  readonly meta = QQ_META;

  private config: QQConfig;
  private apiClient: QQApiClient;
  private wsClient: QQWebSocketClient | null = null;
  private initialized = false;

  constructor(config: QQConfig) {
    super();
    this.config = config;
    this.apiClient = new QQApiClient(config);
    this.logger = getChildLogger("qq");
  }

  /** 初始化通道 */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.logger.info("Initializing QQ channel");

    // 验证配置
    if (!this.config.appId || !this.config.clientSecret) {
      throw new Error("QQ appId and clientSecret are required");
    }

    // 测试获取 token
    try {
      await this.apiClient.getAccessToken();
      this.logger.info("Successfully authenticated with QQ");
    } catch (error) {
      this.logger.error({ error }, "Failed to authenticate with QQ");
      throw error;
    }

    // 启动 WebSocket 连接
    await this.startWebSocket();

    this.initialized = true;
  }

  /** 启动 WebSocket 连接 */
  private async startWebSocket(): Promise<void> {
    this.logger.info("Starting QQ WebSocket client");
    this.wsClient = new QQWebSocketClient(this.config);

    // 设置事件处理器
    this.wsClient.setEventHandler(async (context) => {
      await this.handleInboundMessage(context);
    });

    // 启动连接
    await this.wsClient.start();
  }

  /** 关闭通道 */
  async shutdown(): Promise<void> {
    this.logger.info("Shutting down QQ channel");

    if (this.wsClient) {
      await this.wsClient.stop();
      this.wsClient = null;
    }

    this.initialized = false;
  }

  /** 发送消息：按 chatId 前缀路由到群/私聊/频道 */
  protected async doSend(message: OutboundMessage): Promise<void> {
    const { chatId, content, replyToId } = message;

    if (chatId.startsWith("group:")) {
      await this.apiClient.sendGroupMessage(chatId.slice("group:".length), content, replyToId);
    } else if (chatId.startsWith("c2c:")) {
      await this.apiClient.sendDirectMessage(chatId.slice("c2c:".length), content, replyToId);
    } else if (chatId.startsWith("dms:")) {
      await this.apiClient.sendDMMessage(chatId.slice("dms:".length), content, replyToId);
    } else if (chatId.startsWith("channel:")) {
      await this.apiClient.sendChannelMessage(chatId.slice("channel:".length), content, replyToId);
    } else {
      // 未带前缀时按频道消息处理（向后兼容）
      await this.apiClient.sendChannelMessage(chatId, content, replyToId);
    }
  }

  /** 健康检查：能取到 token 且长连接在线 */
  protected async checkHealth(): Promise<void> {
    await this.apiClient.getAccessToken();
    if (this.wsClient && !this.wsClient.checkConnected()) {
      throw new Error("QQ WebSocket is disconnected");
    }
  }

  /** 获取 API 客户端 */
  getApiClient(): QQApiClient {
    return this.apiClient;
  }

  /** 检查是否使用长连接 */
  isUsingWebSocket(): boolean {
    return this.wsClient !== null;
  }
}

/** 创建 QQ 通道 */
export function createQQChannel(config: QQConfig): QQChannel {
  return new QQChannel(config);
}
