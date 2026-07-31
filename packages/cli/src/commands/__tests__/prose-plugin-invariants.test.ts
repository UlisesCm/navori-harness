import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/schema.ts";
import { renderAgentsMdEngine } from "../../engines/agents-md/index.ts";
import { computeHealthVerdict } from "../doctor.ts";

// #269: prose-only engines (agents-md/cursor/copilot) DROP plugin-contributed
// blocks by design, but doctor required those blocks' invariants against the
// prose output — turning doctor/CI permanently red with no remedy. codegraph
// declares `codegraph_explore`, carried only by a Claude-specific managed block.

function config(overrides: Partial<NavoriConfig> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "prose",
    engines: ["agents-md"],
    preset: "custom",
    branchBase: "main",
    plugins: { codegraph: { enabled: true } },
    ...overrides,
  });
}

describe("plugin invariants on prose-only engines (#269)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), "navori-prose-inv-"));
    dirs.push(d);
    return d;
  };

  it("does NOT require a plugin invariant when only prose engines are configured", () => {
    const cwd = tmp();
    const cfg = config(); // engines: ["agents-md"] + codegraph
    // Render AGENTS.md: prose drops the codegraph protocol block, so the output is
    // non-empty yet never contains `codegraph_explore`.
    renderAgentsMdEngine(cwd, cfg);

    const verdict = computeHealthVerdict(cwd, cfg);
    expect(verdict.missingInvariants.map((m) => m.invariant)).not.toContain("codegraph_explore");
    expect(verdict.ok).toBe(true);
  });

  it("control: a Claude engine still requires the plugin invariant when the block is absent", () => {
    const cwd = tmp();
    const cfg = config({ engines: ["claude"] });
    // Non-empty Claude output that lacks the plugin block → the invariant must still
    // be reported (we don't kill the legitimate protection for engines that emit it).
    writeFileSync(
      join(cwd, "CLAUDE.md"),
      "# CLAUDE.md\n\nSome content without the protocol block.\n",
    );

    const verdict = computeHealthVerdict(cwd, cfg);
    expect(verdict.missingInvariants.map((m) => m.invariant)).toContain("codegraph_explore");
    expect(verdict.ok).toBe(false);
  });
});
