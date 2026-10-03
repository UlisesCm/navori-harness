import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { NavoriConfigSchema, type NavoriConfig } from "../config/schema.ts";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { renderCodexEngine } from "../../engines/codex/index.ts";
import { renderClaudeEngine } from "../../engines/claude/index.ts";
import { buildRolePolicyShell } from "../../engines/shared/role-policy.ts";
import { acrossShells } from "./helpers/shells.ts";

/**
 * Behavioral tests for `role-guard.sh` (spec 0041 T8/T9). Each case renders the
 * REAL Codex hook (includes expanded, `{{rolePolicy}}` compiled from the roster)
 * into a temp repo and drives it with its PreToolUse payload on stdin, under
 * every available shell (#391).
 */
const ASSET = resolve(getCoreRoot(), "core-assets/hooks/role-guard.sh");

function config(extra: Record<string, unknown> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "role-guard-demo",
    engines: ["codex"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
    ...extra,
  });
}

let repo: string;
let script: string;

function install(cfg: NavoriConfig = config()): void {
  renderCodexEngine(repo, cfg);
  script = join(repo, ".codex/hooks/role-guard.sh");
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "navori-role-guard-")));
  install();
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

interface Outcome {
  status: number;
  stderr: string;
}

function run(payload: Record<string, unknown>): Outcome {
  return acrossShells((shell) => {
    const r = spawnSync(shell, [script], {
      cwd: repo,
      input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: repo, ...payload }),
      encoding: "utf-8",
    });
    return { status: r.status ?? -1, stderr: r.stderr ?? "" };
  });
}

/** An `apply_patch` call touching `files` (one `Add File` header each). */
function patch(role: string | undefined, ...files: string[]): Record<string, unknown> {
  const command = [
    "*** Begin Patch",
    ...files.flatMap((f) => [`*** Add File: ${f}`, "+x"]),
    "*** End Patch",
  ].join("\n");
  return {
    tool_name: "apply_patch",
    tool_input: { command },
    ...(role === undefined ? {} : { agent_type: role }),
  };
}

const HANDOFF = ".navori/state/handoffs/impl_x.json";

// Covers: R6, R8
describe("role-guard apply_patch — allowed callers", () => {
  it("lets the main thread (no agent_type) patch anything", () => {
    expect(run(patch(undefined, "src/app.ts")).status).toBe(0);
  });

  it("lets implementer and scribe patch outside any role prefix", () => {
    expect(run(patch("implementer", "src/app.ts", "README.md")).status).toBe(0);
    expect(run(patch("scribe", "docs/a.md")).status).toBe(0);
  });

  it("ignores tools it does not cover", () => {
    const r = run({
      tool_name: "Bash",
      tool_input: { command: "echo hi > src/a.ts" },
      agent_type: "reviewer",
    });
    expect(r.status).toBe(0);
  });
});

// Covers: R6, R7
describe("role-guard apply_patch — role containment", () => {
  it("lets a restricted role patch its handoff and denies other paths naming role and path", () => {
    expect(run(patch("reviewer", HANDOFF)).status).toBe(0);
    const r = run(patch("reviewer", "src/app.ts"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("BLOCKED by role-guard");
    expect(r.stderr).toContain("reviewer");
    expect(r.stderr).toContain("src/app.ts");
  });

  it("denies a multi-file patch when ONE file is outside the role", () => {
    const r = run(patch("reviewer", HANDOFF, "src/app.ts"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("src/app.ts");
  });

  it("gives scout, auditor and architect the specs dir; reviewer and publisher not", () => {
    for (const role of ["scout", "auditor", "architect"]) {
      expect(run(patch(role, "specs/0001/design.md")).status, role).toBe(0);
    }
    for (const role of ["reviewer", "publisher"]) {
      expect(run(patch(role, "specs/0001/design.md")).status, role).toBe(2);
    }
  });

  it("compares by path component, not by text prefix", () => {
    expect(run(patch("scout", "specs-evil/a.md")).status).toBe(2);
    expect(run(patch("scout", ".navori/state/handoffs-x/a.json")).status).toBe(2);
  });

  it("takes the specs dir from sdd.specsDir", () => {
    install(config({ sdd: { specsDir: "docs/specs" } }));
    expect(run(patch("scout", "docs/specs/a.md")).status).toBe(0);
    expect(run(patch("scout", "specs/a.md")).status).toBe(2);
  });

  it("fails closed for the default and an unknown role", () => {
    for (const role of ["default", "mystery-role"]) {
      expect(run(patch(role, HANDOFF)).status, role).toBe(0);
      const denied = run(patch(role, "src/app.ts"));
      expect(denied.status, role).toBe(2);
      expect(denied.stderr).toContain(role);
      expect(run(patch(role, "specs/a.md")).status, role).toBe(2);
    }
  });

  it("lets a restricted role patch OS temp files", () => {
    expect(run(patch("reviewer", join(tmpdir(), "scratch.txt"))).status).toBe(0);
    expect(run(patch("reviewer", "/tmp/scratch.txt")).status).toBe(0);
  });
});

// Covers: R6
describe("role-guard apply_patch — path escapes", () => {
  it("denies a `..` that leaves the repo", () => {
    const up = "../".repeat(40);
    const r = run(patch("reviewer", `.navori/state/handoffs/${up}etc/passwd`));
    expect(r.status).toBe(2);
  });

  it("folds `..` inside the repo before comparing", () => {
    expect(run(patch("scout", "specs/../.navori/state/handoffs/ok.json")).status).toBe(0);
    expect(run(patch("reviewer", ".navori/state/handoffs/../../../src/x.ts")).status).toBe(2);
  });

  it("denies a symlink that leaves the repo", () => {
    mkdirSync(join(repo, ".navori/state/handoffs"), { recursive: true });
    symlinkSync("/etc", join(repo, ".navori/state/handoffs/out"));
    const r = run(patch("reviewer", ".navori/state/handoffs/out/hosts"));
    expect(r.status).toBe(2);
  });

  it("denies a leaf symlink pointing outside the repo", () => {
    mkdirSync(join(repo, ".navori/state/handoffs"), { recursive: true });
    symlinkSync("/etc/hosts", join(repo, ".navori/state/handoffs/leaf.json"));
    expect(run(patch("reviewer", ".navori/state/handoffs/leaf.json")).status).toBe(2);
  });

  it("denies an in-repo symlink that lands outside the role's prefixes", () => {
    mkdirSync(join(repo, ".navori/state/handoffs"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    symlinkSync(join(repo, "src"), join(repo, ".navori/state/handoffs/to-src"));
    expect(run(patch("reviewer", ".navori/state/handoffs/to-src/a.ts")).status).toBe(2);
  });
});

// Covers: R17, R31
describe("role-guard spawn branch", () => {
  const spawn = (tool: string, caller?: string, target = "implementer") => ({
    tool_name: tool,
    tool_input: { agent_type: target, message: "go" },
    ...(caller === undefined ? {} : { agent_type: caller }),
  });

  it("denies a spawn from a subagent, naming the caller role", () => {
    const r = run(spawn("spawn_agent", "architect"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("architect");
    expect(r.stderr).toContain("BLOCKED by role-guard");
  });

  it("denies a spawn from implementer and scribe too, and under a V2 tool name", () => {
    expect(run(spawn("spawn_agent", "implementer")).status).toBe(2);
    expect(run(spawn("collaborationspawn_agent", "scribe")).status).toBe(2);
    expect(run(spawn("spawn_agent", "default")).status).toBe(2);
  });

  it("allows a spawn from the main thread even when it targets a typed agent", () => {
    expect(run(spawn("spawn_agent")).status).toBe(0);
    expect(run(spawn("collaborationspawn_agent", undefined, "reviewer")).status).toBe(0);
  });
});

// Covers: R7
describe("role-guard policy source", () => {
  it("renders the fragment buildRolePolicyShell compiles and keeps the asset free of prefixes", () => {
    const rendered = readFileSync(script, "utf-8");
    expect(rendered).toContain(buildRolePolicyShell(config()));
    expect(rendered).not.toContain("{{rolePolicy}}");
    const asset = readFileSync(ASSET, "utf-8");
    expect(asset).toContain("{{rolePolicy}}");
    expect(asset).not.toContain(".navori/state/handoffs");
    expect(asset).not.toContain("specs/");
  });

  it("compiles roster writes into one arm per role with the common set as default", () => {
    const shell = buildRolePolicyShell(config());
    expect(shell).toContain("scout) printf '%s\\n' '.navori/state/handoffs/' 'specs/' ;;");
    expect(shell).toContain("reviewer) printf '%s\\n' '.navori/state/handoffs/' ;;");
    expect(shell).toContain("*) printf '%s\\n' '.navori/state/handoffs/' ;;");
    expect(shell).not.toContain("implementer)");
  });

  it("never lets an empty specsDir open the repo root to a restricted role", () => {
    const shell = buildRolePolicyShell(config({ sdd: { specsDir: "." } }));
    expect(shell).not.toMatch(/'\/'/);
    expect(shell).not.toContain("''");
  });

  it("quotes a hostile specsDir as one literal token", () => {
    const shell = buildRolePolicyShell(config({ sdd: { specsDir: "x'; touch /tmp/pwn; '" } }));
    expect(shell).toContain("'x'\\''; touch /tmp/pwn; '\\''/'");
  });

  it("is absent from the Claude render", () => {
    const claudeRepo = mkdtempSync(join(tmpdir(), "navori-role-guard-claude-"));
    try {
      renderClaudeEngine(claudeRepo, config({ engines: ["claude"] }));
      expect(existsSync(join(claudeRepo, ".claude/hooks/role-guard.sh"))).toBe(false);
    } finally {
      rmSync(claudeRepo, { recursive: true, force: true });
    }
  });
});

// Covers: R17
describe("hook-input spawn helpers never confuse caller and child (H16)", () => {
  function probe(payload: Record<string, unknown>, fn: string): string {
    const dir = join(repo, ".codex/hooks");
    const path = join(dir, "probe.sh");
    const partials = resolve(getCoreRoot(), "core-assets/hooks/_partials");
    writeFileSync(
      path,
      `payload=$(cat)\n${readFileSync(join(partials, "extract-cmd.sh"), "utf-8")}\n${readFileSync(
        join(partials, "hook-input.sh"),
        "utf-8",
      )}\n${fn}\n`,
    );
    const r = spawnSync("bash", [path], {
      cwd: repo,
      input: JSON.stringify(payload),
      encoding: "utf-8",
    });
    return r.stdout.trim();
  }

  it("reads the child from tool_input and the caller from the top level", () => {
    const pre = {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      agent_type: "architect",
      tool_input: { agent_type: "implementer" },
    };
    expect(probe(pre, "nv_spawn_target_type")).toBe("implementer");
    expect(probe(pre, "nv_event_agent_type")).toBe("architect");
    expect(probe(pre, "nv_is_spawn_tool && printf yes")).toBe("yes");
    expect(probe({ ...pre, tool_input: { message: "go" } }, "nv_spawn_target_type")).toBe("");
  });

  it("reads the finishing subagent on SubagentStop and recognizes V2 names", () => {
    const stop = { hook_event_name: "SubagentStop", agent_type: "scout" };
    expect(probe(stop, "nv_spawn_target_type")).toBe("scout");
    expect(probe({ tool_name: "ns_spawn_agent" }, "nv_is_spawn_tool && printf yes")).toBe("yes");
    expect(probe({ tool_name: "apply_patch" }, "nv_is_spawn_tool || printf no")).toBe("no");
  });
});
