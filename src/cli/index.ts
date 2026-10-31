#!/usr/bin/env node

/**
 * Mozi CLI - 命令行界面
 */

import { Command } from "commander";
import { loadConfig, validateRequiredConfig } from "../config/index.js";
import { startGateway } from "../gateway/server.js";
import { initializeProviders, getAllModels } from "../providers/index.js";
import { createLogger, setLogger, getLogDir, getLogFile } from "../utils/logger.js";
import dotenv from "dotenv";
import { spawn } from "child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { serializeJson5 } from "../storage/index.js";
import { CHINA_PROVIDER_IDS } from "../types/index.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// 加载环境变量
dotenv.config();

// 从 package.json 读取版本号
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(__dirname, "..", "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

const program = new Command();

program
  .name("mozi")
  .description("Mozi - 支持国产模型和国产通讯软件的智能助手机器人")
  .version(packageJson.version)
  .option("-m, --model <model>", "本次使用的模型")
  .option("-p, --provider <provider>", "本次使用的提供商")
  .action(async (options) => {
    // 无子命令 = 进入终端界面
    try {
      const config = loadConfig();
      if (options.model) config.agent.defaultModel = options.model;
      if (options.provider) config.agent.defaultProvider = options.provider;

      const errors = validateRequiredConfig(config);
      if (errors.length > 0) {
        console.error("❌ 配置错误:");
        errors.forEach((err) => console.error(`   - ${err}`));
        process.exit(1);
      }

      const { startTui } = await import("../tui/index.js");
      await startTui(config);
    } catch (error) {
      console.error("❌ 启动失败:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

/** 用系统默认浏览器打开地址；失败时只保留控制台里的链接 */
function openInBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {
      // 无图形环境时静默忽略
    });
    child.unref();
  } catch {
    // 打不开就只打印地址
  }
}

/** 启动 Gateway（`mozi web` 与 `mozi start` 共用） */
async function runServer(options: {
  config?: string;
  port?: string;
  webOnly?: boolean;
  open?: boolean;
}): Promise<void> {
  try {
    const config = loadConfig({ configPath: options.config });

    if (options.port) {
      config.server.port = parseInt(options.port, 10);
    }

    const errors = validateRequiredConfig(config);
    if (errors.length > 0) {
      console.error("❌ 配置错误:");
      errors.forEach((err) => console.error(`   - ${err}`));
      process.exit(1);
    }

    const port = config.server.port;
    const url = `http://localhost:${port}/`;
    console.log(`\n🌐 Web 界面: ${url}`);
    console.log(`⚙️  设置:     ${url}control\n`);

    // --web-only 只是不初始化通道；配置本身保持原样，避免被控制台保存覆盖
    await startGateway(config, { enableChannels: !options.webOnly });

    // 服务已开始监听，再打开浏览器
    const shouldOpen = options.open !== false && !process.env.MOZI_NO_OPEN;
    if (shouldOpen) openInBrowser(url);
  } catch (error) {
    console.error("❌ 启动失败:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/** Web 模式 */
program
  .command("web")
  .description("启动 Web 服务（WebChat 界面 + 控制台）")
  .option("-c, --config <path>", "配置文件路径")
  .option("-p, --port <port>", "服务器端口")
  .option("--web-only", "不启动飞书/钉钉/QQ 等通讯通道")
  .option("--no-open", "启动后不自动打开浏览器")
  .action(runServer);

// 容器部署使用 `start`，与 `web` 行为一致
program
  .command("start")
  .description("启动 Gateway 服务器（等同 mozi web）")
  .option("-c, --config <path>", "配置文件路径")
  .option("-p, --port <port>", "服务器端口")
  .option("--web-only", "仅启用 WebChat (不需要配置飞书/钉钉/QQ)")
  .option("--no-open", "启动后不自动打开浏览器")
  .action(runServer);

// 模型列表命令
program
  .command("models")
  .description("列出可用的模型")
  .action(async () => {
    try {
      const config = loadConfig();
      setLogger(createLogger({ level: "error" })); // 静默日志
      initializeProviders(config);

      const models = getAllModels();

      if (models.length === 0) {
        console.log("没有配置任何模型提供商。请检查 API Key 配置。");
        return;
      }

      console.log("\n可用模型:\n");

      // 按提供商分组
      const byProvider = new Map<string, typeof models>();
      for (const item of models) {
        const list = byProvider.get(item.provider) || [];
        list.push(item);
        byProvider.set(item.provider, list);
      }

      for (const [provider, list] of byProvider) {
        console.log(`📦 ${provider.toUpperCase()}`);
        for (const item of list) {
          const vision = item.model.supportsVision ? " 👁️" : "";
          const reasoning = item.model.supportsReasoning ? " 🧠" : "";
          console.log(`   - ${item.model.id} (${item.model.name})${vision}${reasoning}`);
        }
        console.log("");
      }
    } catch (error) {
      console.error("错误:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// 配置检查命令
program
  .command("check")
  .description("检查配置")
  .option("-c, --config <path>", "配置文件路径")
  .action(async (options) => {
    try {
      console.log("正在检查配置...\n");

      const config = loadConfig({ configPath: options.config });

      // 检查提供商
      console.log("📦 模型提供商:");
      const chinaProviders = CHINA_PROVIDER_IDS;
      for (const id of chinaProviders) {
        const providerConfig = config.providers[id];
        const status = providerConfig?.apiKey ? "✅ 已配置" : "⬜ 未配置";
        console.log(`   ${id}: ${status}`);
      }

      // 检查自定义和海外提供商
      const extraProviders = ["openai", "openrouter", "together", "groq", "ollama", "vllm"] as const;
      for (const id of extraProviders) {
        const providerConfig = config.providers[id];
        if (providerConfig) {
          const status = (providerConfig as any).apiKey || id === "ollama" || id === "vllm" ? "✅ 已配置" : "⬜ 未配置";
          console.log(`   ${id}: ${status}`);
        }
      }
      if (config.providers["custom-openai"]) {
        const c = config.providers["custom-openai"] as Record<string, unknown>;
        const modelCount = Array.isArray(c.models) ? c.models.length : 0;
        console.log(`   custom-openai: ✅ 已配置 (${c.baseUrl}, ${modelCount} 个模型)`);
      }
      if (config.providers["custom-anthropic"]) {
        const c = config.providers["custom-anthropic"] as Record<string, unknown>;
        const modelCount = Array.isArray(c.models) ? c.models.length : 0;
        console.log(`   custom-anthropic: ✅ 已配置 (${c.baseUrl}, ${modelCount} 个模型)`);
      }

      // 检查通道
      console.log("\n📱 通讯通道:");
      const channels = [
        { id: "feishu", name: "飞书", config: config.channels.feishu },
        { id: "dingtalk", name: "钉钉", config: config.channels.dingtalk },
        { id: "qq", name: "QQ", config: config.channels.qq },
      ];
      for (const channel of channels) {
        const status = channel.config ? "✅ 已配置" : "⬜ 未配置";
        console.log(`   ${channel.name}: ${status}`);
      }

      // 检查 Agent
      console.log("\n🤖 Agent 配置:");
      console.log(`   默认模型: ${config.agent.defaultModel}`);
      console.log(`   默认提供商: ${config.agent.defaultProvider}`);
      console.log(`   最大 Token: ${config.agent.maxTokens}`);

      // 检查服务器
      console.log("\n🌐 服务器配置:");
      console.log(`   端口: ${config.server.port}`);
      console.log(`   主机: ${config.server.host || "0.0.0.0"}`);

      // 验证
      const errors = validateRequiredConfig(config);
      if (errors.length > 0) {
        console.log("\n⚠️ 配置问题:");
        errors.forEach((err) => console.log(`   - ${err}`));
      } else {
        console.log("\n✅ 配置检查通过!");
      }
    } catch (error) {
      console.error("❌ 配置错误:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("onboard")
  .description("配置引导向导（模型/平台/服务器/Agent/记忆系统）")
  .action(async () => {
    const readline = await import("readline");
    const fs = await import("fs");
    const path = await import("path");
    const os = await import("os");

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const question = (prompt: string): Promise<string> => {
      return new Promise((resolve) => {
        rl.question(prompt, resolve);
      });
    };

    console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🐕 欢迎使用 Mozi (墨子) 配置向导                          ║
║                                                            ║
║   支持国产模型和国产通讯软件的智能助手                       ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
`);

    // 配置对象（用于 config.local.json5）
    const config: {
      providers: Record<string, unknown>;
      channels: Record<string, unknown>;
      agent: Record<string, unknown>;
      server: Record<string, unknown>;
      memory: Record<string, unknown>;
    } = {
      providers: {},
      channels: {},
      agent: {},
      server: {},
      memory: {},
    };

    let defaultProvider = "";
    let defaultModel = "";

    // 步骤 1: 选择配置模式
    console.log("\n📦 步骤 1/5: 选择提供商类型\n");
    console.log("  1. 国产模型 (DeepSeek, 智谱AI, DashScope, Kimi, 阶跃星辰, MiniMax, ModelScope)");
    console.log("  2. 自定义 OpenAI 兼容接口 (支持任意 OpenAI API 格式的服务)");
    console.log("  3. 自定义 Anthropic 兼容接口 (支持任意 Claude API 格式的服务)");
    console.log("");

    const providerType = await question("请选择 (1/2/3，可多选用逗号分隔，如 1,2): ");
    const selectedTypes = providerType.split(",").map((s) => s.trim());

    // 国产模型配置
    if (selectedTypes.includes("1")) {
      console.log("\n--- 国产模型配置 ---\n");
      console.log("(至少配置一个，直接回车跳过)\n");

      const deepseekKey = await question("DeepSeek API Key: ");
      if (deepseekKey.trim()) {
        config.providers["deepseek"] = { apiKey: deepseekKey.trim() };
        if (!defaultProvider) {
          defaultProvider = "deepseek";
          defaultModel = "deepseek-chat";
        }
      }

      const zhipuKey = await question("智谱AI API Key (GLM系列，有免费额度): ");
      if (zhipuKey.trim()) {
        config.providers["zhipu"] = { apiKey: zhipuKey.trim() };
        if (!defaultProvider) {
          defaultProvider = "zhipu";
          defaultModel = "glm-z1-flash";
        }
      }

      const dashscopeKey = await question("DashScope API Key (阿里云灵积，通义千问/Qwen3): ");
      if (dashscopeKey.trim()) {
        config.providers["dashscope"] = { apiKey: dashscopeKey.trim() };
        if (!defaultProvider) {
          defaultProvider = "dashscope";
          defaultModel = "qwen3-235b-a22b";
        }
      }

      const kimiKey = await question("Kimi (Moonshot) API Key: ");
      if (kimiKey.trim()) {
        config.providers["kimi"] = { apiKey: kimiKey.trim() };
        if (!defaultProvider) {
          defaultProvider = "kimi";
          defaultModel = "kimi-k2.5";
        }
      }

      const stepfunKey = await question("阶跃星辰 API Key: ");
      if (stepfunKey.trim()) {
        config.providers["stepfun"] = { apiKey: stepfunKey.trim() };
        if (!defaultProvider) {
          defaultProvider = "stepfun";
          defaultModel = "step-2-mini";
        }
      }

      const minimaxKey = await question("MiniMax API Key: ");
      if (minimaxKey.trim()) {
        const minimaxGroup = await question("MiniMax Group ID: ");
        config.providers["minimax"] = {
          apiKey: minimaxKey.trim(),
          groupId: minimaxGroup.trim() || undefined,
        };
        if (!defaultProvider) {
          defaultProvider = "minimax";
          defaultModel = "MiniMax-M2.1";
        }
      }

      const modelscopeKey = await question("ModelScope API Key (阿里魔搭社区，有免费额度): ");
      if (modelscopeKey.trim()) {
        config.providers["modelscope"] = { apiKey: modelscopeKey.trim() };
        if (!defaultProvider) {
          defaultProvider = "modelscope";
          defaultModel = "Qwen/Qwen2.5-72B-Instruct";
        }
      }
    }

    // 自定义 OpenAI 兼容接口
    if (selectedTypes.includes("2")) {
      console.log("\n--- 自定义 OpenAI 兼容接口配置 ---\n");
      console.log("适用于: OpenAI、Azure OpenAI、vLLM、Ollama、其他 OpenAI 兼容服务\n");

      const customOpenaiBaseUrl = await question("API Endpoint (如 https://api.openai.com/v1): ");
      if (customOpenaiBaseUrl.trim()) {
        const customOpenaiKey = await question("API Key: ");
        const customOpenaiName = await question("提供商名称 (如 OpenAI、vLLM): ");

        console.log("\n配置模型列表 (至少添加一个模型):");
        const models: Array<{
          id: string;
          name?: string;
          contextWindow?: number;
          maxTokens?: number;
          supportsVision?: boolean;
        }> = [];

        let addMore = true;
        while (addMore) {
          const modelId = await question("\n模型 ID (如 gpt-4o, gpt-3.5-turbo): ");
          if (!modelId.trim()) {
            if (models.length === 0) {
              console.log("⚠️  至少需要添加一个模型");
              continue;
            }
            break;
          }

          const modelName = await question("模型显示名称 (可选，直接回车使用 ID): ");
          const contextWindow = await question("上下文窗口大小 (默认 128000): ");
          const maxTokens = await question("最大输出 Token (默认 4096): ");
          const supportsVision = await question("是否支持视觉/图片 (y/n，默认 n): ");

          models.push({
            id: modelId.trim(),
            name: modelName.trim() || undefined,
            contextWindow: contextWindow.trim() ? parseInt(contextWindow.trim(), 10) : undefined,
            maxTokens: maxTokens.trim() ? parseInt(maxTokens.trim(), 10) : undefined,
            supportsVision: supportsVision.toLowerCase() === "y" ? true : undefined,
          });

          console.log(`✓ 已添加模型: ${modelId.trim()}`);
          const continueAdd = await question("继续添加模型? (y/n): ");
          addMore = continueAdd.toLowerCase() === "y";
        }

        if (models.length > 0) {
          config.providers["custom-openai"] = {
            id: "custom-openai",
            name: customOpenaiName.trim() || "Custom OpenAI",
            baseUrl: customOpenaiBaseUrl.trim(),
            apiKey: customOpenaiKey.trim(),
            models: models,
          };

          if (!defaultProvider && models[0]) {
            defaultProvider = "custom-openai";
            defaultModel = models[0].id;
          }
        }
      }
    }

    // 自定义 Anthropic 兼容接口
    if (selectedTypes.includes("3")) {
      console.log("\n--- 自定义 Anthropic 兼容接口配置 ---\n");
      console.log("适用于: Anthropic Claude、AWS Bedrock Claude、其他 Claude API 兼容服务\n");

      const customAnthropicBaseUrl = await question("API Endpoint (如 https://api.anthropic.com/v1): ");
      if (customAnthropicBaseUrl.trim()) {
        const customAnthropicKey = await question("API Key: ");
        const customAnthropicName = await question("提供商名称 (如 Anthropic、Bedrock): ");
        const apiVersion = await question("API 版本 (默认 2023-06-01): ");

        console.log("\n配置模型列表 (至少添加一个模型):");
        const models: Array<{
          id: string;
          name?: string;
          contextWindow?: number;
          maxTokens?: number;
          supportsVision?: boolean;
        }> = [];

        let addMore = true;
        while (addMore) {
          const modelId = await question("\n模型 ID (如 claude-3-5-sonnet-20241022): ");
          if (!modelId.trim()) {
            if (models.length === 0) {
              console.log("⚠️  至少需要添加一个模型");
              continue;
            }
            break;
          }

          const modelName = await question("模型显示名称 (可选，直接回车使用 ID): ");
          const contextWindow = await question("上下文窗口大小 (默认 200000): ");
          const maxTokens = await question("最大输出 Token (默认 8192): ");
          const supportsVision = await question("是否支持视觉/图片 (y/n，默认 n): ");

          models.push({
            id: modelId.trim(),
            name: modelName.trim() || undefined,
            contextWindow: contextWindow.trim() ? parseInt(contextWindow.trim(), 10) : undefined,
            maxTokens: maxTokens.trim() ? parseInt(maxTokens.trim(), 10) : undefined,
            supportsVision: supportsVision.toLowerCase() === "y" ? true : undefined,
          });

          console.log(`✓ 已添加模型: ${modelId.trim()}`);
          const continueAdd = await question("继续添加模型? (y/n): ");
          addMore = continueAdd.toLowerCase() === "y";
        }

        if (models.length > 0) {
          config.providers["custom-anthropic"] = {
            id: "custom-anthropic",
            name: customAnthropicName.trim() || "Custom Anthropic",
            baseUrl: customAnthropicBaseUrl.trim(),
            apiKey: customAnthropicKey.trim(),
            apiVersion: apiVersion.trim() || "2023-06-01",
            models: models,
          };

          if (!defaultProvider && models[0]) {
            defaultProvider = "custom-anthropic";
            defaultModel = models[0].id;
          }
        }
      }
    }

    // 步骤 2: 通道配置
    console.log("\n📱 步骤 2/5: 配置通讯平台\n");
    console.log("支持的平台: 飞书, 钉钉, QQ");
    console.log("(可选配置，直接回车跳过)\n");

    const configFeishu = await question("是否配置飞书? (y/n): ");
    if (configFeishu.toLowerCase() === "y") {
      const feishuAppId = await question("飞书 App ID: ");
      const feishuAppSecret = await question("飞书 App Secret: ");
      if (feishuAppId.trim() && feishuAppSecret.trim()) {
        config.channels["feishu"] = {
          appId: feishuAppId.trim(),
          appSecret: feishuAppSecret.trim(),
        };
      }
    }

    const configDingtalk = await question("是否配置钉钉? (y/n): ");
    if (configDingtalk.toLowerCase() === "y") {
      const dingtalkKey = await question("钉钉 App Key: ");
      const dingtalkSecret = await question("钉钉 App Secret: ");
      if (dingtalkKey.trim() && dingtalkSecret.trim()) {
        config.channels["dingtalk"] = {
          appKey: dingtalkKey.trim(),
          appSecret: dingtalkSecret.trim(),
        };
      }
    }

    const configQQ = await question("是否配置 QQ 机器人? (y/n): ");
    if (configQQ.toLowerCase() === "y") {
      console.log("\n提示: 需要在 QQ 开放平台添加服务器 IP 到白名单");
      const qqAppId = await question("QQ App ID: ");
      const qqClientSecret = await question("QQ Client Secret: ");
      if (qqAppId.trim() && qqClientSecret.trim()) {
        const qqSandbox = await question("是否使用沙箱环境? (y/n，默认 n): ");
        config.channels["qq"] = {
          appId: qqAppId.trim(),
          clientSecret: qqClientSecret.trim(),
          sandbox: qqSandbox.toLowerCase() === "y",
        };
      }
    }

    // 步骤 3: 服务器配置
    console.log("\n🌐 步骤 3/5: 配置服务器\n");

    const port = await question("服务器端口 (默认 3000): ");
    config.server = {
      port: parseInt(port.trim(), 10) || 3000,
    };

    // 步骤 4: Agent 配置
    console.log("\n🤖 步骤 4/5: 配置 Agent\n");

    if (defaultProvider && defaultModel) {
      console.log(`检测到默认模型: ${defaultProvider} / ${defaultModel}`);
      const changeDefault = await question("是否修改默认模型? (y/n): ");
      if (changeDefault.toLowerCase() === "y") {
        const newProvider = await question(`默认提供商 (当前: ${defaultProvider}): `);
        const newModel = await question(`默认模型 (当前: ${defaultModel}): `);
        if (newProvider.trim()) defaultProvider = newProvider.trim();
        if (newModel.trim()) defaultModel = newModel.trim();
      }
    } else {
      defaultProvider = await question("默认提供商: ");
      defaultModel = await question("默认模型: ");
    }

    if (defaultProvider && defaultModel) {
      config.agent = {
        defaultProvider,
        defaultModel,
      };
    }

    // 步骤 5: 记忆系统配置
    console.log("\n🧠 步骤 5/5: 配置记忆系统\n");
    console.log("记忆系统可让 Agent 记住跨会话的信息（如用户偏好、重要事实等）");
    console.log("记忆默认启用，存储在 ~/.mozi/memory/ 目录\n");

    const configMemory = await question("是否自定义记忆系统配置? (y/n，默认 n): ");
    if (configMemory.toLowerCase() === "y") {
      const memoryEnabled = await question("是否启用记忆系统? (y/n，默认 y): ");
      const isEnabled = memoryEnabled.toLowerCase() !== "n";

      if (isEnabled) {
        const storageDir = await question("记忆存储目录 (默认 ~/.mozi/memory): ");
        config.memory = {
          enabled: true,
          storageDir: storageDir.trim() || undefined,
        };
      } else {
        config.memory = {
          enabled: false,
        };
      }
    }

    // 写入配置文件
    console.log("\n");

    const hasProviders = Object.keys(config.providers).length > 0;
    if (!hasProviders) {
      console.log("⚠️  未配置任何模型提供商，请至少配置一个。\n");
      rl.close();
      return;
    }

    // 清理空对象
    if (Object.keys(config.channels).length === 0) delete (config as Record<string, unknown>).channels;
    if (Object.keys(config.agent).length === 0) delete (config as Record<string, unknown>).agent;
    if (Object.keys(config.memory).length === 0) delete (config as Record<string, unknown>).memory;

    // 生成 JSON5 格式配置
    const configContent = serializeJson5(config);

    // 配置文件路径
    const moziDir = path.join(os.homedir(), ".mozi");
    const configPath = path.join(moziDir, "config.local.json5");

    console.log("📋 生成的配置文件:\n");
    console.log("---");
    console.log(configContent);
    console.log("---\n");

    const writeConfig = await question(`是否写入配置到 ${configPath}? (y/n): `);
    if (writeConfig.toLowerCase() === "y") {
      // 确保目录存在
      if (!fs.existsSync(moziDir)) {
        fs.mkdirSync(moziDir, { recursive: true });
      }
      fs.writeFileSync(configPath, configContent, { mode: 0o600 });
      console.log(`\n✅ 配置已保存到 ${configPath}`);
    } else {
      console.log("\n📋 请手动将上述配置保存到配置文件中。");
    }

    const hasChannels = Object.keys(config.channels || {}).length > 0;
    const startCmd = hasChannels ? "mozi start" : "mozi start --web-only";
    const startNote = hasChannels
      ? "   (已配置通讯平台，将同时启动)"
      : "   (仅 WebChat，如需通讯平台请配置 channels)";

    console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   ✅ 配置完成!                                             ║
║                                                            ║
║   下一步:                                                  ║
║                                                            ║
║   1. 检查配置: mozi check                                  ║
║   2. 启动服务: ${startCmd.padEnd(26)}║
${startNote.padEnd(61)}║
║   3. 测试聊天: mozi chat                                   ║
║                                                            ║
║   启动选项:                                                ║
║   - mozi start           完整服务 (WebChat+飞书+钉钉+QQ)   ║
║   - mozi start --web-only 仅 WebChat                       ║
║                                                            ║
║   配置文件: ~/.mozi/config.local.json5                     ║
║   文档: https://github.com/King-Chau/mozi                  ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
`);

    rl.close();
  });

// 停止服务命令
program
  .command("kill")
  .alias("stop")
  .description("停止运行中的 Mozi 服务")
  .action(async () => {
    const { execSync } = await import("child_process");

    try {
      // 查找 mozi 相关进程
      const result = execSync('pgrep -f "node.*dist/cli.*start" 2>/dev/null || echo ""', { encoding: "utf-8" });
      const pids = result.trim().split("\n").filter(Boolean);

      if (pids.length === 0) {
        console.log("没有找到运行中的 Mozi 服务");
        return;
      }

      console.log(`找到 ${pids.length} 个 Mozi 进程: ${pids.join(", ")}`);

      // 终止进程
      for (const pid of pids) {
        try {
          process.kill(parseInt(pid, 10), "SIGTERM");
          console.log(`✅ 已发送终止信号到进程 ${pid}`);
        } catch (err) {
          console.error(`❌ 无法终止进程 ${pid}:`, err instanceof Error ? err.message : err);
        }
      }

      // 等待进程退出
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // 检查是否还有进程在运行
      const remaining = execSync('pgrep -f "node.*dist/cli.*start" 2>/dev/null || echo ""', { encoding: "utf-8" }).trim();
      if (remaining) {
        console.log("⚠️  部分进程仍在运行，尝试强制终止...");
        execSync(`pkill -9 -f "node.*dist/cli.*start" 2>/dev/null || true`);
      }

      console.log("🛑 Mozi 服务已停止");
    } catch (error) {
      console.error("停止服务时出错:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// 重启服务命令
program
  .command("restart")
  .description("重启 Mozi 服务")
  .option("-c, --config <path>", "配置文件路径")
  .option("-p, --port <port>", "服务器端口")
  .option("--web-only", "仅启用 WebChat")
  .action(async (options) => {
    const { execSync, spawn: spawnProcess } = await import("child_process");

    console.log("🔄 正在重启 Mozi 服务...\n");

    // 1. 停止现有服务
    try {
      const result = execSync('pgrep -f "node.*dist/cli.*start" 2>/dev/null || echo ""', { encoding: "utf-8" });
      const pids = result.trim().split("\n").filter(Boolean);

      if (pids.length > 0) {
        console.log(`停止现有服务 (PID: ${pids.join(", ")})...`);
        execSync(`pkill -f "node.*dist/cli.*start" 2>/dev/null || true`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch {
      // 忽略错误
    }

    // 2. 启动新服务
    console.log("启动新服务...\n");

    const args = ["start"];
    if (options.config) args.push("-c", options.config);
    if (options.port) args.push("-p", options.port);
    if (options.webOnly) args.push("--web-only");

    // 使用当前进程直接启动（而不是后台）
    try {
      const config = loadConfig({ configPath: options.config });

      if (options.port) {
        config.server.port = parseInt(options.port, 10);
      }

      const errors = validateRequiredConfig(config);
      if (errors.length > 0) {
        console.error("❌ 配置错误:");
        errors.forEach((err) => console.error(`   - ${err}`));
        process.exit(1);
      }

      await startGateway(config);
    } catch (error) {
      console.error("❌ 重启失败:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// 服务状态命令
program
  .command("status")
  .description("查看 Mozi 服务状态")
  .action(async () => {
    const { execSync } = await import("child_process");

    console.log("\n📊 Mozi 服务状态\n");

    try {
      // 查找 mozi 进程
      const result = execSync('ps aux | grep -E "node.*dist/cli.*start" | grep -v grep 2>/dev/null || echo ""', { encoding: "utf-8" });
      const lines = result.trim().split("\n").filter(Boolean);

      if (lines.length === 0) {
        console.log("状态: 🔴 未运行");
        console.log("\n提示: 使用 'mozi start' 或 'mozi start --web-only' 启动服务");
        return;
      }

      console.log("状态: 🟢 运行中");
      console.log(`进程数: ${lines.length}\n`);

      for (const line of lines) {
        const parts = line.split(/\s+/);
        const pid = parts[1];
        const cpu = parts[2];
        const mem = parts[3];
        const time = parts[9];
        const cmd = parts.slice(10).join(" ").slice(0, 60);

        console.log(`  PID: ${pid}`);
        console.log(`  CPU: ${cpu}%  内存: ${mem}%`);
        console.log(`  运行时间: ${time}`);
        console.log(`  命令: ${cmd}...`);
        console.log("");
      }

      // 检查健康状态
      try {
        const config = loadConfig();
        const port = config.server?.port || 3000;
        const health = execSync(`curl -s http://localhost:${port}/health 2>/dev/null || echo ""`, { encoding: "utf-8" }).trim();

        if (health) {
          const healthData = JSON.parse(health);
          console.log(`健康检查: ✅ ${healthData.status}`);
          console.log(`服务地址: http://localhost:${port}`);
        }
      } catch {
        // 忽略健康检查错误
      }
    } catch (error) {
      console.error("检查状态时出错:", error instanceof Error ? error.message : error);
    }
  });

// 日志查看命令
program
  .command("logs")
  .description("查看日志")
  .option("-f, --follow", "实时跟踪日志 (类似 tail -f)")
  .option("-n, --lines <number>", "显示最后 N 行", "50")
  .option("-l, --list", "列出所有日志文件")
  .option("--date <date>", "查看指定日期的日志 (格式: YYYY-MM-DD)")
  .option("--level <level>", "过滤日志级别 (debug, info, warn, error)")
  .option("--pretty", "格式化输出 (默认开启)", true)
  .action(async (options) => {
    const logDir = getLogDir();

    // 列出所有日志文件
    if (options.list) {
      console.log(`\n日志目录: ${logDir}\n`);

      if (!existsSync(logDir)) {
        console.log("暂无日志文件");
        return;
      }

      const files = readdirSync(logDir)
        .filter((f) => f.endsWith(".log"))
        .sort()
        .reverse();

      if (files.length === 0) {
        console.log("暂无日志文件");
        return;
      }

      console.log("日志文件:");
      for (const file of files) {
        const filePath = join(logDir, file);
        const stats = statSync(filePath);
        const size = (stats.size / 1024).toFixed(1);
        console.log(`  ${file}  (${size} KB)`);
      }
      return;
    }

    // 确定要查看的日志文件
    let logFile: string;
    if (options.date) {
      logFile = join(logDir, `mozi-${options.date}.log`);
    } else {
      logFile = getLogFile();
    }

    if (!existsSync(logFile)) {
      console.error(`日志文件不存在: ${logFile}`);
      console.log(`\n提示: 使用 'mozi logs --list' 查看所有日志文件`);
      return;
    }

    console.log(`日志文件: ${logFile}\n`);

    // 实时跟踪模式
    if (options.follow) {
      console.log("正在跟踪日志... (Ctrl+C 退出)\n");

      const args = ["-f", logFile];
      if (options.lines) {
        args.unshift("-n", options.lines);
      }

      const tail = spawn("tail", args, { stdio: "pipe" });

      tail.stdout.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          printLogLine(line, options.level, options.pretty);
        }
      });

      tail.stderr.on("data", (data: Buffer) => {
        console.error(data.toString());
      });

      process.on("SIGINT", () => {
        tail.kill();
        process.exit(0);
      });

      return;
    }

    // 显示最后 N 行
    const content = readFileSync(logFile, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    const lastN = parseInt(options.lines, 10) || 50;
    const displayLines = lines.slice(-lastN);

    for (const line of displayLines) {
      printLogLine(line, options.level, options.pretty);
    }

    console.log(`\n显示最后 ${displayLines.length} 条日志`);
    console.log(`提示: 使用 'mozi logs -f' 实时跟踪日志`);
  });

/** 打印日志行 */
function printLogLine(line: string, levelFilter?: string, pretty?: boolean): void {
  try {
    const log = JSON.parse(line);

    // 级别过滤
    if (levelFilter) {
      const levelOrder = ["debug", "info", "warn", "error"];
      const logLevel = levelOrder.indexOf(log.level?.toString() || "info");
      const filterLevel = levelOrder.indexOf(levelFilter);
      if (logLevel < filterLevel) return;
    }

    if (pretty) {
      // 格式化输出
      const time = log.time ? new Date(log.time).toLocaleString() : "";
      const level = (log.level || "INFO").toString().toUpperCase().padEnd(5);
      const module = log.module ? `[${log.module}]` : "";
      const msg = log.msg || "";

      // 颜色
      let levelColor = "\x1b[0m"; // reset
      if (log.level === 30 || log.level === "info") levelColor = "\x1b[32m"; // green
      else if (log.level === 40 || log.level === "warn") levelColor = "\x1b[33m"; // yellow
      else if (log.level === 50 || log.level === "error") levelColor = "\x1b[31m"; // red
      else if (log.level === 20 || log.level === "debug") levelColor = "\x1b[36m"; // cyan

      console.log(`\x1b[90m${time}\x1b[0m ${levelColor}${level}\x1b[0m ${module} ${msg}`);

      // 显示额外字段
      const extraKeys = Object.keys(log).filter(
        (k) => !["time", "level", "module", "msg", "name", "pid", "hostname"].includes(k)
      );
      if (extraKeys.length > 0) {
        const extra: Record<string, unknown> = {};
        for (const k of extraKeys) extra[k] = log[k];
        console.log(`  \x1b[90m${JSON.stringify(extra)}\x1b[0m`);
      }
    } else {
      console.log(line);
    }
  } catch {
    // 非 JSON 格式，直接输出
    console.log(line);
  }
}

program.parse();
