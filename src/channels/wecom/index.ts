/**
 * 企业微信通道适配器
 *
 * 使用 HTTP 回调模式，需要公网部署
 */

import { Router, type Request, type Response } from "express";
import type {
  WeComConfig,
  ChannelMeta,
  OutboundMessage,
} from "../../types/index.js";
import { BaseChannelAdapter } from "../common/base.js";
import { WeComApiClient } from "./api.js";
import { WeComEventHandler } from "./events.js";
import { getChildLogger } from "../../utils/logger.js";

/** 企业微信通道元数据 */
const WECOM_META: ChannelMeta = {
  id: "wecom",
  name: "企业微信",
  description: "企业微信自建应用机器人",
  capabilities: {
    chatTypes: ["direct", "group"],
    supportsMedia: true,
    supportsReply: false, // 企业微信不支持回复特定消息
    supportsMention: true,
    supportsReaction: false,
    supportsThread: false,
    supportsEdit: false,
    maxMessageLength: 2048,
  },
};

export class WeComChannel extends BaseChannelAdapter {
  readonly id = "wecom" as const;
  readonly meta = WECOM_META;

  private config: WeComConfig;
  private apiClient: WeComApiClient;
  private eventHandler: WeComEventHandler;
  private initialized = false;

  constructor(config: WeComConfig) {
    super();
    this.config = config;
    this.apiClient = new WeComApiClient(config);
    this.eventHandler = new WeComEventHandler(config);
    this.logger = getChildLogger("wecom");
  }

  /** 初始化通道 */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.logger.info("Initializing WeCom channel");

    // 验证配置
    if (!this.config.corpId || !this.config.corpSecret) {
      throw new Error("WeCom corpId and corpSecret are required");
    }

    if (!this.config.agentId) {
      throw new Error("WeCom agentId is required");
    }

    // 测试获取 token
    try {
      await this.apiClient.getAccessToken();
      this.logger.info("Successfully authenticated with WeCom");
    } catch (error) {
      this.logger.error({ error }, "Failed to authenticate with WeCom");
      throw error;
    }

    this.initialized = true;
  }

  /** 关闭通道 */
  async shutdown(): Promise<void> {
    this.logger.info("Shutting down WeCom channel");
    this.initialized = false;
  }

  /** 发送消息：direct: 前缀走应用消息，其余按群聊 */
  protected async doSend(message: OutboundMessage): Promise<void> {
    const { chatId, content } = message;
    if (chatId.startsWith("direct:")) {
      await this.apiClient.sendTextMessage(chatId.slice("direct:".length), content);
    } else {
      await this.apiClient.sendGroupTextMessage(chatId, content);
    }
  }

  /** 健康检查：能取到 access token 即认为正常 */
  protected async checkHealth(): Promise<void> {
    await this.apiClient.getAccessToken();
  }

  /** 创建 Express 路由处理器 */
  createRouter(): Router {
    const router = Router();

    // URL 验证 (GET 请求)
    router.get("/webhook", (req: Request, res: Response) => {
      this.handleUrlVerification(req, res);
    });

    // 消息回调 (POST 请求)
    router.post("/webhook", (req: Request, res: Response) => {
      this.handleWebhook(req, res).catch((error) => {
        this.logger.error({ error }, "Webhook handler error");
        res.status(500).send("Internal server error");
      });
    });

    return router;
  }

  /** 处理 URL 验证 */
  private handleUrlVerification(req: Request, res: Response): void {
    const { msg_signature, timestamp, nonce, echostr } = req.query;

    if (!msg_signature || !timestamp || !nonce || !echostr) {
      this.logger.warn("Missing verification parameters");
      res.status(400).send("Missing parameters");
      return;
    }

    const decrypted = this.eventHandler.verifyUrl(
      msg_signature as string,
      timestamp as string,
      nonce as string,
      echostr as string
    );

    if (decrypted) {
      this.logger.info("URL verification successful");
      res.send(decrypted);
    } else {
      this.logger.warn("URL verification failed");
      res.status(403).send("Verification failed");
    }
  }

  /** 处理 Webhook 请求 */
  async handleWebhook(req: Request, res: Response): Promise<void> {
    const { msg_signature, timestamp, nonce } = req.query;

    if (!msg_signature || !timestamp || !nonce) {
      this.logger.warn("Missing webhook parameters");
      res.status(400).send("Missing parameters");
      return;
    }

    // 获取原始 XML 内容
    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);

    try {
      const message = this.eventHandler.parseMessage(
        msg_signature as string,
        timestamp as string,
        nonce as string,
        rawBody
      );

      if (!message) {
        // 返回空响应
        res.send("success");
        return;
      }

      this.logger.debug({ message }, "Received message");

      // 转换并处理消息
      const context = this.eventHandler.convertToMessageContext(message);
      if (context) {
        // 异步处理消息，先返回响应
        res.send("success");

        this.handleInboundMessage(context).catch((error) => {
          this.logger.error({ error, context }, "Failed to handle message");
        });
      } else {
        res.send("success");
      }
    } catch (error) {
      this.logger.error({ error }, "Failed to parse message");
      res.send("success"); // 企业微信要求返回成功，否则会重试
    }
  }

  /** 获取 API 客户端 */
  getApiClient(): WeComApiClient {
    return this.apiClient;
  }
}

/** 创建企业微信通道 */
export function createWeComChannel(config: WeComConfig): WeComChannel {
  return new WeComChannel(config);
}
