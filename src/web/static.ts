/**
 * WebChat 页面与静态资源服务
 *
 * 页面模板与 CSS/JS 都是真实文件（src/web/ui/*），构建时由 copy-ui 脚本复制到 dist。
 * 这样客户端代码可以被工具链检查，而不是藏在模板字符串里。
 */

import type { IncomingMessage, ServerResponse } from "http";
import { readFileSync, existsSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { MoziConfig } from "../types/index.js";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("static");

const __dirname = dirname(fileURLToPath(import.meta.url));

/** UI 资源目录：dist/web/ui（构建后）或 src/web/ui（tsx 直跑） */
function resolveUiDir(): string {
  const candidates = [
    join(__dirname, "ui"),
    join(__dirname, "..", "..", "src", "web", "ui"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return candidates[0]!;
}

const UI_DIR = resolveUiDir();

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** 品牌图形（内联 SVG，避免额外请求） */
const MARK_SMALL = `<svg class="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
  <circle cx="16" cy="16" r="15" fill="currentColor" opacity="0.10"/>
  <path d="M9 12.5 12 8l3 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M20 12.5 23 8l-3 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  <ellipse cx="16" cy="18.5" rx="8" ry="6.5" fill="currentColor" opacity="0.85"/>
  <circle cx="13" cy="17.5" r="1.3" fill="var(--bg-base)"/>
  <circle cx="19" cy="17.5" r="1.3" fill="var(--bg-base)"/>
</svg>`;

const MARK_HERO = `<svg class="hero-mark" viewBox="0 0 80 80" fill="none" aria-hidden="true">
  <defs>
    <linearGradient id="mz-hero" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="var(--brand)"/>
      <stop offset="100%" stop-color="var(--state-business)" stop-opacity="0.55"/>
    </linearGradient>
  </defs>
  <circle cx="40" cy="40" r="37" fill="url(#mz-hero)" opacity="0.12"/>
  <path d="M20 31 27 18l7 11" stroke="url(#mz-hero)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M53 29 60 18l-7 13" stroke="url(#mz-hero)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <ellipse cx="40" cy="47" rx="21" ry="17" fill="url(#mz-hero)" opacity="0.9"/>
  <ellipse cx="32" cy="44" rx="3.4" ry="4.4" fill="var(--bg-base)"/>
  <ellipse cx="48" cy="44" rx="3.4" ry="4.4" fill="var(--bg-base)"/>
  <circle cx="33" cy="42.5" r="1.2" fill="var(--label-primary)"/>
  <circle cx="49" cy="42.5" r="1.2" fill="var(--label-primary)"/>
</svg>`;

/** 渲染页面模板（只做占位替换，不做字符串拼接的 HTML 构造） */
function renderTemplate(template: string, config: MoziConfig): string {
  const replacements: Record<string, string> = {
    __TITLE__: "墨子 - AI 助手",
    __ASSISTANT_NAME__: "墨子",
    __MARK_SMALL__: MARK_SMALL,
    __MARK_HERO__: JSON.stringify(MARK_HERO),
    __PROVIDER__: config.agent.defaultProvider,
    __MODEL__: config.agent.defaultModel,
  };

  let html = template;
  for (const [token, value] of Object.entries(replacements)) {
    html = html.split(token).join(value);
  }
  return html;
}

/**
 * 资源缓存标识。
 * 用 mtime+size 而不是固定 max-age：文件一改，URL 就变，
 * 既能让浏览器长期缓存，又不会在升级后继续用旧脚本。
 */
function assetVersion(filePath: string): string {
  try {
    const stat = statSync(filePath);
    return `${stat.size.toString(36)}${Math.floor(stat.mtimeMs).toString(36)}`;
  } catch {
    return "0";
  }
}

function sendFile(res: ServerResponse, filePath: string, versioned = false): boolean {
  if (!existsSync(filePath)) return false;
  const ext = filePath.slice(filePath.lastIndexOf("."));
  const mime = MIME_TYPES[ext] ?? "application/octet-stream";
  const body = readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": body.length,
    "Cache-Control": versioned ? "public, max-age=31536000, immutable" : "no-cache",
  });
  res.end(body);
  return true;
}

/** 给页面里的 /assets/xxx 加上版本查询串 */
function versionAssets(html: string): string {
  return html.replace(/\/assets\/([a-zA-Z0-9._-]+)/g, (_match, name: string) => {
    const version = assetVersion(join(UI_DIR, name));
    return `/assets/${name}?v=${version}`;
  });
}

export interface StaticServerOptions {
  config: MoziConfig;
}

/**
 * 处理静态请求。
 * 返回 true 表示已响应；false 交给后续中间件。
 */
export function handleStaticRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: StaticServerOptions
): boolean {
  const url = req.url || "/";
  const pathname = (url.split("?")[0] || "/").replace(/\/+$/, "") || "/";

  // 交给 WebSocket / API / webhook 处理
  if (
    pathname === "/ws" ||
    pathname === "/health" ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/webhook/") ||
    pathname.startsWith("/feishu/") ||
    pathname.startsWith("/dingtalk/") ||
    pathname.startsWith("/wecom/")
  ) {
    return false;
  }

  // 资源文件
  if (pathname.startsWith("/assets/")) {
    const name = pathname.slice("/assets/".length);
    // 只允许平面文件名，禁止路径穿越
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad asset path");
      return true;
    }
    // 带 ?v= 的请求可以长期缓存；裸请求也照常返回
    if (sendFile(res, join(UI_DIR, name), true)) return true;
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return true;
  }

  // 控制台（与主页面共用模板占位替换与资源版本号）
  if (pathname === "/control") {
    const templatePath = join(UI_DIR, "control.html");
    if (!existsSync(templatePath)) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Control UI unavailable: run `npm run build`");
      return true;
    }
    const html = versionAssets(
      renderTemplate(readFileSync(templatePath, "utf-8"), options.config)
    );
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(html),
      "Cache-Control": "no-cache",
    });
    res.end(html);
    return true;
  }

  // 主页面
  if (pathname === "/" || pathname === "/index.html") {
    const templatePath = join(UI_DIR, "index.html");
    if (!existsSync(templatePath)) {
      logger.error({ templatePath, uiDir: UI_DIR }, "Web UI template missing");
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Web UI unavailable: run `npm run build`");
      return true;
    }
    const html = versionAssets(
      renderTemplate(readFileSync(templatePath, "utf-8"), options.config)
    );
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(html),
      "Cache-Control": "no-cache",
    });
    res.end(html);
    return true;
  }

  return false;
}

/** 导出目录，供测试与构建脚本使用 */
export { UI_DIR };
