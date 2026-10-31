/**
 * Gateway 服务器 - HTTP Webhook 处理 + WebChat
 */

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { createServer, type Server as HttpServer } from "http";
import NodeCache from "node-cache";
import type { MoziConfig, InboundMessageContext } from "../types/index.js";
import { createFeishuChannel, type FeishuChannel } from "../channels/feishu/index.js";
import { createDingtalkChannel, type DingtalkChannel } from "../channels/dingtalk/index.js";
import { createQQChannel, type QQChannel } from "../channels/qq/index.js";
import { createWeComChannel, type WeComChannel } from "../channels/wecom/index.js";
import { registerChannel, getChannel } from "../channels/common/index.js";
import { createAgent, type Agent } from "../agents/agent.js";
import { initializeProviders } from "../providers/index.js";
import { getChildLogger, setLogger, createLogger } from "../utils/logger.js";
import { WsServer } from "../web/websocket.js";
import { handleStaticRequest } from "../web/static.js";

const logger = getChildLogger("gateway");

export class Gateway {
  private app: Express;
  private httpServer: HttpServer;
  private config: MoziConfig;
  private agent!: Agent;
  private feishuChannel?: FeishuChannel;
  private dingtalkChannel?: DingtalkChannel;
  private qqChannel?: QQChannel;
  private wecomChannel?: WeComChannel;
  private wsServer?: WsServer;
  /** 已处理的消息 ID 缓存（用于去重，带 TTL 与最大条数） */
  private processedMessages: NodeCache;
  /** 消息缓存过期时间 (秒，5 分钟) */
  private readonly MESSAGE_CACHE_TTL_SEC = 300;
  /** 消息去重缓存最大条数 */
  private readonly MESSAGE_CACHE_MAX_KEYS = 10000;

  /** 是否启动通讯通道（--web-only 时为 false） */
  private readonly enableChannels: boolean;

  constructor(config: MoziConfig, options: { enableChannels?: boolean } = {}) {
    this.config = config;
    this.enableChannels = options.enableChannels !== false;
    this.app = express();
    this.httpServer = createServer(this.app);
    this.processedMessages = new NodeCache({
      stdTTL: this.MESSAGE_CACHE_TTL_SEC,
      maxKeys: this.MESSAGE_CACHE_MAX_KEYS,
      useClones: false,
    });

    this.setupMiddleware();
    this.setupRoutes();
  }

  /** 初始化 Agent（异步） */
  async initAgent(): Promise<void> {
    this.agent = await createAgent(this.config);
  }

  /** 设置中间件 */
  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    // 企业微信回调是 text/xml：没有这个 parser，req.body 会变成 {}，
    // 导致 <Encrypt> 取不到、所有入站消息被静默丢弃。
    this.app.use(express.text({ type: ["text/xml", "application/xml"], limit: "1mb" }));

    // 请求日志
    this.app.use((req, res, next) => {
      logger.debug({ method: req.method, path: req.path }, "Incoming request");
      next();
    });
  }

  /** 设置路由 */
  private setupRoutes(): void {
    // 健康检查
    this.app.get("/health", (req, res) => {
      res.json({ status: "ok", timestamp: new Date().toISOString() });
    });

    if (!this.enableChannels) {
      logger.info("通讯通道已禁用（仅 Web 模式）");
    }

    // 飞书 (WebSocket 长连接)
    if (this.enableChannels && this.config.channels.feishu) {
      this.feishuChannel = createFeishuChannel(this.config.channels.feishu);
      this.feishuChannel.setMessageHandler(this.handleMessage.bind(this));
      this.app.use("/feishu", this.feishuChannel.createRouter());
      registerChannel(this.feishuChannel);
      logger.info("Feishu channel enabled (WebSocket mode)");
    }

    // 钉钉 (Stream 长连接)
    if (this.enableChannels && this.config.channels.dingtalk) {
      this.dingtalkChannel = createDingtalkChannel(this.config.channels.dingtalk);
      this.dingtalkChannel.setMessageHandler(this.handleMessage.bind(this));
      this.app.use("/dingtalk", this.dingtalkChannel.createRouter());
      registerChannel(this.dingtalkChannel);
      logger.info("DingTalk channel enabled (Stream mode)");
    }

    // QQ 机器人
    if (this.enableChannels && this.config.channels.qq) {
      this.qqChannel = createQQChannel(this.config.channels.qq);
      this.qqChannel.setMessageHandler(this.handleMessage.bind(this));
      registerChannel(this.qqChannel);
      logger.info("QQ bot enabled (WebSocket mode)");
    }

    // 企业微信
    if (this.enableChannels && this.config.channels.wecom) {
      this.wecomChannel = createWeComChannel(this.config.channels.wecom);
      this.wecomChannel.setMessageHandler(this.handleMessage.bind(this));
      this.app.use("/wecom", this.wecomChannel.createRouter());
      registerChannel(this.wecomChannel);
      logger.info("WeCom webhook enabled at /wecom/webhook");
    }

    // WebChat 静态文件服务 (放在其他路由之后，作为默认处理)
    this.app.use((req, res, next) => {
      const handled = handleStaticRequest(req, res, { config: this.config });
      if (!handled) {
        next();
      }
    });

    // 404 处理
    this.app.use((req, res) => {
      res.status(404).json({ error: "Not found" });
    });

    // 错误处理
    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      logger.error({ error: err }, "Unhandled error");
      res.status(500).json({ error: "Internal server error" });
    });
  }

  /** 处理入站消息 */
  private async handleMessage(context: InboundMessageContext): Promise<void> {
    // 消息去重检查
    if (this.isDuplicateMessage(context.messageId)) {
      logger.debug({ messageId: context.messageId }, "Skipping duplicate message");
      return;
    }

    logger.info(
      {
        channel: context.channelId,
        chatId: context.chatId,
        senderId: context.senderId,
        content: context.content.slice(0, 100),
      },
      "Received message"
    );

    // 忽略空消息
    if (!context.content.trim()) {
      return;
    }

    try {
      // 处理消息
      const response = await this.agent.processMessage(context);

      // 发送回复
      await this.sendReply(context, response.content);

      logger.info(
        {
          channel: context.channelId,
          chatId: context.chatId,
          responseLength: response.content.length,
        },
        "Reply sent"
      );
    } catch (error) {
      logger.error({ error, context }, "Failed to process message");

      // 发送错误提示
      await this.sendReply(context, "抱歉，处理您的消息时出现了错误。请稍后重试。");
    }
  }

  /** 发送回复（通过通道注册表，由各通道自行实现 replyToContext） */
  private async sendReply(context: InboundMessageContext, text: string): Promise<void> {
    const channel = getChannel(context.channelId);
    if (!channel) {
      logger.warn({ channelId: context.channelId }, "No channel registered for reply");
      return;
    }
    try {
      await channel.replyToContext(context, text);
    } catch (error) {
      logger.error({ error, channelId: context.channelId, chatId: context.chatId }, "Failed to send reply");
    }
  }

  /** 检查是否为重复消息（使用带容量上限的缓存，自动过期） */
  private isDuplicateMessage(messageId: string): boolean {
    if (this.processedMessages.has(messageId)) {
      return true;
    }
    this.processedMessages.set(messageId, 1);
    return false;
  }

  /** 初始化 */
  async initialize(): Promise<void> {
    logger.info("Initializing gateway...");

    // 初始化模型提供商
    initializeProviders(this.config);

    // 初始化 WebSocket 服务器
    this.wsServer = new WsServer({
      server: this.httpServer,
      agent: this.agent,
      config: this.config,
    });

    // 初始化通道：单个通道初始化失败不应拖垮整个服务
    // （WebChat 本身是完整入口，其他通道是可选的）。
    await this.initChannel("feishu", this.feishuChannel);
    await this.initChannel("dingtalk", this.dingtalkChannel);
    await this.initChannel("qq", this.qqChannel);
    await this.initChannel("wecom", this.wecomChannel);

    logger.info("Gateway initialized");
  }

  /** 初始化单个通道；失败只告警并注销该通道 */
  private async initChannel(
    id: string,
    channel: { initialize(): Promise<void> } | undefined
  ): Promise<void> {
    if (!channel) return;
    try {
      await channel.initialize();
    } catch (error) {
      logger.error(
        { error, channel: id },
        `通道 ${id} 初始化失败，已跳过；其余入口继续提供服务`
      );
    }
  }

  /** 启动服务器 */
  async start(): Promise<void> {
    await this.initialize();

    const { port, host } = this.config.server;

    this.httpServer.listen(port, host || "0.0.0.0", () => {
      logger.info({ port, host: host || "0.0.0.0" }, "Gateway server started");
      console.log(`\n🚀 Mozi Gateway 已启动`);
      console.log(`   地址: http://${host || "localhost"}:${port}`);
      console.log(`   WebChat: http://${host || "localhost"}:${port}/`);
      console.log(`   控制台: http://${host || "localhost"}:${port}/control`);
      console.log(`   健康检查: http://${host || "localhost"}:${port}/health`);
      if (this.feishuChannel) {
        console.log(`   飞书: WebSocket 长连接已启动`);
      }
      if (this.dingtalkChannel) {
        console.log(`   钉钉: Stream 长连接已启动`);
      }
      if (this.qqChannel) {
        console.log(`   QQ 机器人: WebSocket 长连接已启动`);
      }
      if (this.wecomChannel) {
        console.log(`   企业微信 Webhook: http://${host || "localhost"}:${port}/wecom/webhook`);
      }
      console.log("");
    });
  }

  /** 关闭 */
  async shutdown(): Promise<void> {
    logger.info("Shutting down gateway...");

    if (this.wsServer) {
      this.wsServer.close();
    }

    if (this.feishuChannel) {
      await this.feishuChannel.shutdown();
    }
    if (this.dingtalkChannel) {
      await this.dingtalkChannel.shutdown();
    }
    if (this.qqChannel) {
      await this.qqChannel.shutdown();
    }
    if (this.wecomChannel) {
      await this.wecomChannel.shutdown();
    }

    this.httpServer.close();

    logger.info("Gateway shut down");
  }

  /** 获取 Express 应用 */
  getApp(): Express {
    return this.app;
  }
}

/** 创建 Gateway */
export async function createGateway(
  config: MoziConfig,
  options: { enableChannels?: boolean } = {}
): Promise<Gateway> {
  const gateway = new Gateway(config, options);
  await gateway.initAgent();
  return gateway;
}

/** 启动 Gateway 服务器 */
export async function startGateway(
  config: MoziConfig,
  options: { enableChannels?: boolean } = {}
): Promise<Gateway> {
  // 设置日志
  setLogger(createLogger({ level: config.logging.level }));

  const gateway = await createGateway(config, options);
  await gateway.start();

  // 优雅关闭
  process.on("SIGINT", async () => {
    console.log("\n收到 SIGINT 信号，正在关闭...");
    await gateway.shutdown();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log("\n收到 SIGTERM 信号，正在关闭...");
    await gateway.shutdown();
    process.exit(0);
  });

  return gateway;
}
