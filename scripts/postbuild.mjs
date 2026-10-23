#!/usr/bin/env node
/**
 * 构建后处理：
 * 1. 把 Web UI 资源复制到 dist（tsc 只编译 .ts）
 * 2. 给 CLI 入口补上可执行位（tsc 输出固定是 0644，会让全局链接 `mozi` 报 permission denied）
 */
import { cpSync, existsSync, mkdirSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const uiSource = join(root, "src", "web", "ui");
const uiTarget = join(root, "dist", "web", "ui");

if (!existsSync(uiSource)) {
  console.error(`UI source missing: ${uiSource}`);
  process.exit(1);
}

mkdirSync(uiTarget, { recursive: true });
cpSync(uiSource, uiTarget, { recursive: true });
console.log(`Copied web UI -> ${uiTarget}`);

const cliEntry = join(root, "dist", "cli", "index.js");
if (existsSync(cliEntry)) {
  chmodSync(cliEntry, 0o755);
  console.log(`Set executable bit -> ${cliEntry}`);
} else {
  console.error(`CLI entry missing: ${cliEntry}`);
  process.exit(1);
}
