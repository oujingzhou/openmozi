/**
 * 飞书通道适配器
 *
 * 使用 WebSocket 长连接模式，无需公网部署
 */

import { Router, type Request, type Response } from "express";
import type {
  FeishuConfig,
  ChannelMeta,
  OutboundMessage,
} from "../../types/index.js";
import { BaseChannelAdapter } from "../common/base.js";
import { FeishuApiClient } from "./api.js";
import {
  FeishuEventHandler,
  type UrlVerificationEvent,
  type MessageReceiveEvent,
} from "./events.js";
import { FeishuWebSocketClient } from "./websocket.js";
import { getChildLogger } from "../../utils/logger.js";

/** 飞书通道元数据 */
const FEISHU_META: ChannelMeta = {
  id: "feishu",
  name: "飞书",
  description: "飞书 (Lark) 企业协作平台",
  capabilities: {
    chatTypes: ["direct", "group"],
    supportsMedia: true,
    supportsReply: true,
    supportsMention: true,
    supportsReaction: true,
    supportsThread: true,
    supportsEdit: false,
    maxMessageLength: 4096,
  },
};

export class FeishuChannel extends BaseChannelAdapter {
  readonly id = "feishu" as const;
  readonly meta = FEISHU_META;

  private config: FeishuConfig;
  private apiClient: FeishuApiClient;
  private eventHandler: FeishuEventHandler;
  private wsClient: FeishuWebSocketClient | null = null;
  private initialized = false;

  constructor(config: FeishuConfig) {
    super();
    this.config = config;
    this.apiClient = new FeishuApiClient(config);
    this.eventHandler = new FeishuEventHandler(config);
    this.logger = getChildLogger("feishu");
  }

  /** 初始化通道 */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.logger.info("Initializing Feishu channel");

    // 验证配置
    if (!this.config.appId || !this.config.appSecret) {
      throw new Error("Feishu appId and appSecret are required");
    }

    // 测试获取 token
    try {
      await this.apiClient.getTenantAccessToken();
      this.logger.info("Successfully authenticated with Feishu");
    } catch (error) {
      this.logger.error({ error }, "Failed to authenticate with Feishu");
      throw error;
    }

    // 启动 WebSocket 连接
    await this.startWebSocket();

    this.initialized = true;
  }

  /** 启动 WebSocket 连接 */
  private async startWebSocket(): Promise<void> {
    this.logger.info("Starting Feishu WebSocket client");
    this.wsClient = new FeishuWebSocketClient(this.config);

    // 设置事件处理器
    this.wsClient.setEventHandler(async (context) => {
      await this.handleInboundMessage(context);
    });

    // 启动连接
    await this.wsClient.start();
  }

  /** 关闭通道 */
  async shutdown(): Promise<void> {
    this.logger.info("Shutting down Feishu channel");

    if (this.wsClient) {
      await this.wsClient.stop();
      this.wsClient = null;
    }

    this.initialized = false;
  }

  /** 发送消息：错误处理与日志由基类统一负责 */
  protected async doSend(message: OutboundMessage): Promise<string> {
    if (message.replyToId) {
      return this.apiClient.replyText(message.replyToId, message.content);
    }
    return this.apiClient.sendText(message.chatId, message.content);
  }

  /** 健康检查：能取到 tenant token 且长连接在线 */
  protected async checkHealth(): Promise<void> {
    await this.apiClient.getTenantAccessToken();
    if (this.wsClient && !this.wsClient.isConnected()) {
      throw new Error("Feishu WebSocket is disconnected");
    }
  }

  /** 创建 Express 路由处理器 */
  createRouter(): Router {
    const router = Router();

    // Webhook 路由（用于飞书应用配置时的 URL 验证）
    router.post("/webhook", (req: Request, res: Response) => {
      this.handleWebhook(req, res).catch((error) => {
        this.logger.error({ error }, "Webhook handler error");
        res.status(500).json({ error: "Internal server error" });
      });
    });

    return router;
  }

  /** 处理 Webhook 请求（仅用于 URL 验证） */
  async handleWebhook(req: Request, res: Response): Promise<void> {
    const { body, headers } = req;

    // 验证签名
    const timestamp = headers["x-lark-request-timestamp"] as string;
    const nonce = headers["x-lark-request-nonce"] as string;
    const signature = headers["x-lark-signature"] as string;

    if (timestamp && nonce && signature) {
      const rawBody = JSON.stringify(body);
      if (!this.eventHandler.verifySignature(timestamp, nonce, rawBody, signature)) {
        this.logger.warn("Invalid signature");
        res.status(403).json({ error: "Invalid signature" });
        return;
      }
    }

    try {
      const { type, data } = this.eventHandler.parseEvent(body);

      switch (type) {
        case "url_verification":
          const challenge = this.eventHandler.handleUrlVerification(data as UrlVerificationEvent);
          res.json(challenge);
          break;

        case "im.message.receive_v1":
          // WebSocket 模式下忽略 Webhook 消息
          this.logger.debug("Ignoring webhook message (using WebSocket mode)");
          res.json({ code: 0 });
          break;

        default:
          this.logger.debug({ type }, "Ignoring event");
          res.json({ code: 0 });
      }
    } catch (error) {
      this.logger.error({ error }, "Failed to parse event");
      res.status(400).json({ error: "Invalid event" });
    }
  }

  /** 获取 API 客户端 */
  getApiClient(): FeishuApiClient {
    return this.apiClient;
  }

  /** 检查是否使用长连接 */
  isUsingWebSocket(): boolean {
    return this.wsClient !== null;
  }
}

/** 创建飞书通道 */
export function createFeishuChannel(config: FeishuConfig): FeishuChannel {
  return new FeishuChannel(config);
}
