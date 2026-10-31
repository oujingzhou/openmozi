/**
 * 飞书 API 客户端
 */

import type { FeishuConfig } from "../../types/index.js";
import { getChildLogger } from "../../utils/logger.js";
import { ChannelHttpClient } from "../common/http.js";
import { TokenProvider } from "../common/token.js";

const logger = getChildLogger("feishu-api");

const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";

/** 飞书 API 响应基础结构 */
interface FeishuApiResponse<T = unknown> {
  code: number;
  msg: string;
  data?: T;
}

/** Tenant Access Token 响应 */
interface TenantAccessTokenResponse {
  tenant_access_token: string;
  expire: number;
}

/** 消息发送响应 */
interface SendMessageResponse {
  message_id: string;
}

/** 消息内容类型 */
type MessageContentType = "text" | "post" | "image" | "interactive";

/** 飞书 API 客户端 */
export class FeishuApiClient {
  private config: FeishuConfig;
  private http: ChannelHttpClient;
  private tokens: TokenProvider;

  constructor(config: FeishuConfig) {
    this.config = config;
    this.http = new ChannelHttpClient({ baseUrl: FEISHU_API_BASE });
    this.tokens = new TokenProvider({
      fetch: async () => {
        const data = await this.http.requestJson<TenantAccessTokenResponse>({
          method: "POST",
          path: "/auth/v3/tenant_access_token/internal",
          body: { app_id: this.config.appId, app_secret: this.config.appSecret },
        });
        if (!data.tenant_access_token) {
          throw new Error("No tenant access token in response");
        }
        return { token: data.tenant_access_token, expiresInSec: data.expire };
      },
    });
  }

  /** 获取 Tenant Access Token（并发共享同一次请求） */
  async getTenantAccessToken(): Promise<string> {
    return this.tokens.get();
  }

  /** 发送请求 */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.tokens.get();
    const data = await this.http.requestJson<FeishuApiResponse<T>>({
      method: method as "GET" | "POST",
      path,
      body,
      headers: { Authorization: `Bearer ${token}` },
    });

    if (data.code !== 0) {
      throw new Error(`Feishu API Error [${data.code}]: ${data.msg}`);
    }

    return data.data as T;
  }

  /** 发送消息 */
  async sendMessage(
    receiveId: string,
    receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id",
    msgType: MessageContentType,
    content: string
  ): Promise<string> {
    logger.debug({ receiveId, receiveIdType, msgType }, "Sending message");

    const data = await this.request<SendMessageResponse>(
      "POST",
      `/im/v1/messages?receive_id_type=${receiveIdType}`,
      {
        receive_id: receiveId,
        msg_type: msgType,
        content,
      }
    );

    return data.message_id;
  }

  /** 发送文本消息 */
  async sendText(chatId: string, text: string): Promise<string> {
    const content = JSON.stringify({ text });
    return this.sendMessage(chatId, "chat_id", "text", content);
  }

  /** 回复消息 */
  async replyMessage(
    messageId: string,
    msgType: MessageContentType,
    content: string
  ): Promise<string> {
    logger.debug({ messageId, msgType }, "Replying to message");

    const data = await this.request<SendMessageResponse>(
      "POST",
      `/im/v1/messages/${messageId}/reply`,
      {
        msg_type: msgType,
        content,
      }
    );

    return data.message_id;
  }

  /** 回复文本消息 */
  async replyText(messageId: string, text: string): Promise<string> {
    const content = JSON.stringify({ text });
    return this.replyMessage(messageId, "text", content);
  }

  /** 发送富文本消息 */
  async sendPost(chatId: string, title: string, content: unknown[][]): Promise<string> {
    const postContent = JSON.stringify({
      zh_cn: {
        title,
        content,
      },
    });
    return this.sendMessage(chatId, "chat_id", "post", postContent);
  }

  /** 发送卡片消息 */
  async sendCard(chatId: string, card: unknown): Promise<string> {
    const content = JSON.stringify(card);
    return this.sendMessage(chatId, "chat_id", "interactive", content);
  }

  /** 获取群信息 */
  async getChatInfo(chatId: string): Promise<unknown> {
    return this.request("GET", `/im/v1/chats/${chatId}`);
  }

  /** 获取用户信息 */
  async getUserInfo(userId: string, userIdType: "open_id" | "user_id" | "union_id" = "open_id"): Promise<unknown> {
    return this.request("GET", `/contact/v3/users/${userId}?user_id_type=${userIdType}`);
  }
}
