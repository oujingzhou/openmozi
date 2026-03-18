/**
 * 内置工具 - apply_patch 差异修补工具
 */

import { Type } from "@sinclair/typebox";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { resolve, dirname, sep } from "path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { jsonResult, readStringParam } from "../common.js";

interface PatchHunk { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[]; }
interface FilePatch { oldPath: string; newPath: string; hunks: PatchHunk[]; isNew: boolean; isDelete: boolean; }

function parsePatch(patchText: string): FilePatch[] {
  const patches: FilePatch[] = [];
  const lines = patchText.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (!lines[i]?.startsWith("---")) { i++; continue; }
    const oldPathLine = lines[i]!; i++;
    if (i >= lines.length || !lines[i]?.startsWith("+++")) continue;
    const newPathLine = lines[i]!; i++;
    const oldPath = oldPathLine.replace(/^---\s+/, "").replace(/^a\//, "").replace(/\t.*$/, "");
    const newPath = newPathLine.replace(/^\+\+\+\s+/, "").replace(/^b\//, "").replace(/\t.*$/, "");
    const isNew = oldPath === "/dev/null";
    const isDelete = newPath === "/dev/null";
    const hunks: PatchHunk[] = [];
    while (i < lines.length && lines[i]?.startsWith("@@")) {
      const hunkHeader = lines[i]!;
      const match = hunkHeader.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) { i++; continue; }
      const hunk: PatchHunk = { oldStart: parseInt(match[1]!, 10), oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1, newStart: parseInt(match[3]!, 10), newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1, lines: [] };
      i++;
      while (i < lines.length) {
        const line = lines[i]!;
        if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) break;
        if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "") { hunk.lines.push(line); i++; }
        else break;
      }
      hunks.push(hunk);
    }
    patches.push({ oldPath, newPath, hunks, isNew, isDelete });
  }
  return patches;
}

function applyHunk(lines: string[], hunk: PatchHunk): string[] | null {
  const result = [...lines];
  let offset = hunk.oldStart - 1;
  const contextLines = hunk.lines.filter(l => l.startsWith(" ") || l.startsWith("-")).map(l => l.slice(1));
  let matchOffset = -1;
  for (let delta = 0; delta <= 50; delta++) {
    for (const sign of [0, -1, 1]) {
      const tryOffset = offset + delta * (sign === 0 ? 0 : sign);
      if (tryOffset < 0 || tryOffset > result.length) continue;
      let matches = true;
      for (let ci = 0; ci < contextLines.length; ci++) {
        if (tryOffset + ci >= result.length || result[tryOffset + ci] !== contextLines[ci]) { matches = false; break; }
      }
      if (matches) { matchOffset = tryOffset; break; }
    }
    if (matchOffset >= 0) break;
  }
  if (matchOffset < 0) return null;
  const newLines: string[] = [];
  let srcIdx = matchOffset;
  for (const line of hunk.lines) {
    if (line.startsWith(" ")) { newLines.push(result[srcIdx]!); srcIdx++; }
    else if (line.startsWith("-")) srcIdx++;
    else if (line.startsWith("+")) newLines.push(line.slice(1));
    else if (line === "" && srcIdx < result.length) { newLines.push(result[srcIdx]!); srcIdx++; }
  }
  return [...result.slice(0, matchOffset), ...newLines, ...result.slice(srcIdx)];
}

export function createApplyPatchTool(allowedPaths?: string[]): AgentTool {
  const allowed = allowedPaths ?? [process.cwd()];
  function isPathAllowed(filePath: string): boolean {
    const resolved = resolve(filePath);
    return allowed.some(a => { const ra = resolve(a); return resolved === ra || resolved.startsWith(ra + sep); });
  }
  return {
    name: "apply_patch",
    label: "Apply Patch",
    description: "Apply a unified diff patch to one or more files.",
    parameters: Type.Object({ patch: Type.String({ description: "The unified diff patch to apply" }) }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const patchText = readStringParam(params, "patch", { required: true })!;
      try {
        const patches = parsePatch(patchText);
        if (patches.length === 0) return jsonResult({ status: "error", error: "No valid patches found" }, true);
        const results: Array<{ file: string; status: string; error?: string }> = [];
        for (const patch of patches) {
          const targetPath = patch.isNew ? patch.newPath : patch.oldPath;
          const resolvedPath = resolve(targetPath);
          if (!isPathAllowed(resolvedPath)) { results.push({ file: targetPath, status: "error", error: `Access denied: ${targetPath}` }); continue; }
          try {
            if (patch.isDelete) {
              if (existsSync(resolvedPath)) { const { unlink } = await import("fs/promises"); await unlink(resolvedPath); results.push({ file: targetPath, status: "deleted" }); }
              else results.push({ file: targetPath, status: "skipped", error: "File not found" });
              continue;
            }
            if (patch.isNew) {
              const dir = dirname(resolvedPath);
              if (!existsSync(dir)) await mkdir(dir, { recursive: true });
              const newContent = patch.hunks.flatMap(h => h.lines.filter(l => l.startsWith("+") || l.startsWith(" ")).map(l => l.slice(1))).join("\n");
              await writeFile(resolvedPath, newContent, "utf-8");
              results.push({ file: targetPath, status: "created" });
              continue;
            }
            if (!existsSync(resolvedPath)) { results.push({ file: targetPath, status: "error", error: "File not found" }); continue; }
            const content = await readFile(resolvedPath, "utf-8");
            let lines = content.split("\n");
            const sortedHunks = [...patch.hunks].sort((a, b) => b.oldStart - a.oldStart);
            let allApplied = true;
            for (const hunk of sortedHunks) {
              const result = applyHunk(lines, hunk);
              if (result === null) { allApplied = false; results.push({ file: targetPath, status: "error", error: `Failed to apply hunk at line ${hunk.oldStart}` }); break; }
              lines = result;
            }
            if (allApplied) { await writeFile(resolvedPath, lines.join("\n"), "utf-8"); results.push({ file: targetPath, status: "applied" }); }
          } catch (error) { results.push({ file: targetPath, status: "error", error: error instanceof Error ? error.message : String(error) }); }
        }
        const hasErrors = results.some(r => r.status === "error");
        return jsonResult({ status: hasErrors ? "partial" : "success", patches: results }, hasErrors);
      } catch (error) { return jsonResult({ status: "error", error: error instanceof Error ? error.message : String(error) }, true); }
    },
  };
}