/**
 * Web 层测试
 *
 * 覆盖两处容易出错且用户可见的行为：
 * 1. 静态资源服务：模板占位替换、路径穿越拒绝、资源 MIME。
 * 2. 会话事件投影与 seq：客户端依赖它们做缺口检测。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { handleStaticRequest, UI_DIR } from "../src/web/static.js";
import { snapshotFromTranscript } from "../src/web/legacy-transcript.js";
import { DurableStore } from "../src/durable/store.js";
import type { ConfigInfo, ConfigSaveParams } from "../src/web/types.js";
import { validateConfig, getConfigInfo } from "../src/web/config-ops.js";
import type { MoziConfig } from "../src/types/index.js";

const baseConfig: MoziConfig = {
  providers: {},
  channels: {},
  agent: { defaultProvider: "deepseek", defaultModel: "deepseek-chat" },
  server: { port: 3000 },
  logging: { level: "info" },
};

/** 最小响应对象，记录写入的状态与 body */
function createResponse() {
  const response = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "" as string | Buffer,
    writeHead(code: number, headers?: Record<string, string>) {
      response.statusCode = code;
      Object.assign(response.headers, headers ?? {});
      return response;
    },
    end(chunk?: string | Buffer) {
      response.body = chunk ?? "";
      return response;
    },
  };
  return response;
}

function createRequest(url: string) {
  const request = new EventEmitter() as EventEmitter & { url: string; method: string };
  request.url = url;
  request.method = "GET";
  return request;
}

describe("web/static", () => {
  it("serves the chat page with placeholders substituted", () => {
    const req = createRequest("/");
    const res = createResponse();
    const handled = handleStaticRequest(req, res as never, { config: baseConfig });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const html = res.body.toString();
    expect(html).toContain("<!DOCTYPE html>");
    // 模板占位必须全部替换（__MOZI_MARK__ 是页面自己的全局变量名，不算占位）
    for (const token of ["__TITLE__", "__ASSISTANT_NAME__", "__MARK_SMALL__", "__MARK_HERO__", "__PROVIDER__", "__MODEL__"]) {
      expect(html, token).not.toContain(token);
    }
    expect(html).toContain("deepseek");
    expect(html).toContain("/assets/app.js");
  });

  it("serves stylesheets and scripts from the ui directory", () => {
    for (const name of ["tokens.css", "app.css", "app.js"]) {
      const res = createResponse();
      const handled = handleStaticRequest(createRequest(`/assets/${name}`) as never, res as never, {
        config: baseConfig,
      });
      expect(handled, name).toBe(true);
      expect(res.statusCode, name).toBe(200);
      expect(Number(res.headers["Content-Length"]), name).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(UI_DIR, name)), name).toBe(true);
    }
  });

  it("rejects path traversal in asset names", () => {
    for (const name of ["../../package.json", "..%2f..%2fpackage.json", "sub/dir.js"]) {
      const res = createResponse();
      const handled = handleStaticRequest(createRequest(`/assets/${name}`) as never, res as never, {
        config: baseConfig,
      });
      expect(handled).toBe(true);
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.body.toString()).not.toContain('"name": "mozi-bot"');
    }
  });

  it("returns 404 for an unknown asset but keeps the connection handled", () => {
    const res = createResponse();
    const handled = handleStaticRequest(createRequest("/assets/nope.css") as never, res as never, {
      config: baseConfig,
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
  });

  it("defers non-static paths to later middleware", () => {
    for (const url of ["/ws", "/health", "/api/session", "/feishu/webhook", "/wecom/webhook"]) {
      const res = createResponse();
      const handled = handleStaticRequest(createRequest(url) as never, res as never, { config: baseConfig });
      expect(handled, url).toBe(false);
    }
  });

  it("serves the settings page", () => {
    const res = createResponse();
    const handled = handleStaticRequest(createRequest("/control") as never, res as never, {
      config: baseConfig,
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);

    const html = res.body.toString();
    expect(html).toContain("设置");
    expect(html).toContain("/assets/settings.js");
    // 资源链接必须带版本号，避免升级后继续用旧脚本
    expect(html).toMatch(/settings\.js\?v=/);
  });
});

describe("web/session events", () => {
  let dir: string;
  let store: DurableStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-web-"));
    store = new DurableStore({ directory: dir, fsync: false });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("emits monotonic seq for durable and event-only writes", () => {
    store.open("webchat:a", "/tmp");
    const seqs: number[] = [];
    store.subscribe((event) => seqs.push(event.seq));

    // 落盘事件
    store.append(
      "webchat:a",
      [{ kind: "turn", turnId: "t1", requestId: "r1", content: "hi", source: "webchat" }],
      [{ type: "turn_start", turnId: "t1", requestId: "r1", createdAt: 1, resumed: false, content: "hi" }]
    );
    // 纯事件（不落盘）——seq 必须沿用当前日志序号，不能回落到 0
    store.append("webchat:a", [], [{ type: "step_start", turnId: "t1", stepId: "step-1" }]);
    store.append(
      "webchat:a",
      [{ kind: "turn-end", turnId: "t1", reason: "completed" }],
      [{ type: "turn_end", turnId: "t1", reason: "completed" }]
    );

    expect(seqs).toEqual([1, 1, 2]);
    for (let index = 1; index < seqs.length; index += 1) {
      expect(seqs[index]).toBeGreaterThanOrEqual(seqs[index - 1]!);
    }
  });

  it("tags every event with its session key", () => {
    store.open("webchat:a", "/tmp");
    const keys: string[] = [];
    store.subscribe((event) => keys.push(event.sessionKey));
    store.append(
      "webchat:a",
      [{ kind: "turn", turnId: "t1", requestId: "r1", content: "hi", source: "webchat" }],
      [{ type: "turn_start", turnId: "t1", requestId: "r1", createdAt: 1, resumed: false, content: "hi" }]
    );
    expect(keys).toEqual(["webchat:a"]);
  });

  it("exposes the snapshot the client uses to rehydrate", () => {
    store.open("webchat:a", "/tmp");
    store.append(
      "webchat:a",
      [
        { kind: "turn", turnId: "t1", requestId: "r1", content: "do it", source: "webchat" },
        { kind: "assistant", turnId: "t1", stepId: "step-1", text: "ok" },
        { kind: "turn-end", turnId: "t1", reason: "completed" },
      ],
      []
    );

    const snapshot = store.snapshot("webchat:a");
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]!.content).toBe("do it");
    expect(snapshot.turns[0]!.running).toBe(false);
    expect(snapshot.seq).toBe(snapshot.turns.length > 0 ? 3 : 0);
  });
});

describe("web/legacy transcript fallback", () => {
  it("projects transcript messages into display turns", () => {
    const snapshot = snapshotFromTranscript("webchat:old", "sid-1", [
      { role: "user", content: "第一个问题", timestamp: 1000 },
      { role: "assistant", content: "第一个回答", timestamp: 2000 },
      { role: "user", content: "第二个问题", timestamp: 3000 },
      { role: "assistant", content: "第二个回答", timestamp: 4000 },
    ]);

    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.turns[0]!.content).toBe("第一个问题");
    expect(snapshot.turns[0]!.steps[0]!.text).toBe("第一个回答");
    expect(snapshot.turns[1]!.content).toBe("第二个问题");
    expect(snapshot.turns[1]!.steps[0]!.text).toBe("第二个回答");
    expect(snapshot.turns.every((turn) => turn.reason === "completed")).toBe(true);
    expect(snapshot.running).toBe(false);
    expect(snapshot.seq).toBe(0);
  });

  it("keeps a trailing user message as a turn without assistant output", () => {
    const snapshot = snapshotFromTranscript("webchat:old", "sid-2", [
      { role: "user", content: "没有回答的问题", timestamp: 1000 },
    ]);

    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]!.content).toBe("没有回答的问题");
    expect(snapshot.turns[0]!.steps).toHaveLength(0);
  });

  it("returns an empty snapshot for an empty transcript", () => {
    const snapshot = snapshotFromTranscript("webchat:old", "sid-3", []);
    expect(snapshot.turns).toHaveLength(0);
  });
});

describe("web/config-ops", () => {
  it("masks secrets when reading config", () => {
    const config: MoziConfig = {
      ...baseConfig,
      providers: { deepseek: { apiKey: "secret-key", baseUrl: "https://api.deepseek.com" } },
      channels: {
        feishu: { appId: "cli_x", appSecret: "very-secret" },
        qq: { appId: "102000000", clientSecret: "qq-secret", sandbox: false },
        wecom: {
          corpId: "corp_x",
          corpSecret: "corp-secret-value",
          agentId: 100001,
          token: "wecom-token-value",
          encodingAESKey: "aes-key-value-0000000000000000000000000000000000000000000",
        },
      },
    };
    const info: ConfigInfo = getConfigInfo(config);

    expect(info.providers.deepseek?.hasApiKey).toBe(true);
    expect(info.providers.deepseek?.apiKey).toBeUndefined();
    expect(info.channels.feishu?.appId).toBe("cli_x");
    expect(info.channels.feishu?.hasAppSecret).toBe(true);
    expect(info.channels.qq?.hasClientSecret).toBe(true);
    // 企业微信的 Token / EncodingAESKey 同样是密钥
    expect(info.channels.wecom?.corpId).toBe("corp_x");
    expect(info.channels.wecom?.hasCorpSecret).toBe(true);
    expect(info.channels.wecom?.hasToken).toBe(true);
    expect(info.channels.wecom?.hasEncodingAESKey).toBe(true);

    const serialized = JSON.stringify(info);
    for (const secret of [
      "very-secret",
      "secret-key",
      "qq-secret",
      "corp-secret-value",
      "wecom-token-value",
      "aes-key-value",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("rejects an out-of-range port", () => {
    const result = validateConfig({ server: { port: 70000 } } as ConfigSaveParams);
    expect(result.valid).toBe(false);
    expect(result.errors.join()).toContain("端口");
  });

  it("rejects an unknown provider", () => {
    const result = validateConfig({ agent: { defaultProvider: "not-a-provider" } } as ConfigSaveParams);
    expect(result.valid).toBe(false);
  });

  it("warns when no api key is configured", () => {
    const result = validateConfig({ providers: { deepseek: { id: "deepseek", name: "DeepSeek", hasApiKey: false } } });
    expect(result.valid).toBe(true);
    expect(result.warnings.join()).toContain("API Key");
  });
});
