/**
 * QQ 机器人 API 客户端
 * 基于 QQ 官方机器人 API v2
 */

import { getChildLogger } from "../../utils/logger.js";
import type { QQConfig } from "../../types/index.js";
import { ChannelHttpClient } from "../common/http.js";
import { TokenProvider } from "../common/token.js";

const logger = getChildLogger("qq-api");

/** QQ API 基础地址 */
const QQ_API_BASE = "https://api.sgroup.qq.com";
const QQ_SANDBOX_API_BASE = "https://sandbox.api.sgroup.qq.com";

/** Token 获取地址 */
const QQ_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

/** 发送消息响应 */
interface SendMessageResponse {
  id: string;
  timestamp: number;
}

export class QQApiClient {
  private config: QQConfig;
  private http: ChannelHttpClient;
  private tokens: TokenProvider;

  constructor(config: QQConfig) {
    this.config = config;
    this.http = new ChannelHttpClient({
      baseUrl: config.sandbox ? QQ_SANDBOX_API_BASE : QQ_API_BASE,
    });
    this.tokens = new TokenProvider({
      fetch: async () => {
        const data = await this.http.requestJson<{ access_token: string; expires_in: number }>({
          method: "POST",
          path: QQ_TOKEN_URL,
          body: { appId: this.config.appId, clientSecret: this.config.clientSecret },
        });
        return { token: data.access_token, expiresInSec: data.expires_in };
      },
    });
  }

  /** 获取 Access Token（并发共享同一次请求） */
  async getAccessToken(): Promise<string> {
    return this.tokens.get();
  }

  /** 带鉴权的请求头 */
  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.tokens.get();
    return { Authorization: `QQBot ${token}`, "X-Union-Appid": this.config.appId };
  }

  /** 获取 WebSocket 网关地址 */
  async getGatewayUrl(): Promise<string> {
    const headers = await this.authHeaders();
    try {
      const data = await this.http.requestJson<{ url: string }>({ path: "/gateway", headers });
      return data.url;
    } catch {
      const data = await this.http.requestJson<{ url: string }>({ path: "/gateway/bot", headers });
      return data.url;
    }
  }

  /** 发送私聊消息 */
  async sendDirectMessage(
    openId: string,
    content: string,
    msgId?: string
  ): Promise<SendMessageResponse> {
    const headers = await this.authHeaders();
    const data: Record<string, unknown> = { content, msg_type: 0 };
    if (msgId) data.msg_id = msgId;

    const response = await this.http.requestJson<SendMessageResponse>({
      method: "POST",
      path: `/v2/users/${openId}/messages`,
      body: data,
      headers,
    });

    logger.debug({ openId, messageId: response.id }, "Direct message sent");
    return response;
  }

  /** 发送群聊消息 */
  async sendGroupMessage(
    groupOpenId: string,
    content: string,
    msgId?: string
  ): Promise<SendMessageResponse> {
    const headers = await this.authHeaders();
    const data: Record<string, unknown> = { content, msg_type: 0 };
    if (msgId) data.msg_id = msgId;

    const response = await this.http.requestJson<SendMessageResponse>({
      method: "POST",
      path: `/v2/groups/${groupOpenId}/messages`,
      body: data,
      headers,
    });

    logger.debug({ groupOpenId, messageId: response.id }, "Group message sent");
    return response;
  }

  /** 发送频道消息 */
  async sendChannelMessage(
    channelId: string,
    content: string,
    msgId?: string
  ): Promise<SendMessageResponse> {
    const headers = await this.authHeaders();
    const data: Record<string, unknown> = { content, msg_type: 0 };
    if (msgId) data.msg_id = msgId;

    const response = await this.http.requestJson<SendMessageResponse>({
      method: "POST",
      path: `/channels/${channelId}/messages`,
      body: data,
      headers,
    });

    logger.debug({ channelId, messageId: response.id }, "Channel message sent");
    return response;
  }

  /** 发送频道私信 */
  async sendDMMessage(
    guildId: string,
    content: string,
    msgId?: string
  ): Promise<SendMessageResponse> {
    const headers = await this.authHeaders();
    const data: Record<string, unknown> = { content, msg_type: 0 };
    if (msgId) data.msg_id = msgId;

    const response = await this.http.requestJson<SendMessageResponse>({
      method: "POST",
      path: `/dms/${guildId}/messages`,
      body: data,
      headers,
    });

    logger.debug({ guildId, messageId: response.id }, "DM message sent");
    return response;
  }

  /** 获取用户信息 */
  async getUserInfo(openId: string): Promise<{ id: string; username: string }> {
    const headers = await this.authHeaders();
    return this.http.requestJson<{ id: string; username: string }>({
      path: `/users/${openId}`,
      headers,
    });
  }
}
