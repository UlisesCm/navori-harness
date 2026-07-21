import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SKILL_DIR_ENTRY } from "./skill-meta.ts";

export interface ClaudeInfraInventory {
  /** Has anything Claude-related at all (any of the fields below is truthy). */
  present: boolean;
  agentFiles: string[];
  skillFiles: string[];
  hasSettings: boolean;
  hasLocalSettings: boolean;
  hasClaudeMd: boolean;
  hasAgentsMd: boolean;
  hasCheckpointsMd: boolean;
  hasFeatureList: boolean;
  progressFiles: number;
  specsDirs: number;
  hasNavoriConfig: boolean;
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function listMarkdownFiles(dir: string): string[] {
  return safeReaddir(dir).filter((f) => f.endsWith(".md"));
}

function listSkillDirs(dir: string): string[] {
  const result: string[] = [];
  for (const entry of safeReaddir(dir)) {
    const full = join(dir, entry);
    try {
      if (statSync(full).isDirectory()) {
        // Skill directories contain SKILL.md (shared convention)
        if (existsSync(join(full, SKILL_DIR_ENTRY))) result.push(entry);
      } else if (entry.endsWith(".md")) {
        // Flat skill files (.claude/skills/<name>.md)
        result.push(entry);
      }
    } catch {
      // ignore
    }
  }
  return result;
}

function countFilesIn(dir: string): number {
  let count = 0;
  for (const entry of safeReaddir(dir)) {
    try {
      if (statSync(join(dir, entry)).isFile()) count++;
    } catch {
      // ignore
    }
  }
  return count;
}

function countSubdirs(dir: string): number {
  let count = 0;
  for (const entry of safeReaddir(dir)) {
    try {
      if (statSync(join(dir, entry)).isDirectory()) count++;
    } catch {
      // ignore
    }
  }
  return count;
}

/**
 * Inspect the current directory for any existing Claude Code / agent
 * infrastructure (.claude/, CLAUDE.md, AGENTS.md, CHECKPOINTS.md, progress/,
 * specs/, feature_list.json). Used by init to decide whether to coexist or
 * offer a replace-with-backup flow.
 */
export function detectClaudeInfra(cwd: string): ClaudeInfraInventory {
  const claudeDir = join(cwd, ".claude");
  const agentsDir = join(claudeDir, "agents");
  const skillsDir = join(claudeDir, "skills");

  const agentFiles = listMarkdownFiles(agentsDir);
  const skillFiles = listSkillDirs(skillsDir);
  const hasSettings = existsSync(join(claudeDir, "settings.json"));
  const hasLocalSettings = existsSync(join(claudeDir, "settings.local.json"));
  const hasClaudeMd = existsSync(join(cwd, "CLAUDE.md"));
  const hasAgentsMd = existsSync(join(cwd, "AGENTS.md"));
  const hasCheckpointsMd = existsSync(join(cwd, "CHECKPOINTS.md"));
  const hasFeatureList = existsSync(join(cwd, "feature_list.json"));
  const hasNavoriConfig = existsSync(join(cwd, "navori.config.json"));

  const progressFiles = existsSync(join(cwd, "progress"))
    ? countFilesIn(join(cwd, "progress"))
    : 0;
  const specsDirs = existsSync(join(cwd, "specs"))
    ? countSubdirs(join(cwd, "specs"))
    : 0;

  const present =
    agentFiles.length > 0 ||
    skillFiles.length > 0 ||
    hasSettings ||
    hasLocalSettings ||
    hasClaudeMd ||
    hasAgentsMd ||
    hasCheckpointsMd ||
    hasFeatureList ||
    progressFiles > 0 ||
    specsDirs > 0;

  return {
    present,
    agentFiles,
    skillFiles,
    hasSettings,
    hasLocalSettings,
    hasClaudeMd,
    hasAgentsMd,
    hasCheckpointsMd,
    hasFeatureList,
    progressFiles,
    specsDirs,
    hasNavoriConfig,
  };
}
