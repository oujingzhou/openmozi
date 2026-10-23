<p align="center">
  <img src="./docs/images/mascot.svg" width="80" alt="Mozi Mascot" />
</p>

<p align="center">
  <a href="./README_EN.md">English</a> | 中文
</p>

<table align="center">
  <tr>
    <td align="center"><sub>飞书 机器人</sub></td>
    <td align="center"><sub>QQ 机器人</sub></td>
    <td align="center"><sub>钉钉机器人</sub></td>
  </tr>
  <tr>
    <td><img src="./docs/images/feishu.jpg" width="400" alt="飞书 机器人" /></td>
    <td><img src="./docs/images/qq.jpg" width="400" alt="QQ 机器人" /></td>
    <td><img src="./docs/images/dingding.jpg" width="400" alt="钉钉机器人" /></td>
  </tr>
</table>

**支持国产大模型和国产通讯软件的智能助手框架**

OpenMozi 是一个轻量级的 AI 助手框架，专注于国产生态。基于 [pi-coding-agent](https://github.com/nicemicro/pi-coding-agent) 构建 Agent 运行时（内置会话管理、上下文压缩、工具执行），使用 [pi-ai](https://github.com/nicemicro/pi-ai) 作为统一的多模型调用层（支持 25+ 提供商），原生支持 Function Calling，并支持 QQ、飞书、钉钉、企业微信等通讯平台。

## 核心特性

| 模块 | 目录 | 职责 |
|------|------|------|
| **Agent** | `src/agents/` | 核心消息循环、会话管理（基于 pi-coding-agent） |
| **Providers** | `src/providers/` | 模型解析与映射层（基于 pi-ai，支持 25+ 提供商） |
| **Tools** | `src/tools/` | 工具注册、参数校验、执行引擎，支持自定义扩展 |
| **Skills** | `src/skills/` | 技能系统，通过 SKILL.md 注入专业知识和自定义行为 |
| **Channels** | `src/channels/` | 通道适配器，统一消息格式，支持长连接 |
| **Sessions** | `src/sessions/` | 会话持久化，支持内存/文件存储，Transcript 记录 |
| **Durable** | `src/durable/` | 追加日志、崩溃恢复、回合/工具调用投影（durable execution） |
| **TUI** | `src/tui/` | 终端界面（宽度感知折行、整帧重绘、无第三方 TUI 依赖） |
| **Gateway** | `src/gateway/` | HTTP/WebSocket 服务，路由分发 |

### 上下文压缩策略

基于 [pi-coding-agent](https://github.com/nicemicro/pi-coding-agent) 内置的智能压缩系统：

1. **自动压缩** — 当上下文接近 Token 限制时自动触发
2. **摘要生成** — 将早期对话压缩为摘要，保留关键信息
3. **会话持久化** — 支持 JSONL 格式会话存储和恢复
4. **分支管理** — 支持会话分支和历史回溯

## 核心特性

- **多模型支持** — 基于 pi-ai 统一调用层，支持 DeepSeek、豆包、DashScope (Qwen)、智谱AI、Kimi、阶跃星辰、MiniMax，以及 OpenAI/Anthropic/OpenRouter/Groq 等 25+ 提供商
- **多平台通道** — QQ、飞书、钉钉、企业微信，统一的消息处理接口
- **Function Calling** — 基于 pi-coding-agent 的 Agent 运行时，原生支持工具调用循环
- **25 内置工具** — 文件读写、Bash 执行、代码搜索、网页获取、图像分析、浏览器自动化、记忆系统、定时任务等
- **Skills 技能系统** — 通过 SKILL.md 文件扩展 Agent 能力，支持自定义行为和专业知识注入
- **记忆系统** — 跨会话长期记忆，自动记住用户偏好和重要信息
- **定时任务 (Cron)** — 支持一次性、周期性、Cron 表达式三种调度方式，支持 Agent 执行和主动消息投递
- **插件系统** — 可扩展的插件架构，支持自动发现和加载
- **浏览器自动化** — 基于 Playwright 的浏览器控制，支持多配置文件和截图
- **Durable Execution** — 回合、step、工具调用意图全部写入追加日志；进程崩溃后重启自动恢复，未完成的工具调用会被标记为中断而不是留下悬空调用
- **会话管理** — 上下文压缩、会话持久化、多轮对话
- **可扩展** — 插件系统、Hook 事件、自定义工具、子 Agent

## 为什么选择 OpenMozi？

OpenMozi 的架构设计参考了 [Moltbot](https://github.com/moltbot/moltbot)，但专注于不同的使用场景：

| 特性 | OpenMozi | Moltbot |
|------|------|---------|
| **定位** | 国产生态优先的轻量框架 | 全功能个人 AI 助手 |
| **代码量** | ~16,000 行 (64 文件) | ~516,000 行 (3,137 文件) |
| **国产通讯** | QQ、飞书、钉钉、企业微信原生支持 | WhatsApp、Telegram、Slack 等 |
| **Node.js 版本** | >= 18 | >= 22 |
| **适用场景** | 企业内部机器人、国内团队协作 | 个人多设备助手、海外平台集成 |
| **学习 Agent 原理** | 代码简洁清晰，适合学习 | 代码庞大复杂，学习门槛高 |

> **OpenMozi 用 3% 的代码量实现了核心功能**，专注简洁高效，易于理解和二次开发。
> 适合 [学习 Agent 原理](#学习-agent-原理)，深入了解 AI 助手的架构设计。

## 快速开始

### 环境要求

- Node.js >= 18
- npm / pnpm / yarn
- **跨平台支持**：macOS、Linux、Windows

### 1. 安装

```bash
# 全局安装（推荐）
npm install -g mozi-bot

# 或者克隆项目开发
git clone https://github.com/King-Chau/mozi.git
cd mozi && npm install && npm run build
```

### 2. 配置

运行配置向导（推荐）：

```bash
mozi onboard
```

向导会引导你完成以下配置：
- **国产模型** — DeepSeek、豆包、智谱AI、DashScope、Kimi、阶跃星辰、MiniMax、ModelScope
- **自定义 OpenAI 兼容接口** — 支持任意 OpenAI API 格式的服务（如 vLLM、Ollama）
- **自定义 Anthropic 兼容接口** — 支持任意 Claude API 格式的服务
- **通讯平台** — QQ、飞书、钉钉、企业微信
- **记忆系统** — 启用/禁用长期记忆、自定义存储目录

配置文件将保存到 `~/.mozi/config.local.json5`。

也可以直接使用环境变量（快速体验）：

```bash
export DEEPSEEK_API_KEY=sk-your-key
```

### 3. 启动

```bash
# 终端界面（默认进入 TUI）
mozi

# Web 界面 + 控制台（同时启动已配置的通讯通道）
mozi web

# 只对外提供 Web 服务，不连接飞书/钉钉/QQ（配置保持原样）
mozi web --web-only

# 不自动打开浏览器（CI、容器、远程机器）
mozi web --no-open
```

- `mozi` 直接在终端里对话：`Enter` 发送、`Ctrl+J` 换行、`Ctrl+N` 新会话、`Esc` 取消、`Ctrl+C` 退出。
- `mozi web` 启动服务后访问 `http://localhost:3000`（对话）与 `/control`（设置）。

`mozi web` 启动后会用系统默认浏览器打开 Web 界面；`--no-open` 或环境变量 `MOZI_NO_OPEN=1` 可关闭。
`mozi start` 与 `mozi web` 行为一致，保留它是为了兼容 Dockerfile / docker-compose 里的部署命令。

需要指定配置文件时：`mozi web --config ./my.json5`；TUI 模式使用环境变量 `MOZI_CONFIG=/path/to/config.json5 mozi`。

## 支持的模型提供商

> 底层基于 [pi-ai](https://github.com/nicemicro/pi-ai)，支持 25+ 模型提供商。以下为预配置的提供商，也可通过自定义接口接入任意 OpenAI/Anthropic 兼容服务。

### 国产模型

| 提供商 | 环境变量 | 说明 |
|--------|----------|------|
| DeepSeek | `DEEPSEEK_API_KEY` | 推理能力强、性价比高 |
| 豆包 | `DOUBAO_API_KEY` | 字节跳动火山引擎，Seed 深度思考系列，256k 上下文 |
| DashScope | `DASHSCOPE_API_KEY` | 阿里云灵积/百炼，通义千问商业版，稳定高并发 |
| 智谱 AI | `ZHIPU_API_KEY` | GLM-Z1/GLM-4/GLM-5 系列，清华技术团队，有免费额度 |
| ModelScope | `MODELSCOPE_API_KEY` | 阿里云魔搭社区，Qwen 开源版，有免费额度 |
| Kimi | `KIMI_API_KEY` | Kimi K2.5/Moonshot 系列，长上下文支持 |
| 阶跃星辰 | `STEPFUN_API_KEY` | Step-2/Step-1 系列，推理与多模态 |
| MiniMax | `MINIMAX_API_KEY` | MiniMax M2.5/M2.1 系列，推理能力强 |

### 海外模型

| 提供商 | 环境变量 | 说明 |
|--------|----------|------|
| OpenAI | `OPENAI_API_KEY` | GPT-4o、o1、o3 系列 |
| Anthropic | `ANTHROPIC_API_KEY` | Claude 4 系列（通过 pi-ai 内置支持） |
| OpenRouter | `OPENROUTER_API_KEY` | 聚合多家模型，统一 API |
| Together AI | `TOGETHER_API_KEY` | 开源模型托管，Llama、Mixtral 等 |
| Groq | `GROQ_API_KEY` | 超快推理速度 |
| Google | `GOOGLE_API_KEY` | Gemini 系列（通过 pi-ai 内置支持） |

### 本地部署

| 提供商 | 环境变量 | 说明 |
|--------|----------|------|
| Ollama | `OLLAMA_BASE_URL` | 本地运行开源模型 |
| vLLM | `VLLM_BASE_URL` | 高性能本地推理服务 |

### 模型配置示例：OpenAI 兼容网关

配置约定与 [pi](https://github.com/nicemicro/pi-coding-agent) 保持一致：密钥可以写成 `$ENV_VAR`，加载时展开；模型级 `compat` 原样透传给 pi-ai。

```json5
{
  providers: {
    "custom-openai": {
      id: "gateway",
      name: "Model Gateway",
      baseUrl: "https://your-gateway.example.com/v1",
      apiKey: "$MODEL_GATEWAY_TOKEN",      // 加载配置时展开
      headers: {
        // 需要自定义鉴权头的网关这样写；用标准 Bearer 时可省略
        "X-Auth-Token": "$MODEL_GATEWAY_TOKEN"
      },
      models: [
        {
          id: "your-model-id",
          name: "Your Model",
          contextWindow: 1000000,
          maxTokens: 128000,
          supportsVision: true,
          supportsReasoning: true,
          compat: {
            // 部分网关只接受 low/high/xhigh/max 或 1-100 的整数；
            // 不映射的话默认的 medium 会被 400 拒绝
            reasoningEffortMap: {
              off: "none", minimal: "low", low: "low",
              medium: "high", high: "high", xhigh: "xhigh"
            }
          }
        }
      ]
    }
  },
  agent: {
    defaultProvider: "custom-openai",
    defaultModel: "your-model-id",
    maxTokens: 8192,
    thinkingLevel: "high"       // 对应 reasoning_effort
  }
}
```

`agent.thinkingLevel` 可选 `off | minimal | low | medium | high | xhigh`，默认 `medium`。

两点需要注意（都是实测踩到的）：

- **`reasoning_effort` 取值受限**：走 `compat.reasoningEffortMap` 映射，否则 `medium` 可能被网关拒绝。
- **空 `tools` 数组**：某些 OpenAI 兼容网关会拒绝 `"tools": []`。mozi 在没有工具时不再发送该字段。

### 自定义接口

支持配置任意 OpenAI 或 Anthropic 兼容的 API 接口。通过 `mozi onboard` 向导配置，或手动添加到配置文件：

```json5
{
  providers: {
    // 自定义 OpenAI 兼容接口（如 vLLM、LiteLLM 等）
    "custom-openai": {
      id: "my-provider",
      name: "My Provider",
      baseUrl: "https://api.example.com/v1",
      apiKey: "xxx",
      models: [
        {
          id: "model-id",
          name: "Model Name",
          contextWindow: 32768,
          maxTokens: 4096,
          supportsVision: false,
          supportsTools: true
        }
      ]
    },

    // 自定义 Anthropic 兼容接口
    "custom-anthropic": {
      id: "my-anthropic",
      name: "My Anthropic",
      baseUrl: "https://api.example.com",
      apiKey: "xxx",
      apiVersion: "2023-06-01",
      models: [
        {
          id: "claude-3-5-sonnet",
          name: "Claude 3.5 Sonnet",
          contextWindow: 200000,
          maxTokens: 8192
        }
      ]
    }
  }
}
```

## 通讯平台接入

QQ、飞书和钉钉都支持长连接模式，企业微信使用 Webhook 回调模式：

| 平台 | 连接模式 | 公网 IP | 接入文档 |
|------|----------|---------|----------|
| 飞书 | WebSocket 长连接 | 不需要 | [飞书接入指南](./docs/channels/feishu.md) |
| 钉钉 | Stream 长连接 | 不需要 | [钉钉接入指南](./docs/channels/dingtalk.md) |
| QQ | WebSocket 长连接 | 不需要 | [QQ 接入指南](./docs/channels/qq.md) |
| 企业微信 | Webhook 回调 | 需要 | [企业微信接入指南](./docs/channels/wecom.md) |

> **长连接模式**：无需公网 IP，无需配置回调地址，启动即可接收消息。

## 配置参考

配置文件支持 `config.local.json5`、`config.json5`、`config.yaml` 等格式，优先级从高到低。存放在 `~/.mozi/` 目录下。

<details>
<summary>完整配置示例</summary>

```json5
{
  // 模型提供商
  providers: {
    deepseek: {
      apiKey: "sk-xxx"
    },
    dashscope: {
      apiKey: "sk-xxx",
      // 可选：自定义模型列表（覆盖预设）
      models: [
        {
          id: "qwen-max-latest",
          name: "通义千问 Max",
          contextWindow: 32768,
          maxTokens: 8192
        }
      ]
    },
    zhipu: {
      apiKey: "xxx"
    },
    modelscope: {
      apiKey: "ms-xxx"
    }
  },

  // 通讯平台（长连接模式，无需公网）
  channels: {
    feishu: {
      appId: "cli_xxx",
      appSecret: "xxx"
    },
    dingtalk: {
      appKey: "xxx",
      appSecret: "xxx"
    },
    qq: {
      appId: "xxx",
      clientSecret: "xxx",
      sandbox: false  // 沙箱环境设为 true
    },
    wecom: {
      corpId: "xxx",
      corpSecret: "xxx",
      agentId: "xxx",
      token: "xxx",
      encodingAESKey: "xxx"
    }
  },

  // Agent 配置
  agent: {
    defaultProvider: "deepseek",
    defaultModel: "deepseek-chat",
    temperature: 0.7,
    maxTokens: 4096,
    systemPrompt: "你是墨子，一个智能助手。"
  },

  // 服务器配置
  server: {
    port: 3000,
    host: "0.0.0.0"
  },

  // 日志级别
  logging: {
    level: "info"  // debug | info | warn | error
  },

  // Skills 配置（可选）
  skills: {
    enabled: true,           // 是否启用技能系统（默认 true）
    userDir: "~/.mozi/skills",     // 用户级技能目录
    workspaceDir: "./.mozi/skills", // 工作区级技能目录
    disabled: ["skill-name"],      // 禁用指定技能
    only: ["skill-name"]           // 仅启用指定技能
  },

  // 记忆系统配置（可选）
  memory: {
    enabled: true,                  // 是否启用（默认 true）
    storageDir: "~/.mozi/memory"   // 存储目录（默认 ~/.mozi/memory）
  }
}
```

</details>

## Skills 技能系统

Skills 是 OpenMozi 的可扩展知识注入系统，通过编写 `SKILL.md` 文件，可以为 Agent 添加专业知识、自定义行为规则或领域能力，无需修改代码。

### 工作原理

Skills 通过 YAML frontmatter + Markdown 内容的方式定义，启动时自动加载并注入到 Agent 的系统提示词中。

### 技能加载顺序

| 优先级 | 来源 | 目录 | 说明 |
|--------|------|------|------|
| 1 | 内置 | `skills/` | 项目自带的技能 |
| 2 | 用户级 | `~/.mozi/skills/` | 用户自定义技能，所有项目共享 |
| 3 | 工作区级 | `./.mozi/skills/` | 项目级技能，仅当前项目生效 |

> 同名技能按优先级覆盖，工作区级 > 用户级 > 内置。

### 编写 Skill

每个技能是一个目录，包含一个 `SKILL.md` 文件：

```
skills/
└── greeting/
    └── SKILL.md
```

`SKILL.md` 格式：

```markdown
---
name: greeting
title: 智能问候
description: 根据时间和场景提供个性化问候
version: "1.0"
tags:
  - greeting
  - chat
priority: 10
---

当用户向你打招呼或问候时，请遵循以下规则：

1. **根据时间问候**: 根据当前时间使用合适的问候语
   - 早上 (6:00-11:00): 早上好
   - 下午 (13:00-18:00): 下午好
   - 晚上 (18:00-22:00): 晚上好

2. **友好热情**: 保持友好和积极的态度

3. **简洁明了**: 问候语简短有力
```

### Frontmatter 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 技能唯一标识 |
| `title` | string | 否 | 显示名称 |
| `description` | string | 否 | 技能描述 |
| `version` | string | 否 | 版本号 |
| `tags` | string[] | 否 | 标签，用于分类 |
| `priority` | number | 否 | 优先级，数值越大越靠前（默认 0） |
| `enabled` | boolean | 否 | 是否启用（默认 true） |
| `eligibility.os` | string[] | 否 | 限制操作系统（darwin/linux/win32） |
| `eligibility.binaries` | string[] | 否 | 需要的命令行工具 |
| `eligibility.env` | string[] | 否 | 需要的环境变量 |

### Skills 配置

```json5
{
  skills: {
    enabled: true,             // 是否启用（默认 true）
    userDir: "~/.mozi/skills", // 用户级技能目录
    workspaceDir: "./.mozi/skills", // 工作区级技能目录
    disabled: ["greeting"],    // 禁用指定技能
    only: ["coding"]           // 仅启用指定技能（白名单模式）
  }
}
```

### ClawdHub 技能市场

OpenMozi 支持从 [ClawdHub](https://clawhub.ai) 搜索和安装社区共享的技能。安装 `clawhub` CLI 后，Agent 会自动获得搜索和安装技能的能力。

```bash
# 安装 clawhub CLI
npm i -g clawhub

# 搜索技能
clawhub search <query>

# 安装技能到 mozi 工作区目录
clawhub install <slug> --workdir ./.mozi/skills
```

> ClawdHub 安装的技能使用 moltbot 的 frontmatter 格式（`metadata.openclaw.requires`），OpenMozi 会自动兼容解析。

## 记忆系统

记忆系统让 Agent 能够跨会话记住重要信息，如用户偏好、关键事实、任务上下文等。记忆默认启用，存储在 `~/.mozi/memory/` 目录。

### 工作原理

Agent 通过三个内置工具管理记忆：

| 工具 | 说明 |
|------|------|
| `memory_store` | 存储一条新记忆（包含内容和标签） |
| `memory_query` | 根据关键词查询相关记忆 |
| `memory_list` | 列出所有已存储的记忆 |

Agent 会在对话中自动判断何时需要存储或查询记忆，无需用户手动触发。例如：

- 用户说 "我喜欢简洁的代码风格" → Agent 自动调用 `memory_store` 存储偏好
- 用户问 "我之前说过喜欢什么风格？" → Agent 自动调用 `memory_query` 查询

### 配置

```json5
{
  memory: {
    enabled: true,                  // 是否启用（默认 true）
    storageDir: "~/.mozi/memory"   // 存储目录（默认 ~/.mozi/memory）
  }
}
```

也可以通过 `mozi onboard` 向导配置记忆系统（步骤 5/5）。

### 存储结构

记忆以 JSON 文件存储，每条记忆包含内容、标签和时间戳，支持按关键词检索。

## 定时任务 (Cron)

定时任务系统让 Agent 能够按计划执行任务，支持三种调度方式和两种任务类型：

### 调度类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `at` | 一次性任务 | 在 2024-01-01 10:00 执行 |
| `every` | 周期性任务 | 每 30 分钟执行一次 |
| `cron` | Cron 表达式 | `0 9 * * *` 每天 9 点执行 |

### 任务类型

| 类型 | 说明 | 用途 |
|------|------|------|
| `systemEvent` | 系统事件（默认） | 简单的提醒、触发信号 |
| `agentTurn` | Agent 执行 | 执行 AI 对话，可投递结果到通道 |

`agentTurn` 任务支持以下参数：
- `message` — Agent 执行的消息内容
- `model` — 指定使用的模型（可选）
- `timeoutSeconds` — 执行超时时间，1-600 秒（可选）
- `deliver` — 是否投递结果到通讯通道
- `channel` — 投递目标通道（dingtalk/feishu/qq/wecom）
- `to` — 投递目标 ID（用户/群组 ID）

### 使用方式

Agent 可以通过内置工具管理定时任务：

- `cron_list` — 列出所有任务
- `cron_add` — 添加新任务
- `cron_remove` — 删除任务
- `cron_run` — 立即执行任务
- `cron_update` — 更新任务状态

示例对话：
- "创建一个每天早上 9 点提醒我喝水的任务"
- "创建一个每天下午 6 点自动生成工作日报并发送到钉钉的任务"
- "10 分钟后给飞书群发送一首情诗"
- "列出所有定时任务"
- "删除名为'喝水提醒'的任务"

### 主动消息投递

定时任务支持将 Agent 执行结果主动投递到指定通讯通道，无需用户主动发起对话。

**支持的通道**：

| 通道 | 支持情况 | 配置要求 |
|------|---------|---------|
| 钉钉 | ✅ | 需配置 `robotCode` |
| 飞书 | ✅ | 仅需基本 appId/appSecret |
| QQ | ✅ (有限制) | 需用户 24 小时内与机器人有互动 |
| 企业微信 | ✅ | 需配置 agentId |

**使用示例**：

```typescript
// 通过 cron_add 工具创建 agentTurn 任务
{
  name: "每日工作日报",
  scheduleType: "cron",
  cronExpr: "0 18 * * 1-5",  // 周一到周五下午 6 点
  message: "请根据今天的工作内容生成一份简洁的工作日报",
  payloadType: "agentTurn",
  deliver: true,
  channel: "dingtalk",
  to: "群组ID或用户ID",
  model: "deepseek-chat"
}
```

### 存储

任务数据存储在 `~/.mozi/cron/jobs.json`，支持持久化。

## 插件系统

插件系统允许扩展 OpenMozi 的功能，支持自动发现和加载。

### 插件目录

| 优先级 | 来源 | 目录 | 说明 |
|--------|------|------|------|
| 1 | 内置 | `plugins/` | 项目自带插件 |
| 2 | 全局 | `~/.mozi/plugins/` | 用户安装的全局插件 |
| 3 | 工作区 | `./.mozi/plugins/` | 项目级插件 |

### 编写插件

```typescript
import { definePlugin } from "mozi-bot";

export default definePlugin(
  {
    id: "my-plugin",
    name: "My Plugin",
    version: "1.0.0",
  },
  (api) => {
    // 注册工具
    api.registerTool({
      name: "my_tool",
      description: "My custom tool",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "Hello!" }] }),
    });

    // 注册 Hook
    api.registerHook("message_received", (ctx) => {
      console.log("Message received:", ctx.content);
    });
  }
);
```

### PluginApi

| 方法 | 说明 |
|------|------|
| `registerTool(tool)` | 注册自定义工具 |
| `registerTools(tools)` | 批量注册工具 |
| `registerHook(event, handler)` | 注册事件钩子 |
| `getConfig()` | 获取插件配置 |

## 内置工具

| 类别 | 工具 | 说明 |
|------|------|------|
| 文件 | `read_file` | 读取文件内容 |
| | `write_file` | 写入/创建文件 |
| | `edit_file` | 精确字符串替换 |
| | `list_directory` | 列出目录内容 |
| | `glob` | 按模式搜索文件 |
| | `grep` | 按内容搜索文件 |
| | `apply_patch` | 应用 diff 补丁 |
| 命令 | `bash` | 执行 Bash 命令 |
| | `process` | 管理后台进程 |
| 网络 | `web_search` | 网络搜索 |
| | `web_fetch` | 获取网页内容 |
| 多媒体 | `image_analyze` | 图像分析（需要视觉模型） |
| | `browser` | 浏览器自动化（需安装 Playwright） |
| 系统 | `current_time` | 获取当前时间 |
| | `calculator` | 数学计算 |
| | `delay` | 延时等待 |
| 记忆 | `memory_store` | 存储长期记忆 |
| | `memory_query` | 查询相关记忆 |
| | `memory_list` | 列出所有记忆 |
| 定时任务 | `cron_list` | 列出所有定时任务 |
| | `cron_add` | 添加定时任务 |
| | `cron_remove` | 删除定时任务 |
| | `cron_run` | 立即执行任务 |
| | `cron_update` | 更新任务状态 |
| Agent | `subagent` | 创建子 Agent 执行复杂任务 |

## Durable Execution

会话不是「内存里的对话」，而是一份只追加的日志。这样进程随时可以死，重启后接着跑。

### 日志结构

每个会话一个文件：`~/.mozi/sessions/journal/<sessionKey>.jsonl`（与 pi 自己的会话文件分目录，互不覆盖）。

```jsonl
{"type":"header","version":1,"sessionKey":"webchat:session_abc","sessionId":"...","cwd":"..."}
{"kind":"turn","turnId":"t1","requestId":"req-1","content":"部署到生产","source":"webchat","seq":1,"at":0,"type":"record"}
{"kind":"assistant","turnId":"t1","stepId":"step-1","text":"先检查环境","seq":2,"at":0,"type":"record"}
{"kind":"tool-intent","turnId":"t1","stepId":"step-1","callId":"call-1","name":"bash","args":{"command":"deploy.sh"},"replay":"unsafe","seq":3,"at":0,"type":"record"}
{"type":"commit","seq":3,"count":3,"at":0}
```

| 记录 | 何时写入 | 作用 |
|------|----------|------|
| `turn` | 用户输入到达时，先于模型调用 | 恢复锚点，同时也是 `requestId` 幂等键 |
| `assistant` | 每个 step 结束（流式中间态按 250ms 节流） | 刷新页面后能继续显示正在生成的内容 |
| `tool-intent` | 工具执行**之前** | 崩溃后可知「这个调用可能已经跑过」 |
| `tool-result` | 工具返回后 | 结果、耗时、是否出错 |
| `turn-end` | 回合结束 | `completed` / `aborted` / `error` / `interrupted` |
| `reset` | 用户清空对话 | 投影时截断历史 |

一批记录 + 一个 `commit` 行才算提交。加载时尾部没有 `commit` 的记录一律丢弃（torn tail），因此不会读到半条数据。

### 崩溃恢复

重启时对每个会话做一次规范化：

1. 扫描投影，找出 `turn` 没有对应 `turn-end` 的回合 —— 说明进程死在半路。
2. 为其中仍处于 `running` 的工具调用补写 `tool-result`（`isError: true`，`interrupted: true`）。
3. 补写 `turn-end`，原因为 `interrupted`。
4. 修补 pi 会话文件：为「assistant 发出了 toolCall 但没有 toolResult」的调用补写一条合成结果。

第 4 步很关键 —— 多数 OpenAI 兼容接口遇到悬空的 `tool_call` 会直接报错，不修补的话恢复后的第一次提问就会失败。

恢复是幂等的：重复启动不会重复补写。

```mermaid
sequenceDiagram
    participant P1 as 进程 1
    participant J as 追加日志
    participant P2 as 进程 2（重启后）
    P1->>J: turn
    P1->>J: assistant(step-1)
    P1->>J: tool-intent(call-1)
    Note over P1: kill -9
    P2->>J: 读取，发现无 turn-end
    P2->>J: tool-result(call-1, interrupted)
    P2->>J: turn-end(interrupted)
    Note over P2: 修补 pi 会话中的孤立 toolCall
```

### 幂等提交

`chat.send` 带 `requestId`。同一会话内重复提交（网络重试、双击发送、多标签页）不会产生第二个回合，而是返回已有结果。

### 相关代码

| 文件 | 职责 |
|------|------|
| `src/durable/journal.ts` | 追加日志、commit 语义、torn tail 截断 |
| `src/durable/store.ts` | 会话打开、崩溃恢复、事件订阅 |
| `src/durable/projection.ts` | 从记录折叠出回合 / step / 工具视图 |
| `src/durable/recorder.ts` | 把 pi 的会话事件翻译成日志记录 |
| `src/agents/runtime.ts` | 会话生命周期、pi 会话修补、回合守卫 |

### 限制

- 工具副作用是**至少一次**语义。恢复时不会自动重放工具；`bash`、`write` 这类工具即便标记为 `replay: "safe"` 也由调用方负责幂等。
- 单回合工具轮数上限默认 64 轮（`maxToolRounds`），防止工具持续失败时模型无限重试。

## CLI 命令

```bash
# 配置
mozi onboard            # 配置向导（模型/平台/服务器/Agent/记忆系统）
mozi check              # 检查配置
mozi models             # 列出可用模型

# 对话
mozi                    # 终端界面（TUI）
mozi -m <model>         # 临时指定模型

# 启动 Web 服务
mozi web                # Web 界面 + 控制台（含已配置的通讯通道）
mozi web --web-only     # 只启动 Web，不连接通讯通道
mozi web --port 8080    # 指定端口
mozi web --no-open      # 不自动打开浏览器
mozi web -c my.json5    # 指定配置文件（保存也写回该文件）
mozi start              # 与 mozi web 相同（容器部署兼容）

# 服务管理
mozi status             # 查看服务状态（进程数、CPU/内存、健康检查）
mozi restart            # 重启服务（支持 --web-only 等选项）
mozi kill               # 停止服务（别名：mozi stop）

# 日志
mozi logs               # 查看最新日志（默认 50 行）
mozi logs -n 100        # 查看最新 100 行
mozi logs -f            # 实时跟踪日志（类似 tail -f）
mozi logs --level error # 只显示错误日志
```

> 日志文件存储在 `~/.mozi/logs/` 目录下，按日期自动轮转。

## 项目结构

```
src/
├── agents/        # Agent 核心（基于 pi-coding-agent，消息循环、会话管理）
├── channels/      # 通道适配器（QQ、飞书、钉钉、企业微信）
├── providers/     # 模型解析（基于 pi-ai，将配置映射为统一 Model 对象）
├── tools/         # 内置工具（文件、Bash、网络、定时任务等）
├── skills/        # 技能系统（SKILL.md 加载、注册）
├── sessions/      # 会话存储（内存、文件）
├── durable/       # Durable execution（追加日志、恢复、投影）
├── memory/        # 记忆系统
├── cron/          # 定时任务系统（调度、存储、执行器）
├── outbound/      # 主动消息投递（统一出站接口）
├── plugins/       # 插件系统（发现、加载、注册）
├── browser/       # 浏览器自动化（配置、会话、截图）
├── web/           # WebChat 与控制台（ui/ 下为真实前端资源）
├── tui/           # 终端界面（TUI）
├── config/        # 配置加载
├── gateway/       # HTTP/WebSocket 网关
├── cli/           # CLI 命令行工具
├── hooks/         # Hook 事件系统
├── utils/         # 工具函数
└── types/         # TypeScript 类型定义

skills/            # 内置技能
├── greeting/      # 智能问候技能示例
│   └── SKILL.md
└── clawhub/       # ClawdHub 技能市场集成
    └── SKILL.md
```

## API 使用

```typescript
import { loadConfig, initializeProviders, resolveModel, getApiKeyForProvider } from "mozi-bot";
import { completeSimple } from "@mariozechner/pi-ai";

const config = loadConfig();
initializeProviders(config);

const model = resolveModel("deepseek", "deepseek-chat");
const apiKey = getApiKeyForProvider("deepseek");

const response = await completeSimple(model, {
  messages: [{ role: "user", content: "你好！", timestamp: Date.now() }],
  tools: [],
}, { apiKey });

const text = response.content
  .filter(c => c.type === "text")
  .map(c => c.text)
  .join("");
console.log(text);
```

## 学习 Agent 原理

如果你想了解 AI Agent 的工作原理，OpenMozi 是一个很好的学习项目。相比动辄几十万行代码的大型框架，OpenMozi 只有约 16,000 行代码，但实现了完整的 Agent 核心功能。

### 架构图

```mermaid
flowchart TB
    subgraph Input["📥 输入层"]
        Feishu["🔵 飞书\nWebSocket 长连接"]
        Dingtalk["🟢 钉钉\nStream 长连接"]
        QQ["🟣 QQ\nWebSocket 长连接"]
        WeCom["🔴 企业微信\nHTTP 回调"]
        WebChat["🟡 WebChat\nHTTP + WebSocket"]
    end

    subgraph Server["🚀 服务层"]
        Gateway["Gateway 网关\nHTTP/WebSocket 路由"]
    end

    subgraph Core["⚙️ 核心层"]
        Agent["Agent 引擎"]

        subgraph AgentInner[" "]
            MsgLoop["📨 消息循环\nUser → LLM → Tool → Result"]
            CtxMgr["📚 上下文管理\n历史压缩 / Token 控制"]
            Session["💾 会话存储\nMemory / File"]
            Skills["🎯 Skills 技能\nSKILL.md 知识注入"]
        end
    end

    subgraph External["🔗 外部依赖"]
        subgraph Providers["模型提供商"]
            P1["DeepSeek"]
            P2["豆包"]
            P3["DashScope"]
            P4["智谱AI"]
            P5["Kimi"]
            P6["OpenAI"]
            P7["Anthropic"]
        end

        subgraph Tools["工具系统"]
            T1["📁 文件操作\nread/write/edit/glob/grep"]
            T2["⌨️ Bash 执行\n命令行 / 进程管理"]
            T3["🌐 网络请求\nsearch/fetch"]
            T4["🖼️ 多媒体\n图像分析 / 浏览器"]
            T5["🧠 记忆系统\n长期记忆存储 / 查询"]
            T6["🤖 子 Agent\n复杂任务分解"]
            T7["⏰ 定时任务\nCron 调度 / 周期执行"]
        end
    end

    Feishu --> Gateway
    Dingtalk --> Gateway
    QQ --> Gateway
    WeCom --> Gateway
    WebChat --> Gateway
    Gateway --> Agent
    Agent --> MsgLoop
    MsgLoop <--> CtxMgr
    MsgLoop <--> Session
    MsgLoop <--> Skills
    MsgLoop <-->|"调用模型"| Providers
    MsgLoop <-->|"执行工具"| Tools
```

### 消息处理流程

```mermaid
flowchart TD
    Start([用户发送消息]) --> Channel[Channel 接收]
    Channel --> Gateway[Gateway 路由]
    Gateway --> LoadCtx[加载会话上下文]

    LoadCtx --> LoadSkills[加载 Skills 技能]
    LoadSkills --> BuildCtx[构建 LLM 请求]
    BuildCtx --> |系统提示词 + Skills<br/>历史消息<br/>工具列表| CallLLM[调用 LLM]

    CallLLM --> Check{返回类型?}

    Check --> |纯文本| Response[返回响应]
    Check --> |工具调用| ExecTool[执行工具]

    ExecTool --> ToolResult[工具返回结果]
    ToolResult --> |加入上下文| CallLLM

    Response --> SaveCtx[保存会话]
    SaveCtx --> Send[Channel 发送]
    Send --> End([用户收到回复])

    style Start fill:#e1f5fe
    style End fill:#e8f5e9
    style CallLLM fill:#fff3e0
    style ExecTool fill:#fce4ec
    style LoadSkills fill:#f3e5f5
```

### 核心模块

| 模块 | 目录 | 职责 |
|------|------|------|
| **Agent** | `src/agents/` | 核心消息循环、会话管理（基于 pi-coding-agent） |
| **Providers** | `src/providers/` | 模型解析与映射层（基于 pi-ai，支持 25+ 提供商） |
| **Tools** | `src/tools/` | 工具注册、参数校验、执行引擎，支持自定义扩展 |
| **Skills** | `src/skills/` | 技能系统，通过 SKILL.md 注入专业知识和自定义行为 |
| **Channels** | `src/channels/` | 通道适配器，统一消息格式，支持长连接 |
| **Sessions** | `src/sessions/` | 会话持久化，支持内存/文件存储，Transcript 记录 |
| **Durable** | `src/durable/` | 追加日志、崩溃恢复、回合/工具调用投影（durable execution） |
| **TUI** | `src/tui/` | 终端界面（宽度感知折行、整帧重绘、无第三方 TUI 依赖） |
| **Gateway** | `src/gateway/` | HTTP/WebSocket 服务，路由分发 |

### 上下文压缩策略

基于 [pi-coding-agent](https://github.com/nicemicro/pi-coding-agent) 内置的智能压缩系统：

1. **自动压缩** — 当上下文接近 Token 限制时自动触发
2. **摘要生成** — 将早期对话压缩为摘要，保留关键信息
3. **会话持久化** — 支持 JSONL 格式会话存储和恢复
4. **分支管理** — 支持会话分支和历史回溯

代码结构清晰，注释完善，适合阅读源码学习 Agent 架构设计。

### 核心功能概览

- **消息循环** — 用户输入 → LLM 推理 → 工具调用 → 结果反馈（基于 pi-coding-agent）
- **上下文管理** — 会话历史、Token 压缩、多轮对话
- **工具系统** — 函数定义、参数校验、结果处理
- **记忆系统** — 跨会话长期记忆、存储与检索
- **技能系统** — SKILL.md 加载、知识注入、系统提示词扩展
- **流式输出** — SSE/WebSocket 实时响应

## 开发

```bash
# 开发模式（自动重启）
npm run dev -- start --web-only

# 构建
npm run build

# 测试
npm test
```

## Docker 部署

OpenMozi 提供完整的 Docker 部署支持，包含 Dockerfile 和 Docker Compose 配置。

### 方式一：Docker Compose（推荐）

```bash
# 构建并启动
docker compose up -d --build

# 查看日志
docker compose logs -f

# 停止服务
docker compose down
```

### 方式二：直接运行 Docker

```bash
# 构建镜像
docker build -t mozi-bot:latest .

# 运行容器（仅 WebChat）
docker run -d -p 3000:3000 mozi-bot:latest start --web-only

# 运行容器（完整模式，需配置环境变量）
docker run -d -p 3000:3000 \
  -e DEEPSEEK_API_KEY=sk-xxx \
  -e FEISHU_APP_ID=xxx \
  -e FEISHU_APP_SECRET=xxx \
  -v mozi-data:/home/mozi/.mozi \
  mozi-bot:latest
```

### 配置方式

Docker 支持两种配置方式：

1. **环境变量** — 直接在 docker-compose.yml 中配置（推荐快速体验）
2. **配置文件挂载** — 挂载 `config.local.json5` 到容器

```yaml
# docker-compose.yml 示例
services:
  mozi:
    image: mozi-bot:latest
    command: ["start", "--web-only"]  # 移除 --web-only 使用完整模式
    ports:
      - "3000:3000"
    volumes:
      - mozi-data:/home/mozi/.mozi
      # 挂载自定义配置
      - ./config.local.json5:/app/config.local.json5:ro
    environment:
      - PORT=3000
      - LOG_LEVEL=info
      # 配置模型 API Key
      - DEEPSEEK_API_KEY=sk-xxx
      # 配置通讯平台（需移除 --web-only）
      - FEISHU_APP_ID=xxx
      - FEISHU_APP_SECRET=xxx
```

### 数据持久化

数据通过 Docker volume `mozi-data` 持久化，包含：

- 日志 (`logs/`)
- 会话 (`sessions/`)
- 记忆 (`memory/`)
- 定时任务 (`cron/`)
- Skills (`skills/`)

### 健康检查

容器内置健康检查，访问 `http://localhost:3000/health`：

```json
{"status":"ok","timestamp":"2026-02-03T13:00:00.000Z"}
```

### 访问服务

启动后可通过以下地址访问：

| 服务 | 地址 |
|------|------|
| 聊天 | http://localhost:3000/ |
| 设置 | http://localhost:3000/control |
| 健康检查 | http://localhost:3000/health |

## 终端界面（TUI）

`mozi` 不带子命令时进入终端界面，不依赖任何 TUI 库。

```
墨子  your-model-id                                                                 就绪

你  列出当前目录下前 5 个文件

墨子  当前目录下前 5 个文件：…
      ⋯ 思考：Let me list the directory.
      ✓ bash ls -1 | head -5 0.1s

────────────────────────────────────────────────────────────────────────────────────
›
Enter 发送 · Ctrl+J 换行 · Ctrl+N 新会话 · ↑↓ 历史 · PgUp/PgDn 滚动 · Ctrl+C 退出    9.8s
```

| 按键 | 作用 |
|------|------|
| `Enter` | 发送 |
| `Ctrl+J` | 换行（多行输入） |
| `Ctrl+N` | 新会话（清空上下文，保留历史日志） |
| `↑` / `↓` | 输入为空时翻阅历史，否则滚动对话 |
| `PgUp` / `PgDn` | 滚动对话 |
| `Esc` | 取消正在生成的回合；空闲时清空输入 |
| `Ctrl+U` | 清空输入 |
| `Ctrl+L` | 清屏（保留上下文） |
| `Ctrl+C` | 退出 |

实现要点：

- **按显示宽度折行**：全角字符按 2 列计算，避免中文错位。见 `src/tui/terminal.ts`。
- **整帧重绘**：每帧重画整屏而不是增量更新，对话场景下更不容易出错。
- **日志只落文件**：TUI 占满终端，日志目标被切换为文件，避免打断渲染（`createLogger({ console: false })`）。
- **会话延续**：启动时读取 durable 快照，恢复上次的对话；`Ctrl+N` 走 `clearSession` 开启新上下文。

## Web 界面

前端资源是真实文件（`src/web/ui/`），构建时复制到 `dist/web/ui/`，由服务器直接提供。没有打包步骤，也没有 CDN 依赖。

| 文件 | 内容 |
|------|------|
| `tokens.css` | 三层设计令牌：静态色板 → 语义别名（浅色/深色）→ 组件变量 |
| `app.css` | 三栏骨架、消息、思考行、工具卡片、轨迹表 |
| `app.js` | 状态机、WebSocket 协议、增量渲染 |
| `index.html` / `control.html` | 页面模板（占位替换，非模板字符串拼接） |

### 布局

```
┌──────────┬────────────────────────────┬──────────────┐
│ 侧边栏    │ 顶栏：标题 / 对话·轨迹切换  │ 详情（可选）  │
│ 280px    ├────────────────────────────┤ 360px        │
│ 会话列表  │ 消息流（最大 748px 居中）   │ 工具输入输出  │
│ 状态点    ├────────────────────────────┤              │
│          │ 输入区（胶囊卡片 + 停靠区） │              │
└──────────┴────────────────────────────┴──────────────┘
```

窄屏自动降级：1180px 以下隐藏详情栏，1024px 以下侧边栏收成图标条，640px 以下变成抽屉。

### 交互要点

- **工具卡片**：默认折叠的一行摘要；展开后 `bash` 渲染终端块、`edit/write` 渲染增删差异、`read` 渲染带行号内容，其余走输入/输出两栏。点击卡片同时把该调用送进右侧详情栏。
- **思考行**：折叠状态只显示最后一行，流式时自动滚到最新。
- **流式文字**：正文保持正常配色（不套渐变扫光，否则内联代码等子元素会继承透明色），状态行超过 15 秒才显示耗时。
- **刷新恢复**：页面重连后拉取 `sessions.history` 快照，正在生成的 step 会带着已有内容继续增长；计时锚定日志里的 `createdAt`，不是页面挂载时间。
- **增量渲染与跟随**：只更新内容变化的回合并保留其余 DOM（滚动位置、展开状态不丢）；贴在底部时自动跟随新内容，向上滚动后停止跟随并显示"回到最新"。
- **轨迹联动**：回合、用户输入、模型输出、工具调用四类行都可点击，右侧详情栏分别展示输入、输出与思考内容。
- **排队与插入**：回合运行中按 `Enter` 会把消息排队（follow-up），回合结束后按顺序执行；排队消息可「插入」——中断当前回合让新消息立刻执行，也可「删除」。队列写入 durable 日志，进程重启后仍会继续执行。
- **缺口检测**：每条事件带 `seq`；收到 `seq > lastSeq + 1` 时直接重拉快照，不在错误状态上继续追加。
- **主题**：`tokens.css` 的语义别名在 `body[data-theme="dark"]` 下整体翻转；首帧前内联脚本定主题，无闪烁。

### 设置页（`/control`）

与聊天页共用同一套设计令牌，左侧分组导航 + 右侧表单，底部固定保存条：

| 分区 | 内容 |
|------|------|
| 概览 | 版本、运行时长、已注册的提供商与通道、会话目录 |
| 模型提供商 | 提供商卡片（密钥脱敏、模型列表）、添加/编辑/删除 |
| Agent | 默认提供商与模型、思考深度、温度、最大 Token、系统提示 |
| 通讯通道 | 飞书 / 钉钉 / QQ / 企业微信，密钥留空表示保持不变 |
| 服务与日志 | 端口、监听地址、日志级别（改端口会提示需要重启） |
| 记忆与技能 | 记忆开关与目录、技能目录 |
| 会话 / 事件日志 | 活动会话数、本次页面的连接与配置操作记录 |

保存行为：

- 只提交改动过的分区，未触碰的提供商字段（`models` / `headers` / `compat`）原样保留。
- 先 `config.validate` 再 `config.save`，失败不会写盘。
- 写回**实际加载的那个配置文件**（`mozi web -c foo.json5` 就写回 `foo.json5`）。
- 保存后服务端立即重载配置，新加的提供商不需要重启就能出现在列表里。
- 表单留空的模型不会被写成空字符串，避免下次启动解析不到模型。

### 协议

客户端 → 服务端（命令）：

```jsonc
{ "type": "req", "id": "1", "method": "chat.send", "params": { "message": "hi", "requestId": "uuid" } }
```

方法：`chat.send` / `chat.cancel` / `chat.dequeue` / `chat.steer` / `chat.clear` / `sessions.list` / `sessions.history` / `sessions.restore` / `sessions.subscribe` / `sessions.unsubscribe` / `sessions.delete` / `sessions.reset` / `status.get` / `config.get` / `config.save` / `config.validate`。

服务端 → 客户端（事件）：

| 事件 | 载荷 |
|------|------|
| `session.subscribed` | `{ sessionKey, lastSeq }` |
| `session.snapshot` | 完整会话投影（含进行中的回合） |
| `session.event` | `turn_start` / `step_start` / `text_delta` / `thinking_delta` / `assistant` / `tool_start` / `tool_update` / `tool_end` / `turn_end`，均带 `seq` 与 `sessionKey` |
| `session.status` | `{ sessionKey, running }` |
| `queue_added` / `queue_removed` | 排队消息变化 |
| `chat.delta` / `chat.error` | 纯文本流，兼容旧客户端 |

## License

Apache 2.0
