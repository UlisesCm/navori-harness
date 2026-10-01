/**
 * Spec 0039 R32 — is codegraph actually wired before anyone measures it?
 * Three checks, all read-only: the index is present and fresh, which agents
 * may call `codegraph_explore`, and the injected routing block tells callers
 * to pass the current checkout's `projectPath`. `doctor` diagnoses; it never
 * initializes or refreshes an index.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { NavoriConfig } from "../config/config.ts";
import { hasBinary } from "../primitives/which.ts";

export const CODEGRAPH_TOOL = "mcp__codegraph__codegraph_explore";
const CODEGRAPH_WILDCARD = "mcp__codegraph__*";

export type CodegraphIndexState =
  | { kind: "binary-missing" }
  | { kind: "missing" }
  | { kind: "stale"; reason: "reindex-recommended" | "pending-changes" | "worktree-mismatch" }
  | { kind: "fresh" }
  | { kind: "unknown" };

export interface CodegraphWiringReport {
  index: CodegraphIndexState;
  /** Agents whose rendered `tools` carry the grant (or the settings allow list does). */
  grantedAgents: string[];
  ungrantedAgents: string[];
  /** The routing block mentions `projectPath`; null when no instructions file exists. */
  projectPathRule: boolean | null;
}

/** Injectable probes so tests never spawn `codegraph`. */
export interface CodegraphWiringDeps {
  hasBinary: (name: string) => boolean;
  /** Raw stdout of `codegraph status --json <cwd>`; throws on failure. */
  runStatus: (cwd: string) => string;
}

const defaultDeps: CodegraphWiringDeps = {
  hasBinary,
  runStatus: (cwd) =>
    execFileSync("codegraph", ["status", "--json", cwd], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000, // best-effort external probe must not hang doctor (#268)
    }),
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Maps `codegraph status --json` to a freshness state. Pure. */
export function classifyCodegraphStatus(raw: string): CodegraphIndexState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unknown" };
  }
  if (!isObject(parsed)) return { kind: "unknown" };
  if (parsed.initialized === false) return { kind: "missing" };
  if (parsed.initialized !== true) return { kind: "unknown" };
  const index = isObject(parsed.index) ? parsed.index : null;
  if (index?.reindexRecommended === true) return { kind: "stale", reason: "reindex-recommended" };
  const pending = isObject(parsed.pendingChanges) ? parsed.pendingChanges : null;
  if (pending && Object.values(pending).some((n) => typeof n === "number" && n > 0)) {
    return { kind: "stale", reason: "pending-changes" };
  }
  if (isObject(parsed.worktreeMismatch)) return { kind: "stale", reason: "worktree-mismatch" };
  return { kind: "fresh" };
}

function toolsOf(markdown: string): string[] | null {
  const fm = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1];
  const line = fm?.split("\n").find((l) => l.startsWith("tools:"));
  if (line === undefined) return null;
  return line
    .slice("tools:".length)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function allowList(cwd: string): string[] {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(cwd, ".claude", "settings.json"), "utf-8"),
    );
    const allow =
      isObject(parsed) && isObject(parsed.permissions) ? parsed.permissions.allow : null;
    return Array.isArray(allow) ? allow.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}

const grants = (tools: readonly string[]): boolean =>
  tools.includes(CODEGRAPH_TOOL) || tools.includes(CODEGRAPH_WILDCARD);

/**
 * Runs the three checks. Returns null when the codegraph plugin is not
 * enabled: navori has no business evaluating a provider the repo never opted
 * into. A missing binary is informative (`binary-missing`), never an error.
 */
export function scanCodegraphWiring(
  cwd: string,
  config: NavoriConfig,
  deps: CodegraphWiringDeps = defaultDeps,
): CodegraphWiringReport | null {
  if (config.plugins?.codegraph?.enabled !== true) return null;

  let index: CodegraphIndexState;
  if (!deps.hasBinary("codegraph")) index = { kind: "binary-missing" };
  else {
    try {
      index = classifyCodegraphStatus(deps.runStatus(cwd));
    } catch {
      index = { kind: "unknown" };
    }
  }

  const allowed = grants(allowList(cwd));
  const grantedAgents: string[] = [];
  const ungrantedAgents: string[] = [];
  const agentsDir = join(cwd, ".claude", "agents");
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir)
      .filter((f) => f.endsWith(".md"))
      .sort()) {
      const tools = toolsOf(readFileSync(join(agentsDir, file), "utf-8"));
      // No `tools:` line means the agent inherits everything the session may call.
      const has = tools === null ? allowed : grants(tools) || allowed;
      (has ? grantedAgents : ungrantedAgents).push(file.slice(0, -".md".length));
    }
  }

  let projectPathRule: boolean | null = null;
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    projectPathRule = readFileSync(path, "utf-8").includes("projectPath");
    if (projectPathRule) break;
  }

  return { index, grantedAgents, ungrantedAgents, projectPathRule };
}

export type CodegraphWiringFinding =
  | { kind: "index"; state: CodegraphIndexState }
  | { kind: "no-grant" }
  | { kind: "ungranted-agents"; agents: string[] }
  | { kind: "projectpath-rule-missing" };

/** What is worth showing; a fresh index and full coverage are silent. */
export function codegraphWiringFindings(report: CodegraphWiringReport): CodegraphWiringFinding[] {
  const out: CodegraphWiringFinding[] = [];
  if (report.index.kind !== "fresh") out.push({ kind: "index", state: report.index });
  if (report.grantedAgents.length === 0 && report.ungrantedAgents.length > 0) {
    out.push({ kind: "no-grant" });
  } else if (report.ungrantedAgents.length > 0) {
    out.push({ kind: "ungranted-agents", agents: report.ungrantedAgents });
  }
  if (report.projectPathRule === false) out.push({ kind: "projectpath-rule-missing" });
  return out;
}
