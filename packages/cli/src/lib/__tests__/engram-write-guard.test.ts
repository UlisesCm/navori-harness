import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { NavoriConfigSchema, type NavoriConfig } from "../config/schema.ts";
import { renderCodexEngine } from "../../engines/codex/index.ts";
import { renderClaudeEngine } from "../../engines/claude/index.ts";
import { engramGrantsByRole } from "../../engines/shared/engram-grant-policy.ts";
import { ROSTER_AGENTS } from "../../engines/shared/roster.ts";
import { getFrontmatterField, splitFrontmatter, splitToolList } from "../render/frontmatter.ts";
import { acrossShells } from "./helpers/shells.ts";

/**
 * Behavioral tests for `engram-write-guard.sh`. Each case renders the REAL Codex
 * hook (includes expanded, `{{engramPolicy}}` compiled from the Claude grants)
 * into a temp repo and drives it with a PreToolUse payload on stdin, under every
 * available shell (#391).
 */
function config(extra: Record<string, unknown> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "engram-guard-demo",
    engines: ["codex"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
    plugins: { engram: { enabled: true } },
    ...extra,
  });
}

let repo: string;
let script: string;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "navori-engram-guard-")));
  renderCodexEngine(repo, config());
  script = join(repo, ".codex/hooks/engram-write-guard.sh");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

interface Outcome {
  status: number;
  stderr: string;
}

function run(role: string | undefined, tool: string): Outcome {
  return acrossShells((shell) => {
    const r = spawnSync(shell, [script], {
      cwd: repo,
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: repo,
        tool_name: tool,
        tool_input: {},
        ...(role === undefined ? {} : { agent_type: role }),
      }),
      encoding: "utf-8",
    });
    return { status: r.status ?? -1, stderr: r.stderr ?? "" };
  });
}

const ALLOW = 0;
const DENY = 2;
const READS = ["mem_search", "mem_get_observation"];
const WRITES = ["mem_save", "mem_update", "mem_session_summary", "mem_judge", "mem_context"];

// Covers: A1
describe("engram-write-guard — main thread", () => {
  it("never blocks the main thread (no agent_type), whatever the tool", () => {
    for (const t of [...READS, ...WRITES]) {
      expect(run(undefined, `mcp__engram__${t}`).status, t).toBe(ALLOW);
    }
  });
});

// Covers: A1
describe("engram-write-guard — role allowlists", () => {
  it("auditor reads and saves, but cannot close the session or update", () => {
    for (const t of [...READS, "mem_save"]) {
      expect(run("auditor", `mcp__engram__${t}`).status, t).toBe(ALLOW);
    }
    for (const t of ["mem_session_summary", "mem_update", "mem_judge", "mem_context"]) {
      expect(run("auditor", `mcp__engram__${t}`).status, t).toBe(DENY);
    }
  });

  it("implementer, reviewer and scout read only", () => {
    for (const role of ["implementer", "reviewer", "scout"]) {
      for (const t of READS)
        expect(run(role, `mcp__engram__${t}`).status, `${role} ${t}`).toBe(ALLOW);
      for (const t of WRITES)
        expect(run(role, `mcp__engram__${t}`).status, `${role} ${t}`).toBe(DENY);
    }
  });

  it("architect, publisher and scribe get no engram tool at all, reads included", () => {
    for (const role of ["architect", "publisher", "scribe"]) {
      for (const t of [...READS, ...WRITES]) {
        expect(run(role, `mcp__engram__${t}`).status, `${role} ${t}`).toBe(DENY);
      }
    }
  });

  it("default and unknown roles are read-only", () => {
    for (const role of ["default", "worker", "something-new"]) {
      for (const t of READS)
        expect(run(role, `mcp__engram__${t}`).status, `${role} ${t}`).toBe(ALLOW);
      for (const t of WRITES)
        expect(run(role, `mcp__engram__${t}`).status, `${role} ${t}`).toBe(DENY);
    }
  });

  it("decides by tool suffix, so the plugin-prefixed name gets the same verdict", () => {
    expect(run("auditor", "mcp__plugin_engram_engram__mem_save").status).toBe(ALLOW);
    expect(run("scout", "mcp__plugin_engram_engram__mem_save").status).toBe(DENY);
  });

  it("ignores tools that are not engram's", () => {
    expect(run("scribe", "mcp__codegraph__codegraph_explore").status).toBe(ALLOW);
    expect(run("scribe", "Bash").status).toBe(ALLOW);
  });
});

// Covers: A1
describe("engram-write-guard — deny message", () => {
  it("names the hook, tool and role and tells the model not to retry or switch tools", () => {
    const r = run("default", "mcp__engram__mem_save");
    expect(r.status).toBe(DENY);
    expect(r.stderr).toContain("BLOCKED by engram-write-guard");
    expect(r.stderr).toContain("mem_save");
    expect(r.stderr).toContain("default");
    expect(r.stderr).toContain("do NOT retry");
    expect(r.stderr).toContain("another memory tool");
    expect(r.stderr).not.toMatch(/handoff/i);
  });
});

// Covers: A1
describe("engram grant parity with Claude", () => {
  it("compiled Codex grants equal the mcp__engram__ entries Claude renders per role", () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-engram-parity-")));
    try {
      renderClaudeEngine(cwd, config({ engines: ["claude"] }));
      const grants = engramGrantsByRole();
      for (const agent of ROSTER_AGENTS) {
        const file = join(cwd, ".claude/agents", `${agent.id}.md`);
        const declared = getFrontmatterField(
          splitFrontmatter(readFileSync(file, "utf-8")).frontmatter,
          "tools",
        );
        const claude = splitToolList(declared ?? "")
          .filter((t) => t.startsWith("mcp__engram__"))
          .map((t) => t.slice("mcp__engram__".length))
          .sort();
        expect(grants[agent.id], agent.id).toEqual(claude);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
