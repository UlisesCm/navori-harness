import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { writeConfig } from "../../lib/config/config.ts";
import { runRender } from "../render.ts";
import { computeHealthVerdict } from "../doctor.ts";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/config/schema.ts";

// #847: a plugin whose only output is `injectInto` sub-blocks (engram, since
// #841 moved its protocol from a `managed[]` CLAUDE.md block to
// injectInto-only skills) never materializes those sub-blocks inside a
// monorepo workspace under the default `workspaceHarness: "minimal"` — the
// target agent files (leader.md, implementer.md…) are deliberately not
// written there (spec 0018 R2); the sub-block lands one directory up, at the
// root. Checking the plugin's invariants against the workspace's OWN render
// was therefore permanently red by design, the same class #269 already
// guards against for prose-only engines.

function config(cwd: string, workspaceHarness?: "minimal" | "full"): NavoriConfig {
  const cfg = NavoriConfigSchema.parse({
    name: "monorepo-demo",
    engines: ["claude"],
    preset: "monorepo-turbopnpm",
    plugins: { engram: { enabled: true } },
    monorepo: {
      enabled: true,
      tool: "pnpm",
      workspaces: [{ name: "backend", path: "apps/backend" }],
      ...(workspaceHarness ? { workspaceHarness } : {}),
    },
  });
  mkdirSync(join(cwd, "apps/backend"), { recursive: true });
  writeConfig(join(cwd, "navori.config.json"), cfg);
  return cfg;
}

describe("plugin invariants over a monorepo workspace (#847)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), "navori-monorepo-inv-"));
    dirs.push(d);
    return d;
  };

  it("does NOT require an injectInto-only plugin invariant under the default minimal workspace harness", () => {
    const cwd = tmp();
    const cfg = config(cwd); // workspaceHarness defaults to "minimal"

    const result = runRender(cwd);
    expect(result.ok).toBe(true);

    const verdict = computeHealthVerdict(cwd, cfg);
    expect(verdict.missingInvariants.map((m) => m.invariant)).not.toContain("mem_save");
    expect(verdict.ok).toBe(true);
  });

  it("control: still requires the plugin invariant at the ROOT even under minimal harness", () => {
    const cwd = tmp();
    // Non-monorepo, single-repo scan (pathPrefix "") — mirrors the existing
    // #269 control: a Claude engine with no rendered protocol block must still
    // fail. Proves the workspace skip above did not weaken the root check.
    const cfg = NavoriConfigSchema.parse({
      name: "single-repo",
      engines: ["claude"],
      preset: "custom",
      branchBase: "main",
      plugins: { engram: { enabled: true } },
    });
    writeFileSync(join(cwd, "CLAUDE.md"), "# CLAUDE.md\n\nNo protocol block here.\n");

    const verdict = computeHealthVerdict(cwd, cfg);
    expect(verdict.missingInvariants.map((m) => m.invariant)).toContain("mem_save");
    expect(verdict.ok).toBe(false);
  });

  it("control: workspaceHarness: full actually writes the sub-block into the workspace, so the invariant is satisfied there too", () => {
    const cwd = tmp();
    const cfg = config(cwd, "full");

    const result = runRender(cwd);
    expect(result.ok).toBe(true);
    expect(existsSync(join(cwd, "apps/backend/.claude/agents/implementer.md"))).toBe(true);

    const verdict = computeHealthVerdict(cwd, cfg);
    expect(verdict.missingInvariants).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});
