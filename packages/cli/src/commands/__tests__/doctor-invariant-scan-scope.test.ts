import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/config/schema.ts";
import { computeHealthVerdict } from "../doctor.ts";

// #1359: doctor's invariant scan must not walk nested agent worktrees or
// node_modules under an engine's text dirs (it overflowed V8's max string
// length). An invariant living only there must not satisfy the project.

type Engine = "claude" | "codex" | "pi";

function config(engine: Engine): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "scope",
    engines: [engine],
    preset: "custom",
    branchBase: "main",
    plugins: { engram: { enabled: true } },
  });
}

describe("doctor invariant scan scope (#1359)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  const setup = (file: string): string => {
    const cwd = mkdtempSync(join(tmpdir(), "navori-scan-scope-"));
    dirs.push(cwd);
    // Non-empty root prose so the invariant check runs, without the invariant.
    writeFileSync(join(cwd, "CLAUDE.md"), "# CLAUDE.md\n\nno protocol here\n");
    writeFileSync(join(cwd, "AGENTS.md"), "# AGENTS.md\n\nno protocol here\n");
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), "use mem_save to persist\n");
    return cwd;
  };
  const missing = (cwd: string, engine: Engine): string[] =>
    computeHealthVerdict(cwd, config(engine)).missingInvariants.map((m) => m.invariant);

  it("ignores an invariant present only inside .claude/worktrees", () => {
    const cwd = setup(".claude/worktrees/x/.claude/skills/foo/SKILL.md");
    expect(missing(cwd, "claude")).toContain("mem_save");
  });

  it("ignores an invariant present only inside node_modules under a text dir", () => {
    expect(missing(setup(".claude/node_modules/pkg/README.md"), "claude")).toContain("mem_save");
    expect(missing(setup(".pi/node_modules/pkg/README.md"), "pi")).toContain("mem_save");
  });

  it("control: finds the invariant in a legitimate skill file", () => {
    expect(missing(setup(".claude/skills/foo/SKILL.md"), "claude")).not.toContain("mem_save");
    expect(missing(setup(".agents/skills/foo/SKILL.md"), "codex")).not.toContain("mem_save");
    expect(missing(setup(".agents/skills/foo/SKILL.md"), "pi")).not.toContain("mem_save");
  });
});
