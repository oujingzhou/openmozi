#!/usr/bin/env node
/**
 * 构建前清空 dist
 *
 * tsc 只增不删：源码删掉的模块会以旧编译产物留在 dist 里，
 * 随后被 npm pack 一并打进 tarball。用 node 实现以保证 Windows 可用。
 */
import { rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
console.log(`Cleaned ${dist}`);
