/**
 * SKILL.md 文件解析器
 * 解析 YAML frontmatter 和 markdown 内容
 */

import { readFile } from 'fs/promises';
import { basename, dirname } from 'path';
import { parse as parseYaml } from 'yaml';
import type { SkillEntry, SkillFrontmatter, SkillSource } from './types.js';

/**
 * 解析 SKILL.md 文件内容
 */
export function parseSkillContent(
  content: string,
  filePath: string,
  source: SkillSource
): SkillEntry | null {
  const trimmedContent = content.trim();

  // 检查是否有 frontmatter
  if (!trimmedContent.startsWith('---')) {
    // 没有 frontmatter，使用文件名作为 skill 名称
    const name = basename(dirname(filePath));
    return {
      frontmatter: { name },
      content: trimmedContent,
      filePath,
      source,
    };
  }

  // 查找 frontmatter 结束位置
  const endIndex = trimmedContent.indexOf('---', 3);
  if (endIndex === -1) {
    // frontmatter 格式错误
    console.warn(`Invalid frontmatter in ${filePath}`);
    return null;
  }

  // 解析 frontmatter
  const yamlContent = trimmedContent.slice(3, endIndex).trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(yamlContent) ?? {};
  } catch {
    console.warn(`Failed to parse YAML frontmatter in ${filePath}`);
    return null;
  }

  // 构建 frontmatter 对象
  const frontmatter: SkillFrontmatter = {
    name: (parsed.name as string) || basename(dirname(filePath)),
    title: parsed.title as string | undefined,
    description: parsed.description as string | undefined,
    version: parsed.version as string | undefined,
    author: parsed.author as string | undefined,
    enabled: parsed.enabled !== false, // 默认启用
    tags: parsed.tags as string[] | undefined,
    priority: parsed.priority as number | undefined,
  };

  // 解析 eligibility（直接声明优先）
  if (parsed.eligibility && typeof parsed.eligibility === 'object') {
    frontmatter.eligibility = parsed.eligibility as SkillFrontmatter['eligibility'];
  } else {
    // 尝试解析顶级 eligibility 字段
    if (parsed.os || parsed.binaries || parsed.envVars) {
      frontmatter.eligibility = {
        os: parsed.os as string[] | undefined,
        binaries: parsed.binaries as string[] | undefined,
        envVars: parsed.envVars as string[] | undefined,
      };
    }
  }

  // 兼容 moltbot 格式: metadata.openclaw.requires → eligibility
  if (!frontmatter.eligibility) {
    const metadata = parsed.metadata as Record<string, unknown> | undefined;
    const openclaw = metadata?.openclaw as Record<string, unknown> | undefined;
    const requires = openclaw?.requires as Record<string, unknown> | undefined;
    if (requires) {
      frontmatter.eligibility = {
        binaries: requires.bins as string[] | undefined,
        envVars: requires.env as string[] | undefined,
      };
    }
  }

  // 提取 markdown 内容
  const markdownContent = trimmedContent.slice(endIndex + 3).trim();

  return {
    frontmatter,
    content: markdownContent,
    filePath,
    source,
  };
}

/**
 * 从文件路径解析 Skill
 */
export async function parseSkillFile(
  filePath: string,
  source: SkillSource
): Promise<SkillEntry | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return parseSkillContent(content, filePath, source);
  } catch (error) {
    console.error(`Failed to parse skill file ${filePath}:`, error);
    return null;
  }
}
