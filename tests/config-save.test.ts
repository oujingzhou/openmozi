/**
 * 配置保存的回归测试
 *
 * 这里锁死三条曾导致真实数据丢失的行为：
 * 1. 保存不会把未在界面上暴露的提供商字段（models / headers / compat）冲掉
 * 2. 表单没填模型时不会写入空字符串（否则下次启动解析不到模型）
 * 3. 保存写回实际加载的那个配置文件，而不是固定的默认路径
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { loadConfig, validateRequiredConfig, getActiveConfigPath } from "../src/config/index.js";
import { saveConfig, getConfigInfo } from "../src/web/config-ops.js";
import type { ConfigSaveParams } from "../src/web/types.js";

const BASE_CONFIG = `{
  providers: {
    "custom-openai": {
      baseUrl: "https://example.com/v1",
      apiKey: "sk-test",
      headers: { "X-Custom": "1" },
      models: [{
        id: "model-a",
        name: "Model A",
        contextWindow: 128000,
        maxTokens: 8192,
        compat: { reasoningEffortMap: { medium: "high" } }
      }]
    }
  },
  channels: {
    feishu: { appId: "cli_x", appSecret: "secret", enabled: true }
  },
  agent: { defaultProvider: "custom-openai", defaultModel: "model-a" },
  server: { port: 3000 },
  logging: { level: "info" }
}`;

describe("config persistence", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-save-"));
    configPath = path.join(dir, "config.local.json5");
    fs.writeFileSync(configPath, BASE_CONFIG, "utf-8");
    process.env.MOZI_CONFIG = configPath;
  });

  afterEach(() => {
    delete process.env.MOZI_CONFIG;
    fs.rmSync(dir, { recursive: true, force: true });
  });

describe("config save", () => {

  it("writes back to the file it loaded from", async () => {
    const config = loadConfig();
    expect(getActiveConfigPath()).toBe(configPath);

    const result = await saveConfig({ memory: { enabled: false } } as ConfigSaveParams, config);
    expect(result.success).toBe(true);
    expect(fs.existsSync(configPath)).toBe(true);

    const saved = fs.readFileSync(configPath, "utf-8");
    expect(saved).toContain("memory");
  });

  it("preserves provider fields the UI does not expose", async () => {
    const config = loadConfig();
    const before = (config.providers["custom-openai"] as Record<string, unknown>).models as Array<
      Record<string, unknown>
    >;
    expect(before[0]!.compat).toBeDefined();

    await saveConfig(
      {
        providers: {
          "custom-openai": {
            id: "custom-openai",
            name: "Renamed",
            baseUrl: "https://example.com/v1",
            hasApiKey: true,
          },
        },
      } as ConfigSaveParams,
      config
    );

    const after = loadConfig();
    const provider = after.providers["custom-openai"] as Record<string, unknown>;
    const models = provider.models as Array<Record<string, unknown>>;

    expect(models[0]!.compat).toEqual({ reasoningEffortMap: { medium: "high" } });
    expect(provider.headers).toEqual({ "X-Custom": "1" });
    expect(provider.name).toBe("Renamed");
  });

  it("does not overwrite the model with an empty string", async () => {
    const config = loadConfig();
    await saveConfig({ agent: { defaultModel: "" } } as ConfigSaveParams, config);

    const after = loadConfig();
    expect(after.agent.defaultModel).toBe("model-a");
  });

  it("keeps channels that were not part of the request", async () => {
    const config = loadConfig();
    await saveConfig({ agent: { maxTokens: 4096 } } as ConfigSaveParams, config);

    const after = loadConfig();
    expect(after.channels.feishu?.appId).toBe("cli_x");
  });

  it("deletes a provider only when it is explicitly marked", async () => {
    const config = loadConfig();
    await saveConfig(
      { providers: { "custom-openai": { id: "custom-openai", name: "x", hasApiKey: false } } } as ConfigSaveParams,
      config
    );

    const after = loadConfig();
    expect(after.providers["custom-openai"]).toBeUndefined();
  });
});

describe("config info", () => {
  it("masks secrets but exposes provider models", () => {
    const config = loadConfig();
    const info = getConfigInfo(config);
    const provider = info.providers["custom-openai"];

    expect(provider?.hasApiKey).toBe(true);
    expect((provider as Record<string, unknown>).apiKey).toBeUndefined();
    expect(provider?.models?.[0]?.id).toBe("model-a");
    expect(JSON.stringify(info)).not.toContain("sk-test");
  });

  it("ignores undefined channel slots produced by the schema defaults", () => {
    // zod 的默认值会让 qq / wecom 以 undefined 出现，读取时不能抛错
    const config = loadConfig();
    expect(Object.prototype.hasOwnProperty.call(config.channels, "qq")).toBe(true);
    expect(() => getConfigInfo(config)).not.toThrow();
  });
});

describe("config validation", () => {
  it("does not require a messaging channel", () => {
    const config = loadConfig();
    const errors = validateRequiredConfig(config);
    expect(errors).toEqual([]);
  });

  it("still requires a provider", () => {
    const config = loadConfig();
    const errors = validateRequiredConfig({ ...config, providers: {} });
    expect(errors.join()).toContain("模型提供商");
  });
});
});
