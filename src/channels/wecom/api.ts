/**
 * 企业微信 API 客户端
 * 基于企业微信服务端 API
 */

import { getChildLogger } from "../../utils/logger.js";
import type { WeComConfig } from "../../types/index.js";
import { ChannelHttpClient } from "../common/http.js";
import { TokenProvider } from "../common/token.js";

const logger = getChildLogger("wecom-api");

/** 企业微信 API 基础地址 */
const WECOM_API_BASE = "https://qyapi.weixin.qq.com/cgi-bin";

/** Access Token 缓存 */
interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

/** 发送消息响应 */
interface SendMessageResponse {
  errcode: number;
  errmsg: string;
  msgid?: string;
}

export class WeComApiClient {
  private config: WeComConfig;
  private http: ChannelHttpClient;
  private tokens: TokenProvider;

  constructor(config: WeComConfig) {
    this.config = config;
    this.http = new ChannelHttpClient({ baseUrl: WECOM_API_BASE });
    this.tokens = new TokenProvider({
      fetch: async () => {
        const data = await this.http.requestJson<{
          access_token?: string;
          expires_in?: number;
          errcode?: number;
          errmsg?: string;
        }>({
          path: "/gettoken",
          query: { corpid: this.config.corpId, corpsecret: this.config.corpSecret },
        });

        if (data.errcode && data.errcode !== 0) {
          throw new Error(`WeCom API error: ${data.errcode} - ${data.errmsg}`);
        }
        if (!data.access_token) throw new Error("WeCom returned no access_token");

        return { token: data.access_token, expiresInSec: data.expires_in };
      },
    });
  }

  /** 获取 Access Token（并发共享同一次请求） */
  async getAccessToken(): Promise<string> {
    return this.tokens.get();
  }

  /** 发送应用消息 (文本) */
  async sendTextMessage(
    userId: string,
    content: string
  ): Promise<SendMessageResponse> {
    const response = await this.http.requestJson<SendMessageResponse>({
      method: "POST",
      path: "/message/send",
      query: { access_token: await this.tokens.get() },
      body: {
        touser: userId,
        msgtype: "text",
        agentid: this.config.agentId,
        text: { content },
      },
    });

    if (response.errcode !== 0) {
      throw new Error(`WeCom send error: ${response.errcode} - ${response.errmsg}`);
    }

    logger.debug({ userId, msgid: response.msgid }, "Text message sent");
    return response;
  }

  /** 发送群聊消息 */
  async sendGroupTextMessage(
    chatId: string,
    content: string
  ): Promise<SendMessageResponse> {
    const response = await this.http.requestJson<SendMessageResponse>({
      method: "POST",
      path: "/appchat/send",
      query: { access_token: await this.tokens.get() },
      body: { chatid: chatId, msgtype: "text", text: { content } },
    });

    if (response.errcode !== 0) {
      throw new Error(`WeCom group send error: ${response.errcode} - ${response.errmsg}`);
    }

    logger.debug({ chatId }, "Group text message sent");
    return response;
  }

  /** 获取用户信息 */
  async getUserInfo(userId: string): Promise<{ name: string; userid: string }> {
    const response = await this.http.requestJson<{ errcode: number; errmsg: string; name: string; userid: string }>({
      path: "/user/get",
      query: { access_token: await this.tokens.get(), userid: userId },
    });

    if (response.errcode !== 0) {
      throw new Error(`WeCom get user error: ${response.errcode} - ${response.errmsg}`);
    }

    return response;
  }
}
