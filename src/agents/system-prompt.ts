/**
 * 系统提示构建器
 * 参考 moltbot 的 system-prompt.ts
 */

import * as os from "os";
import * as path from "path";
import type { Tool } from "../tools/types.js";

/** 系统提示选项 */
export interface SystemPromptOptions {
  /** 基础系统提示 */
  basePrompt?: string;
  /** 工作目录 */
  workingDirectory?: string;
  /** 是否包含环境信息 */
  includeEnvironment?: boolean;
  /** 是否包含日期时间 */
  includeDateTime?: boolean;
  /** 是否包含工具使用规则 */
  /** 可用工具列表 (用于生成工具使用指南) */
  tools?: Tool[];
  /** 额外的上下文 (如之前的摘要) */
  additionalContext?: string;
  /** 用户名 */
  userName?: string;
  /** Skills prompt (由 skills registry 构建) */
  skillsPrompt?: string;
  /** 是否启用记忆系统（用于注入记忆使用指南） */
  enableMemory?: boolean;
}

/** 获取平台信息 */
function getPlatformInfo(): string {
  const platform = os.platform();
  const arch = os.arch();
  const release = os.release();

  const platformNames: Record<string, string> = {
    darwin: "macOS",
    linux: "Linux",
    win32: "Windows",
  };

  const platformName = platformNames[platform] ?? platform;

  return `${platformName} ${release} (${arch})`;
}

/** 获取当前日期时间 */
function getCurrentDateTime(): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  const timeStr = now.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return `${dateStr} ${timeStr}`;
}

/** 获取 Shell 信息 */
function getShellInfo(): string {
  return process.env.SHELL ?? "/bin/bash";
}

/** 构建环境信息部分 */
function buildEnvironmentSection(options: SystemPromptOptions): string {
  const cwd = options.workingDirectory ?? process.cwd();
  const sections: string[] = [];

  sections.push(`<environment>`);
  sections.push(`Working directory: ${cwd}`);
  sections.push(`Platform: ${getPlatformInfo()}`);
  sections.push(`Shell: ${getShellInfo()}`);
  sections.push(`Home: ${os.homedir()}`);

  if (options.includeDateTime !== false) {
    sections.push(`Current time: ${getCurrentDateTime()}`);
  }

  // 检测是否是 git 仓库
  try {
    const gitDir = path.join(cwd, ".git");
    const fs = require("fs");
    if (fs.existsSync(gitDir)) {
      sections.push(`Git repository: Yes`);
    }
  } catch {
    // ignore
  }

  if (options.userName) {
    sections.push(`User: ${options.userName}`);
  }

  sections.push(`</environment>`);

  return sections.join("\n");
}

/** 构建记忆工具使用指南 */
function buildMemoryGuide(): string {
  return `
### 记忆系统使用指南

你可以使用记忆工具来存储和检索重要信息。

**主动搜索记忆的时机**:
当用户的问题涉及以下情况时，你应该**首先**使用 \`memory_search\` 搜索相关记忆：
- 询问个人信息（如"我是谁"、"我的名字"、"我叫什么"、"我的喜好"等）
- 提到之前的对话或约定（如"上次说的..."、"之前我们讨论的..."、"你还记得..."）
- 询问之前记录的事实、笔记或代码片段
- 任何可能在记忆中有相关信息的问题

**搜索示例**:
- 用户问"我是谁" → 搜索: \`memory_search({ query: "用户 名字 身份 个人信息" })\`
- 用户问"之前的配置" → 搜索: \`memory_search({ query: "配置", type: "note" })\`

**存储记忆的时机**:
当用户明确告诉你需要记住的信息时，使用 \`memory_store\` 存储：
- "记住我叫..."、"我的名字是..."
- "把这个保存下来"、"记录一下"
- 重要的事实、偏好、配置等
`;
}

/** 构建输出格式指南 */
function buildOutputFormatGuide(): string {
  return `
## 输出格式

使用清晰结构化的 Markdown 格式输出，使内容易于阅读：

**格式要点**:
- 使用 **粗体** 强调关键信息
- 使用 \`代码\` 标记命令、函数名、文件路径
- 使用代码块展示代码，并标注语言
- 复杂信息用表格或列表组织
- 用分级标题 (## / ###) 组织长内容

**代码块示例**:
\`\`\`typescript
function example() {
  return "hello";
}
\`\`\`

**表格示例**:
| 项目 | 说明 |
|------|------|
| 名称 | 值 |

**列表示例**:
- 第一点
- 第二点
  - 子项

**简洁原则**:
- 直接回答问题，不要过度解释
- 代码优于描述
- 避免重复信息
`;
}

/** 构建完整系统提示 */
export function buildSystemPrompt(options: SystemPromptOptions): string {
  const sections: string[] = [];

  // 基础提示
  const basePrompt = options.basePrompt ??
    "你是一个智能编程助手，可以帮助用户完成各种软件开发任务。请用中文回答问题，代码和命令使用英文。";

  sections.push(basePrompt);

  // 环境信息
  if (options.includeEnvironment !== false) {
    sections.push("");
    sections.push(buildEnvironmentSection(options));
  }

  // 原生 function calling 模式下，单独注入记忆指南
  if (options.enableMemory && !(options.tools?.some((t) => t.name === "memory_search"))) {
    sections.push(buildMemoryGuide());
  }

  // Skills prompt
  if (options.skillsPrompt) {
    sections.push("");
    sections.push(options.skillsPrompt);
  }

  // 输出格式指南
  sections.push(buildOutputFormatGuide());

  // 额外上下文
  if (options.additionalContext) {
    sections.push("");
    sections.push("## 之前的对话摘要");
    sections.push("");
    sections.push(options.additionalContext);
  }

  return sections.join("\n").trim();
}
