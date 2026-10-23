/**
 * 配置加载：$ENV 展开
 *
 * 与 pi 的约定一致：配置文件里可以写 "$MOZI_TEST_TOKEN"，
 * 加载时替换为环境变量值。未定义的变量必须原样保留，
 * 否则密钥会被静默替换成空字符串，问题极难排查。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { loadConfig } from "../src/config/index.js";

describe("config env expansion", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-config-"));
    configPath = path.join(dir, "config.local.json5");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.MOZI_TEST_TOKEN;
  });

  it("expands $VAR in provider api keys and headers", () => {
    process.env.MOZI_TEST_TOKEN = "secret-value";
    fs.writeFileSync(
      configPath,
      `{
        providers: {
          "custom-openai": {
            baseUrl: "https://example.com/v1",
            apiKey: "$MOZI_TEST_TOKEN",
            headers: { "X-Auth-Token": "$MOZI_TEST_TOKEN" },
            models: [{ id: "m1", name: "M1", contextWindow: 1000, maxTokens: 100 }]
          }
        },
        channels: {},
        agent: { defaultProvider: "custom-openai", defaultModel: "m1" }
      }`,
      "utf-8"
    );

    const config = loadConfig({ configPath });
    const provider = config.providers["custom-openai"] as Record<string, unknown>;

    expect(provider.apiKey).toBe("secret-value");
    expect((provider.headers as Record<string, string>)["X-Auth-Token"]).toBe("secret-value");
  });

  it("supports braces form ${VAR}", () => {
    process.env.MOZI_TEST_TOKEN = "braced";
    fs.writeFileSync(
      configPath,
      `{
        providers: { "custom-openai": { apiKey: "\${MOZI_TEST_TOKEN}", models: [] } },
        channels: {},
        agent: { defaultProvider: "custom-openai", defaultModel: "m" }
      }`,
      "utf-8"
    );

    const config = loadConfig({ configPath });
    expect((config.providers["custom-openai"] as Record<string, unknown>).apiKey).toBe("braced");
  });

  it("leaves undefined variables untouched", () => {
    delete process.env.MOZI_TEST_TOKEN;
    fs.writeFileSync(
      configPath,
      `{
        providers: { "custom-openai": { apiKey: "$MOZI_TEST_TOKEN", models: [] } },
        channels: {},
        agent: { defaultProvider: "custom-openai", defaultModel: "m" }
      }`,
      "utf-8"
    );

    const config = loadConfig({ configPath });
    expect((config.providers["custom-openai"] as Record<string, unknown>).apiKey).toBe("$MOZI_TEST_TOKEN");
  });

  it("expands variables inside arrays of models", () => {
    process.env.MOZI_TEST_TOKEN = "in-array";
    fs.writeFileSync(
      configPath,
      `{
        providers: { "custom-openai": {
          apiKey: "k",
          models: [{ id: "m1", name: "$MOZI_TEST_TOKEN", contextWindow: 1000, maxTokens: 100 }]
        }},
        channels: {},
        agent: { defaultProvider: "custom-openai", defaultModel: "m1" }
      }`,
      "utf-8"
    );

    const config = loadConfig({ configPath });
    const models = (config.providers["custom-openai"] as Record<string, unknown>).models as Array<{ name: string }>;
    expect(models[0]!.name).toBe("in-array");
  });

  it("defaults thinking level to undefined so providers decide", () => {
    fs.writeFileSync(
      configPath,
      `{
        providers: { "custom-openai": { apiKey: "k", models: [] } },
        channels: {},
        agent: { defaultProvider: "custom-openai", defaultModel: "m" }
      }`,
      "utf-8"
    );

    const config = loadConfig({ configPath });
    expect(config.agent.thinkingLevel).toBeUndefined();
  });

  it("accepts an explicit thinking level", () => {
    fs.writeFileSync(
      configPath,
      `{
        providers: { "custom-openai": { apiKey: "k", models: [] } },
        channels: {},
        agent: { defaultProvider: "custom-openai", defaultModel: "m", thinkingLevel: "high" }
      }`,
      "utf-8"
    );

    const config = loadConfig({ configPath });
    expect(config.agent.thinkingLevel).toBe("high");
  });

  it("rejects an invalid thinking level", () => {
    fs.writeFileSync(
      configPath,
      `{
        providers: { "custom-openai": { apiKey: "k", models: [] } },
        channels: {},
        agent: { defaultProvider: "custom-openai", defaultModel: "m", thinkingLevel: "extreme" }
      }`,
      "utf-8"
    );

    expect(() => loadConfig({ configPath })).toThrow(/Invalid configuration/);
  });
});
