/**
 * 配置加载测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Mock logger
vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { loadConfig, validateRequiredConfig, MoziConfigSchema } from "../src/config/index.js";

describe("config", () => {
  let testDir: string;
  const originalEnv = process.env;

  beforeEach(() => {
    // 创建临时测试目录
    testDir = path.join(os.tmpdir(), `mozi-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });

    // 重置环境变量
    process.env = { ...originalEnv };
    // 清除所有 mozi 相关的环境变量
    Object.keys(process.env).forEach((key) => {
      if (
        key.includes("DEEPSEEK") ||
        key.includes("MINIMAX") ||
        key.includes("KIMI") ||
        key.includes("STEPFUN") ||
        key.includes("MODELSCOPE") ||
        key.includes("DASHSCOPE") ||
        key.includes("ZHIPU") ||
        key.includes("OPENAI") ||
        key.includes("OLLAMA") ||
        key.includes("OPENROUTER") ||
        key.includes("TOGETHER") ||
        key.includes("GROQ") ||
        key.includes("FEISHU") ||
        key.includes("DINGTALK") ||
        key.includes("QQ_") ||
        key.includes("WECOM") ||
        key === "PORT" ||
        key === "LOG_LEVEL"
      ) {
        delete process.env[key];
      }
    });
  });

  afterEach(() => {
    // 恢复环境变量
    process.env = originalEnv;

    // 清理测试目录
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("MoziConfigSchema", () => {
    it("should validate minimal config", () => {
      const result = MoziConfigSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("should provide default values", () => {
      const result = MoziConfigSchema.parse({});

      expect(result.providers).toEqual({});
      expect(result.channels).toEqual({});
      expect(result.agent).toBeDefined();
      expect(result.agent?.defaultModel).toBe("deepseek-chat");
      expect(result.agent?.defaultProvider).toBe("deepseek");
      expect(result.agent?.maxTokens).toBe(4096);
      expect(result.server?.port).toBe(3000);
      expect(result.server?.host).toBe("0.0.0.0");
      expect(result.logging?.level).toBe("info");
    });

    it("should validate provider config", () => {
      const result = MoziConfigSchema.safeParse({
        providers: {
          deepseek: {
            apiKey: "test-key",
            baseUrl: "https://api.deepseek.com",
          },
        },
      });

      expect(result.success).toBe(true);
    });

    it("should validate feishu channel config", () => {
      const result = MoziConfigSchema.safeParse({
        channels: {
          feishu: {
            appId: "app-id",
            appSecret: "app-secret",
            verificationToken: "token",
            encryptKey: "key",
          },
        },
      });

      expect(result.success).toBe(true);
    });

    it("should validate dingtalk channel config", () => {
      const result = MoziConfigSchema.safeParse({
        channels: {
          dingtalk: {
            appKey: "app-key",
            appSecret: "app-secret",
            robotCode: "robot-code",
          },
        },
      });

      expect(result.success).toBe(true);
    });

    it("should validate qq channel config", () => {
      const result = MoziConfigSchema.safeParse({
        channels: {
          qq: {
            appId: "app-id",
            clientSecret: "client-secret",
            sandbox: true,
          },
        },
      });

      expect(result.success).toBe(true);
    });

    it("should validate wecom channel config", () => {
      const result = MoziConfigSchema.safeParse({
        channels: {
          wecom: {
            corpId: "corp-id",
            corpSecret: "corp-secret",
            agentId: 1000001,
            token: "token",
            encodingAESKey: "key",
          },
        },
      });

      expect(result.success).toBe(true);
    });

    it("should validate agent config with valid provider", () => {
      const result = MoziConfigSchema.safeParse({
        agent: {
          defaultModel: "gpt-4",
          defaultProvider: "openai",
          maxTokens: 8192,
        },
      });

      expect(result.success).toBe(true);
    });

    it("should validate memory config", () => {
      const result = MoziConfigSchema.safeParse({
        memory: {
          enabled: true,
          directory: "/custom/memory",
          embeddingModel: "text-embedding-3-small",
          embeddingProvider: "openai",
        },
      });

      expect(result.success).toBe(true);
    });

    it("should validate skills config", () => {
      const result = MoziConfigSchema.safeParse({
        skills: {
          enabled: true,
          userDir: "/user/skills",
          workspaceDir: "/workspace/skills",
          disabled: ["skill-a"],
          only: ["skill-b", "skill-c"],
        },
      });

      expect(result.success).toBe(true);
    });

    it("should validate session store config", () => {
      const result = MoziConfigSchema.safeParse({
        sessions: {
          type: "file",
          directory: "/sessions",
          ttlMs: 3600000,
        },
      });

      expect(result.success).toBe(true);
    });
  });

  describe("loadConfig", () => {
    it("should load config from JSON file", () => {
      const configPath = path.join(testDir, "config.json");
      const configContent = JSON.stringify({
        providers: {
          deepseek: {
            apiKey: "file-key",
          },
        },
      });

      fs.writeFileSync(configPath, configContent);

      const config = loadConfig({ configPath });
      expect(config.providers.deepseek?.apiKey).toBe("file-key");
    });

    it("should load config from YAML file", () => {
      const configPath = path.join(testDir, "config.yaml");
      const configContent = `
providers:
  deepseek:
    apiKey: yaml-key
`;

      fs.writeFileSync(configPath, configContent);

      const config = loadConfig({ configPath });
      expect(config.providers.deepseek?.apiKey).toBe("yaml-key");
    });

    it("should load config from environment variables", () => {
      process.env.DEEPSEEK_API_KEY = "env-key";

      const config = loadConfig({ configPath: path.join(testDir, "nonexistent.json") });
      expect(config.providers.deepseek?.apiKey).toBe("env-key");
    });

    it("should prioritize environment variables over file", () => {
      const configPath = path.join(testDir, "config.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          providers: {
            deepseek: { apiKey: "file-key" },
          },
        })
      );

      process.env.DEEPSEEK_API_KEY = "env-key";

      const config = loadConfig({ configPath });
      expect(config.providers.deepseek?.apiKey).toBe("env-key");
    });

    it("should load multiple providers from env", () => {
      process.env.DEEPSEEK_API_KEY = "deepseek-key";
      process.env.KIMI_API_KEY = "kimi-key";
      process.env.ZHIPU_API_KEY = "zhipu-key";

      const config = loadConfig({ configPath: path.join(testDir, "none.json") });

      expect(config.providers.deepseek?.apiKey).toBe("deepseek-key");
      expect(config.providers.kimi?.apiKey).toBe("kimi-key");
      expect(config.providers.zhipu?.apiKey).toBe("zhipu-key");
    });

    it("should load feishu channel from env", () => {
      process.env.FEISHU_APP_ID = "feishu-app-id";
      process.env.FEISHU_APP_SECRET = "feishu-secret";
      process.env.FEISHU_VERIFICATION_TOKEN = "feishu-token";

      const config = loadConfig({ configPath: path.join(testDir, "none.json") });

      expect(config.channels.feishu?.appId).toBe("feishu-app-id");
      expect(config.channels.feishu?.appSecret).toBe("feishu-secret");
      expect(config.channels.feishu?.verificationToken).toBe("feishu-token");
    });

    it("should load dingtalk channel from env", () => {
      process.env.DINGTALK_APP_KEY = "dingtalk-key";
      process.env.DINGTALK_APP_SECRET = "dingtalk-secret";
      process.env.DINGTALK_ROBOT_CODE = "dingtalk-robot";

      const config = loadConfig({ configPath: path.join(testDir, "none.json") });

      expect(config.channels.dingtalk?.appKey).toBe("dingtalk-key");
      expect(config.channels.dingtalk?.appSecret).toBe("dingtalk-secret");
      expect(config.channels.dingtalk?.robotCode).toBe("dingtalk-robot");
    });

    it("should load qq channel from env", () => {
      process.env.QQ_APP_ID = "qq-app-id";
      process.env.QQ_CLIENT_SECRET = "qq-secret";
      process.env.QQ_SANDBOX = "true";

      const config = loadConfig({ configPath: path.join(testDir, "none.json") });

      expect(config.channels.qq?.appId).toBe("qq-app-id");
      expect(config.channels.qq?.clientSecret).toBe("qq-secret");
      expect(config.channels.qq?.sandbox).toBe(true);
    });

    it("should load server port from env", () => {
      process.env.PORT = "8080";

      const config = loadConfig({ configPath: path.join(testDir, "none.json") });
      expect(config.server?.port).toBe(8080);
    });

    it("should load log level from env", () => {
      process.env.LOG_LEVEL = "debug";

      const config = loadConfig({ configPath: path.join(testDir, "none.json") });
      expect(config.logging?.level).toBe("debug");
    });

    it("should return empty config when no file and no env", () => {
      const config = loadConfig({ configPath: path.join(testDir, "nonexistent.json") });

      expect(config.providers).toEqual({});
      expect(config.channels).toEqual({});
    });
  });

  describe("validateRequiredConfig", () => {
    it("should return error when no provider configured", () => {
      const config = MoziConfigSchema.parse({});
      const errors = validateRequiredConfig(config);

      expect(errors.some((e) => e.includes("提供商"))).toBe(true);
    });

    it("should not require a messaging channel", () => {
      // 通讯通道是可选的：Web 界面本身就是完整入口
      const config = MoziConfigSchema.parse({
        providers: {
          deepseek: { apiKey: "key" },
        },
      });
      const errors = validateRequiredConfig(config);

      expect(errors).toEqual([]);
    });

    it("should pass with valid config", () => {
      const config = MoziConfigSchema.parse({
        providers: {
          deepseek: { apiKey: "key" },
        },
        channels: {
          feishu: {
            appId: "id",
            appSecret: "secret",
          },
        },
      });
      const errors = validateRequiredConfig(config);

      expect(errors).toHaveLength(0);
    });
  });
});
