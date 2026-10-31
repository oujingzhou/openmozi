/**
 * 钉钉 API 客户端
 */

import type { DingtalkConfig } from "../../types/index.js";
import { getChildLogger } from "../../utils/logger.js";
import { computeHmacSha256 } from "../../utils/index.js";
import { ChannelHttpClient } from "../common/http.js";
import { TokenProvider } from "../common/token.js";

const logger = getChildLogger("dingtalk-api");

const DINGTALK_API_BASE = "https://api.dingtalk.com";
const DINGTALK_OLD_API_BASE = "https://oapi.dingtalk.com";

/** 钉钉 API 响应基础结构 */
interface DingtalkApiResponse<T = unknown> {
  errcode?: number;
  errmsg?: string;
  success?: boolean;
  result?: T;
  access_token?: string;
  expires_in?: number;
}

/** 消息发送响应 */
interface SendMessageResponse {
  processQueryKey?: string;
  invalidUserId?: string[];
  flowControlledUserId?: string[];
}

/** 钉钉 API 客户端 */
export class DingtalkApiClient {
  private config: DingtalkConfig;
  private http: ChannelHttpClient;
  private oldHttp: ChannelHttpClient;
  private tokens: TokenProvider;

  constructor(config: DingtalkConfig) {
    this.config = config;
    this.http = new ChannelHttpClient({ baseUrl: DINGTALK_API_BASE });
    this.oldHttp = new ChannelHttpClient({ baseUrl: DINGTALK_OLD_API_BASE });
    this.tokens = new TokenProvider({
      fetch: async () => {
        const data = await this.oldHttp.requestJson<DingtalkApiResponse>({
          path: "/gettoken",
          query: { appkey: this.config.appKey, appsecret: this.config.appSecret },
        });
        if (data.errcode !== 0) {
          throw new Error(`DingTalk API Error [${data.errcode}]: ${data.errmsg}`);
        }
        if (!data.access_token) {
          throw new Error("No access token in response");
        }
        return { token: data.access_token, expiresInSec: data.expires_in };
      },
    });
  }

  /** 获取 Access Token（并发共享同一次请求） */
  async getAccessToken(): Promise<string> {
    return this.tokens.get();
  }

  /** 发送请求（新版 API 走 header 鉴权，旧版走 query） */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    useOldApi = false
  ): Promise<T> {
    const token = await this.tokens.get();

    const data = useOldApi
      ? await this.oldHttp.requestJson<DingtalkApiResponse<T>>({
          method: method as "GET" | "POST",
          path,
          query: { access_token: token },
          body,
        })
      : await this.http.requestJson<DingtalkApiResponse<T>>({
          method: method as "GET" | "POST",
          path,
          body,
          headers: { "x-acs-dingtalk-access-token": token },
        });

    if (useOldApi && data.errcode !== undefined && data.errcode !== 0) {
      throw new Error(`DingTalk API Error [${data.errcode}]: ${data.errmsg}`);
    }
    if (!useOldApi && data.success === false) {
      throw new Error(`DingTalk API Error: ${data.errmsg || "Unknown error"}`);
    }

    return (data.result ?? data) as T;
  }

  /** 发送工作通知消息 */
  async sendWorkNotification(
    userId: string,
    content: unknown
  ): Promise<void> {
    logger.debug({ userId }, "Sending work notification");

    await this.request(
      "POST",
      "/topapi/message/corpconversation/asyncsend_v2",
      {
        agent_id: this.config.robotCode,
        userid_list: userId,
        msg: content,
      },
      true
    );
  }

  /** 机器人发送单聊消息 */
  async sendRobotMessage(
    userId: string,
    content: string
  ): Promise<void> {
    logger.debug({ userId }, "Sending robot message");

    await this.request(
      "POST",
      `/v1.0/robot/oToMessages/batchSend`,
      {
        robotCode: this.config.robotCode,
        userIds: [userId],
        msgKey: "sampleText",
        msgParam: JSON.stringify({ content }),
      }
    );
  }

  /** 机器人发送群消息 */
  async sendGroupMessage(
    openConversationId: string,
    content: string
  ): Promise<void> {
    logger.debug({ openConversationId }, "Sending group message");

    await this.request(
      "POST",
      `/v1.0/robot/groupMessages/send`,
      {
        robotCode: this.config.robotCode,
        openConversationId,
        msgKey: "sampleText",
        msgParam: JSON.stringify({ content }),
      }
    );
  }

  /** 回复 Webhook 消息 */
  async replyWebhookMessage(
    sessionWebhook: string,
    content: string
  ): Promise<void> {
    logger.debug({ sessionWebhook }, "Replying via webhook");

    await this.http.postAbsolute(sessionWebhook, {
      msgtype: "text",
      text: { content },
    });
  }

  /** 发送 Markdown 消息 */
  async sendMarkdownMessage(
    sessionWebhook: string,
    title: string,
    text: string
  ): Promise<void> {
    await this.http.postAbsolute(sessionWebhook, {
      msgtype: "markdown",
      markdown: { title, text },
    });
  }

  /** 获取用户信息 */
  async getUserInfo(userId: string): Promise<unknown> {
    return this.request(
      "POST",
      "/topapi/v2/user/get",
      { userid: userId },
      true
    );
  }

  /** 获取群信息 */
  async getChatInfo(openConversationId: string): Promise<unknown> {
    return this.request(
      "GET",
      `/v1.0/im/conversations/${openConversationId}`
    );
  }
}

/** 验证钉钉回调签名 */
export function verifyDingtalkSignature(
  timestamp: string,
  sign: string,
  appSecret: string
): boolean {
  const stringToSign = timestamp + "\n" + appSecret;
  const expectedSign = computeHmacSha256(appSecret, stringToSign);
  return sign === expectedSign;
}
