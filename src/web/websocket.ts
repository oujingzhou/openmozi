/**
 * WebSocket 服务器
 *
 * 协议（对齐 deepseek-harness 的"命令 + 下行事件"分离）：
 * - 客户端 -> 服务端：{type:"req", id, method, params}，服务端回 {type:"res", id, ok, payload|error}
 * - 服务端 -> 客户端：{type:"event", event, payload}
 *
 * 关键下行事件：
 * - connected            连接建立
 * - session.snapshot     订阅后会立即收到一次完整快照（含进行中的回合）
 * - session.event        带 seq 的增量事件；客户端检测到 seq 缺口时重新拉快照
 * - session.status       会话运行状态变更
 * - chat.delta / chat.error  纯文本流（兼容旧客户端）
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "http";
import { getChildLogger } from "../utils/logger.js";
import { generateId } from "../utils/index.js";
import type {
  WsFrame,
  WsRequestFrame,
  WsResponseFrame,
  WsEventFrame,
  ChatSendParams,
  ChatDeltaEvent,
  SystemStatus,
  SessionsListParams,
  SessionsHistoryParams,
  SessionsDeleteParams,
  SessionsResetParams,
  SessionsRestoreParams,
  SessionsSubscribeParams,
  ConfigInfo,
  ConfigSaveParams,
  ConfigValidateResult,
} from "./types.js";
import type { Agent } from "../agents/agent.js";
import type { MoziConfig, ProviderId, InboundMessageContext } from "../types/index.js";
import { getAllProviders } from "../providers/index.js";
import { getAllChannels } from "../channels/index.js";
import { getSessionStore } from "../sessions/index.js";
import { fallbackTitle, summarizeTitle } from "../sessions/title.js";
import { resolveModel, getApiKeyForProvider } from "../providers/model-resolver.js";
import { getConfigInfo, validateConfig, saveConfig } from "./config-ops.js";
import { loadConfig, getActiveConfigPath } from "../config/index.js";
import { initializeProviders } from "../providers/index.js";
import { initModelResolver } from "../providers/model-resolver.js";
import { snapshotFromTranscript } from "./legacy-transcript.js";
import type { SequencedLiveEvent } from "../durable/index.js";

const logger = getChildLogger("websocket");

/** 判定是否为主动取消导致的错误 */
function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.message === "Aborted") return true;
  return "code" in error && error.code === "ABORT_ERR";
}

/** WebSocket 客户端 */
interface WsClient {
  id: string;
  ws: WebSocket;
  sessionKey: string | null;
  sessionId: string | null;
  /** 已订阅的会话 */
  subscribed: Set<string>;
  lastPing: number;
  /** 当前聊天请求的 AbortController */
  currentAbortController: AbortController | null;
}

export interface WsServerOptions {
  server: HttpServer;
  agent: Agent;
  config: MoziConfig;
  heartbeatInterval?: number;
  clientTimeout?: number;
}

export class WsServer {
  private wss: WebSocketServer;
  private clients = new Map<string, WsClient>();
  private agent: Agent;
  private config: MoziConfig;
  private startTime = Date.now();
  private heartbeatInterval: number;
  private clientTimeout: number;
  private unsubscribeDurable: (() => void) | null = null;
  /** 各会话最近一次广播的 seq，用于丢弃重复事件 */
  private lastBroadcastSeq = new Map<string, number>();

  constructor(options: WsServerOptions) {
    this.agent = options.agent;
    this.config = options.config;
    this.heartbeatInterval = options.heartbeatInterval ?? 30000;
    this.clientTimeout = options.clientTimeout ?? 60000;

    this.wss = new WebSocketServer({ server: options.server, path: "/ws" });

    this.wss.on("connection", (ws) => {
      this.handleConnection(ws);
    });

    // 把 durable store 的实时事件转成下行帧
    this.unsubscribeDurable = this.agent.subscribeDurable((event) => {
      this.broadcastSessionEvent(event);
    });

    setInterval(() => this.checkHeartbeat(), this.heartbeatInterval);

    logger.info("WebSocket server initialized");
  }

  private async handleConnection(ws: WebSocket): Promise<void> {
    const clientId = generateId("client");
    const client: WsClient = {
      id: clientId,
      ws,
      sessionKey: null,
      sessionId: null,
      subscribed: new Set(),
      lastPing: Date.now(),
      currentAbortController: null,
    };

    this.clients.set(clientId, client);
    logger.info({ clientId }, "Client connected");

    this.sendEvent(ws, "connected", { clientId, version: "1.0.0" });

    ws.on("message", (data) => {
      void this.handleMessage(client, data.toString());
    });
    ws.on("close", () => {
      this.clients.delete(clientId);
      logger.info({ clientId }, "Client disconnected");
    });
    ws.on("error", (error) => {
      logger.error({ clientId, error }, "WebSocket error");
    });
    ws.on("pong", () => {
      client.lastPing = Date.now();
    });
  }

  private async handleMessage(client: WsClient, data: string): Promise<void> {
    try {
      const frame = JSON.parse(data) as WsFrame;
      if (frame.type === "req") await this.handleRequest(client, frame);
    } catch (error) {
      logger.error({ error, data }, "Failed to handle message");
    }
  }

  private async handleRequest(client: WsClient, frame: WsRequestFrame): Promise<void> {
    const { id, method, params } = frame;

    try {
      const result = await this.dispatch(client, method, params);
      this.sendResponse(client.ws, id, true, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ method, error: message }, "Request failed");
      this.sendResponse(client.ws, id, false, undefined, { code: "ERROR", message });
    }
  }

  private async dispatch(client: WsClient, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "chat.send":
        return this.handleChatSend(client, params as ChatSendParams);
      case "chat.cancel":
        return this.handleChatCancel(client);
      case "chat.dequeue":
        return this.handleChatDequeue(client, params as { queueId?: string });
      case "chat.steer":
        return this.handleChatSteer(client, params as { queueId?: string });
      case "chat.clear":
        return this.handleChatClear(client);
      case "sessions.list":
        return this.handleSessionsList(params as SessionsListParams | undefined);
      case "sessions.history":
        return this.handleSessionsHistory(params as SessionsHistoryParams);
      case "sessions.delete":
        return this.handleSessionsDelete(params as SessionsDeleteParams);
      case "sessions.reset":
        return this.handleSessionsReset(params as SessionsResetParams);
      case "sessions.restore":
        return this.handleSessionsRestore(client, params as SessionsRestoreParams);
      case "sessions.subscribe":
        return this.handleSessionsSubscribe(client, params as SessionsSubscribeParams);
      case "sessions.unsubscribe":
        return this.handleSessionsUnsubscribe(client, params as SessionsSubscribeParams);
      case "status.get":
        return this.getSystemStatus();
      case "session.info":
        return this.getSessionInfo(client);
      case "config.get":
        return this.getConfigInfo();
      case "config.validate":
        return this.validateConfig(params as ConfigSaveParams);
      case "config.save":
        return this.saveConfig(params as ConfigSaveParams);
      case "ping":
        return { pong: Date.now() };
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  /** 确保客户端有 session，如果没有则创建 */
  private async ensureSession(client: WsClient): Promise<void> {
    if (client.sessionKey && client.sessionId) return;

    const store = getSessionStore();
    const sessionKey = client.sessionKey ?? `webchat:${client.id}`;
    const session = await store.getOrCreate(sessionKey);

    client.sessionKey = sessionKey;
    client.sessionId = session.sessionId;
    logger.info({ clientId: client.id, sessionKey, sessionId: session.sessionId }, "Session created");
  }

  /** 处理聊天发送：事件通过 durable 订阅广播，这里只负责启动回合 */
  private async handleChatSend(
    client: WsClient,
    params: ChatSendParams
  ): Promise<{ messageId: string; turnId?: string; queued?: boolean; queueId?: string }> {
    if (params.sessionKey) {
      client.sessionKey = params.sessionKey;
      const store = getSessionStore();
      const session = await store.getOrCreate(params.sessionKey);
      client.sessionId = session.sessionId;
    }
    await this.ensureSession(client);

    const { message, requestId } = params;
    if (!message?.trim()) throw new Error("message 不能为空");

    const messageId = generateId("msg");
    const store = getSessionStore();

    // sessionKey 同时作为 senderId，使 AgentRuntime 推导出一致的会话
    const stableSenderId = client.sessionKey!.replace("webchat:", "");

    const context: InboundMessageContext = {
      channelId: "webchat",
      chatId: client.sessionKey!,
      messageId,
      senderId: stableSenderId,
      senderName: "WebChat User",
      content: message,
      chatType: "direct",
      timestamp: Date.now(),
    };

    const sessionKey = client.sessionKey!;
    const sessionId = client.sessionId!;

    // 回合运行期间：默认排队（followUp），显式 steer 则中断当前回合
    if (this.agent.isBusy(sessionKey)) {
      const behavior = params.whenBusy === "steer" ? "steer" : "followUp";
      const queueId = this.agent.enqueueMessage({
        sessionKey,
        content: message,
        behavior,
        context,
      });
      return { messageId, queued: true, queueId };
    }

    const userMessage = {
      id: messageId,
      role: "user" as const,
      content: message,
      timestamp: Date.now(),
    };
    await store.appendTranscript(sessionId, sessionKey, userMessage);

    const controller = new AbortController();
    client.currentAbortController = controller;
    const ws = client.ws;

    // 回合在后台跑；事件通过 durable 订阅推送
    void (async () => {
      let fullContent = "";
      try {
        const stream = this.agent.processMessageEvents(context, {
          signal: controller.signal,
          requestId,
          source: "webchat",
        });
        // 纯文本增量仍走 chat.delta，供旧客户端渲染
        for await (const event of stream) {
          if (event.type === "text_delta") {
            fullContent += event.delta;
            this.sendEvent(ws, "chat.delta", {
              sessionId,
              delta: event.delta,
              done: false,
            } satisfies ChatDeltaEvent);
          }
        }
        client.currentAbortController = null;

        const assistantMessage = {
          id: generateId("msg"),
          role: "assistant" as const,
          content: fullContent,
          timestamp: Date.now(),
        };
        await store.appendTranscript(sessionId, sessionKey, assistantMessage);

        this.sendEvent(ws, "chat.delta", { sessionId, delta: "", done: true } satisfies ChatDeltaEvent);

        // 首轮结束后补一个可读的会话标题（不阻塞对话）
        void this.ensureSessionTitle(sessionKey, message, fullContent);
      } catch (error) {
        client.currentAbortController = null;
        const isAborted = isAbortError(error);

        if (isAborted) {
          this.sendEvent(ws, "chat.delta", {
            sessionId,
            delta: "",
            done: true,
            cancelled: true,
          } satisfies ChatDeltaEvent);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          this.sendEvent(ws, "chat.error", { sessionId, error: message });
        }
      }
    })();

    return { messageId };
  }

  /**
   * 补会话标题。
   * 先写入基于首条消息的兜底标题，再尝试用模型生成摘要；
   * 用户自定义的标题不会被覆盖。
   */
  private async ensureSessionTitle(
    sessionKey: string,
    userText: string,
    assistantText: string
  ): Promise<void> {
    try {
      const store = getSessionStore();
      const entry = await store.get(sessionKey);
      if (!entry) return;

      if (!entry.label || entry.labelSource === "fallback") {
        await store.setLabel(sessionKey, fallbackTitle(userText), "fallback");
        this.broadcast("session.updated", { sessionKey });
      }

      if (entry.labelSource === "model" || entry.labelSource === "user") return;
      if (this.config.sessions?.autoTitle === false) return;

      const model = resolveModel(this.config.agent.defaultProvider, this.config.agent.defaultModel);
      const apiKey = getApiKeyForProvider(this.config.agent.defaultProvider);
      if (!model || !apiKey) return;

      const title = await summarizeTitle({ model, apiKey, userText, assistantText });
      if (!title) return;

      await store.setLabel(sessionKey, title, "model");
      this.broadcast("session.updated", { sessionKey });
    } catch (error) {
      logger.debug({ error, sessionKey }, "生成会话标题失败");
    }
  }

  /** 删除排队消息 */
  private handleChatDequeue(client: WsClient, params: { queueId?: string }): { removed: boolean } {
    if (!client.sessionKey || !params.queueId) return { removed: false };
    return { removed: this.agent.dequeueMessage(client.sessionKey, params.queueId) };
  }

  /** 把排队消息升级为插入（中断当前回合） */
  private handleChatSteer(client: WsClient, params: { queueId?: string }): { steered: boolean } {
    if (!client.sessionKey || !params.queueId) return { steered: false };
    return { steered: this.agent.steerQueued(client.sessionKey, params.queueId) };
  }

  private handleChatCancel(client: WsClient): { cancelled: boolean } {
    if (!client.currentAbortController) return { cancelled: false };
    client.currentAbortController.abort();
    client.currentAbortController = null;
    return { cancelled: true };
  }

  private async handleChatClear(
    client: WsClient
  ): Promise<{ success: boolean; sessionKey: string; sessionId: string }> {
    await this.ensureSession(client);
    const store = getSessionStore();
    const oldSessionKey = client.sessionKey!;

    // 重置 durable 日志与 pi 上下文
    await this.agent.clearSession({
      channelId: "webchat",
      chatId: oldSessionKey,
      messageId: generateId("msg"),
      senderId: oldSessionKey.replace("webchat:", ""),
      senderName: "WebChat User",
      content: "",
      chatType: "direct",
      timestamp: Date.now(),
    });

    const newSession = await store.reset(oldSessionKey);
    client.sessionKey = newSession.sessionKey;
    client.sessionId = newSession.sessionId;

    logger.info(
      { clientId: client.id, oldSessionKey, newSessionKey: newSession.sessionKey },
      "Chat cleared, new session created"
    );
    return { success: true, sessionKey: newSession.sessionKey, sessionId: newSession.sessionId };
  }

  private async handleSessionsList(params?: SessionsListParams): Promise<unknown> {
    const store = getSessionStore();
    let sessions = await store.list({
      limit: params?.limit,
      activeMinutes: params?.activeMinutes,
      search: params?.search,
    });

    // 存量会话补兜底标题：优先用首条用户消息，避免侧边栏全是 session_xxx
    let backfilled = false;
    for (const session of sessions.slice(0, 100)) {
      if (session.label) continue;
      const messages = await store.loadTranscript(session.sessionId);
      const firstUser = messages.find((message) => message.role === "user" && typeof message.content === "string");
      if (!firstUser) continue;
      await store.setLabel(session.sessionKey, fallbackTitle(String(firstUser.content)), "fallback");
      backfilled = true;
    }
    if (backfilled) {
      sessions = await store.list({
        limit: params?.limit,
        activeMinutes: params?.activeMinutes,
        search: params?.search,
      });
    }

    // 附加 durable 运行状态，供侧边栏状态点使用
    const enriched = sessions.map((session) => {
      const snapshot = this.agent.getSnapshot(session.sessionKey);
      return {
        ...session,
        running: snapshot?.running ?? false,
        turnCount: snapshot?.turns.length ?? 0,
      };
    });

    return { sessions: enriched };
  }

  /** 会话历史：durable 回合投影优先，缺省回落到转录文件 */
  private async handleSessionsHistory(params: SessionsHistoryParams): Promise<unknown> {
    const store = getSessionStore();
    const session = await store.get(params.sessionKey);
    if (!session) throw new Error(`Session not found: ${params.sessionKey}`);

    this.agent.openDurableSession(params.sessionKey);
    const recorded = this.agent.getSnapshot(params.sessionKey);
    const messages = await store.loadTranscript(session.sessionId);
    // 升级前的会话没有 durable 日志，用转录做只读展示回退
    const snapshot =
      recorded && recorded.turns.length > 0
        ? recorded
        : messages.length > 0
          ? snapshotFromTranscript(params.sessionKey, session.sessionId, messages)
          : recorded;

    return {
      sessionKey: params.sessionKey,
      sessionId: session.sessionId,
      snapshot,
      messages,
    };
  }

  private async handleSessionsDelete(params: SessionsDeleteParams): Promise<{ success: boolean }> {
    await getSessionStore().delete(params.sessionKey);
    return { success: true };
  }

  private async handleSessionsReset(params: SessionsResetParams): Promise<unknown> {
    const session = await getSessionStore().reset(params.sessionKey);
    return { success: true, sessionKey: session.sessionKey, sessionId: session.sessionId };
  }

  /** 恢复会话：返回快照，客户端据此重建整个对话 */
  private async handleSessionsRestore(client: WsClient, params: SessionsRestoreParams): Promise<unknown> {
    const store = getSessionStore();
    const session = await store.get(params.sessionKey);
    if (!session) throw new Error(`Session not found: ${params.sessionKey}`);

    client.sessionKey = session.sessionKey;
    client.sessionId = session.sessionId;

    this.agent.openDurableSession(session.sessionKey);
    const recorded = this.agent.getSnapshot(session.sessionKey);
    const messages = await store.loadTranscript(session.sessionId);
    const snapshot =
      recorded && recorded.turns.length > 0
        ? recorded
        : messages.length > 0
          ? snapshotFromTranscript(session.sessionKey, session.sessionId, messages)
          : recorded;

    // 模型上下文由 pi 的会话文件承担（createAgentSession 会自动恢复）。
    // 不要用转录重建：伪造的消息缺少 usage 等字段，会让 pi 的压缩检查抛错。
    return { sessionKey: session.sessionKey, sessionId: session.sessionId, snapshot, messages };
  }

  /** 订阅会话事件：立刻回一份快照，随后推送增量 */
  private handleSessionsSubscribe(client: WsClient, params: SessionsSubscribeParams): unknown {
    const results: Array<{ sessionKey: string; lastSeq: number }> = [];
    for (const sessionKey of params.sessionKeys ?? []) {
      this.agent.openDurableSession(sessionKey);
      client.subscribed.add(sessionKey);

      const snapshot = this.agent.getSnapshot(sessionKey);
      const lastSeq = snapshot?.seq ?? 0;
      results.push({ sessionKey, lastSeq });

      this.sendEvent(client.ws, "session.subscribed", { sessionKey, lastSeq });
      if (snapshot) this.sendEvent(client.ws, "session.snapshot", { sessionKey, snapshot });
    }
    return { subscriptions: results };
  }

  private handleSessionsUnsubscribe(client: WsClient, params: SessionsSubscribeParams): unknown {
    for (const sessionKey of params.sessionKeys ?? []) {
      client.subscribed.delete(sessionKey);
    }
    return { subscriptions: Array.from(client.subscribed) };
  }

  /** 把 durable 事件投递给订阅了该会话的客户端 */
  private broadcastSessionEvent(event: SequencedLiveEvent): void {
    // 瞬时事件（流式增量）复用当前序号，不能被"序号去重"挡掉
    if (!event.transient) {
      const previous = this.lastBroadcastSeq.get(event.sessionKey) ?? 0;
      if (event.seq > 0 && event.seq <= previous) return;
      if (event.seq > 0) this.lastBroadcastSeq.set(event.sessionKey, event.seq);
    }

    const frame: WsEventFrame = {
      type: "event",
      event: "session.event",
      payload: event,
    };
    const data = JSON.stringify(frame);

    for (const client of this.clients.values()) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      if (!client.subscribed.has(event.sessionKey) && client.sessionKey !== event.sessionKey) continue;
      client.ws.send(data);
    }

    // 回合边界额外广播运行状态
    if (event.type === "turn_start" || event.type === "turn_end") {
      this.broadcast("session.status", {
        sessionKey: event.sessionKey,
        running: event.type === "turn_start",
      });
    }
  }

  private getSystemStatus(): SystemStatus {
    const providers = getAllProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      available: true,
    }));
    const channels = getAllChannels().map((channel) => ({
      id: channel.id,
      name: channel.id,
      connected: true,
    }));

    return {
      version: "1.0.0",
      uptime: Date.now() - this.startTime,
      providers,
      channels,
      sessions: this.clients.size,
      durableDir: this.config.sessions?.directory ?? "~/.mozi/sessions",
    };
  }

  private getSessionInfo(client: WsClient): unknown {
    const context: InboundMessageContext = {
      channelId: "webchat",
      chatId: client.sessionKey || `webchat:${client.id}`,
      messageId: "",
      senderId: client.id,
      senderName: "",
      content: "",
      chatType: "direct",
      timestamp: Date.now(),
    };
    const info = this.agent.getSessionInfo(context);
    return { sessionKey: client.sessionKey, sessionId: client.sessionId, ...info };
  }

  private getConfigInfo(): ConfigInfo {
    return getConfigInfo(this.config);
  }

  private validateConfig(params: ConfigSaveParams): ConfigValidateResult {
    return validateConfig(params);
  }

  private async saveConfig(
    params: ConfigSaveParams
  ): Promise<{ success: boolean; message: string; requiresRestart?: boolean }> {
    const result = await saveConfig(params, this.config);
    if (!result.success) return result;

    // 保存后立即重载：否则界面刷新拿到的仍是旧配置（新加的提供商看不到）
    try {
      const fresh = loadConfig({ configPath: getActiveConfigPath() });
      this.config = fresh;
      initializeProviders(fresh);
      initModelResolver(fresh);

      // 模型变更立即生效，不需要重启：同步到运行时与已打开的会话
      this.agent.applyModelConfig({
        model: fresh.agent.defaultModel,
        provider: fresh.agent.defaultProvider,
        thinkingLevel: fresh.agent.thinkingLevel,
      });
    } catch (error) {
      logger.warn({ error }, "保存后重载配置失败，需要重启服务");
    }

    return result;
  }

  private sendResponse(
    ws: WebSocket,
    id: string,
    ok: boolean,
    payload?: unknown,
    error?: { code: string; message: string }
  ): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const frame: WsResponseFrame = { type: "res", id, ok, payload, error };
    ws.send(JSON.stringify(frame));
  }

  private sendEvent(ws: WebSocket, event: string, payload?: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const frame: WsEventFrame = { type: "event", event, payload };
    ws.send(JSON.stringify(frame));
  }

  /** 广播给所有客户端 */
  broadcast(event: string, payload?: unknown): void {
    const data = JSON.stringify({ type: "event", event, payload } satisfies WsEventFrame);
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) client.ws.send(data);
    }
  }

  private checkHeartbeat(): void {
    const now = Date.now();
    for (const [clientId, client] of this.clients) {
      if (now - client.lastPing > this.clientTimeout) {
        logger.info({ clientId }, "Client timeout, disconnecting");
        client.ws.terminate();
        this.clients.delete(clientId);
      } else {
        client.ws.ping();
      }
    }
  }

  close(): void {
    this.unsubscribeDurable?.();
    for (const client of this.clients.values()) client.ws.close();
    this.wss.close();
    logger.info("WebSocket server closed");
  }
}
