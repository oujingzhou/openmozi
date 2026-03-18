/**
 * 内置工具 - 图片分析
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { jsonResult, errorResult, readStringParam } from "../common.js";
import { resolveModel, getApiKeyForProvider, isProviderAvailable } from "../../providers/index.js";
import type { ProviderId } from "../../types/index.js";
import { readFileSync, existsSync } from "fs";
import { extname } from "path";
import { completeSimple } from "@mariozechner/pi-ai";

/** 图片分析工具选项 */
export interface ImageAnalyzeToolOptions {
  defaultProvider?: ProviderId;
  defaultModel?: string;
}

/** 获取图片的 MIME 类型 */
function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
  };
  return mimeTypes[ext] ?? "image/jpeg";
}

/** 图片分析工具 */
export function createImageAnalyzeTool(options?: ImageAnalyzeToolOptions): AgentTool {
  return {
    name: "image_analyze",
    label: "Image Analyze",
    description: "Analyze an image using a vision-capable model. Can describe content, extract text, identify objects, etc.",
    parameters: Type.Object({
      image: Type.String({ description: "Image source: file path, URL, or base64 data" }),
      prompt: Type.Optional(Type.String({ description: "Question or instruction about the image (default: 'Describe this image')" })),
      provider: Type.Optional(Type.String({ description: "Model provider to use" })),
      model: Type.Optional(Type.String({ description: "Specific model to use" })),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const image = readStringParam(params, "image", { required: true })!;
      const prompt = readStringParam(params, "prompt") ?? "请详细描述这张图片的内容。";
      const providerParam = readStringParam(params, "provider") as ProviderId | undefined;
      const modelParam = readStringParam(params, "model");

      try {
        // 解析图片数据
        let imageData: { url?: string; base64?: string; mediaType?: string };

        if (image.startsWith("http://") || image.startsWith("https://")) {
          imageData = { url: image };
        } else if (image.startsWith("data:")) {
          const match = image.match(/^data:([^;]+);base64,(.+)$/);
          if (!match) {
            return errorResult("Invalid data URL format");
          }
          imageData = { base64: match[2], mediaType: match[1] };
        } else if (existsSync(image)) {
          const buffer = readFileSync(image);
          imageData = {
            base64: buffer.toString("base64"),
            mediaType: getMimeType(image),
          };
        } else if (/^[A-Za-z0-9+/=]+$/.test(image) && image.length > 100) {
          imageData = { base64: image, mediaType: "image/jpeg" };
        } else {
          return errorResult("Invalid image source. Provide a URL, file path, or base64 data.");
        }

        // 查找支持视觉的模型
        const visionCandidates: Array<{ provider: ProviderId; model: string }> = [
          { provider: "kimi", model: "kimi-latest" },
          { provider: "minimax", model: "MiniMax-VL-01" },
          { provider: "stepfun", model: "step-1v-8k" },
        ];

        let selectedProvider = providerParam ?? options?.defaultProvider;
        let selectedModel = modelParam ?? options?.defaultModel;

        if (!selectedProvider || !selectedModel) {
          for (const vm of visionCandidates) {
            if (isProviderAvailable(vm.provider)) {
              selectedProvider = vm.provider;
              selectedModel = vm.model;
              break;
            }
          }
        }

        if (!selectedProvider || !selectedModel) {
          return errorResult("No vision-capable model provider available");
        }

        const piModel = resolveModel(selectedProvider, selectedModel);
        if (!piModel) {
          return errorResult(`Cannot resolve model ${selectedProvider}/${selectedModel}`);
        }

        const apiKey = getApiKeyForProvider(selectedProvider);

        // 构建用户消息（包含图片信息）
        const userContent = imageData.url
          ? `${prompt}\n\n![image](${imageData.url})`
          : `${prompt}\n\n[Attached image: ${imageData.mediaType}, base64 length=${imageData.base64?.length}]`;

        const response = await completeSimple(piModel, {
          messages: [{ role: "user" as const, content: userContent, timestamp: Date.now() }],
          tools: [],
        }, {
          apiKey,
          maxTokens: 2048,
        });

        const assistantText = response.content
          ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("") ?? "";

        return jsonResult({
          status: "success",
          provider: selectedProvider,
          model: selectedModel,
          prompt,
          analysis: assistantText,
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}