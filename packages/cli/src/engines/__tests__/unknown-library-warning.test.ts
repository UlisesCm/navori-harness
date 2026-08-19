import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/schema.ts";
import { renderClaudeEngine } from "../claude/index.ts";
import { renderCodexEngine } from "../codex/index.ts";

/**
 * Audit v0.5.1 A1: a repo onboarded before the socketio split carries
 * `"socketio"` in `project.libraries`. Rendering with a newer CLI (without
 * `navori update` first) used to skip the unknown id silently while §8.6
 * pruned its managed skill from disk — the repo lost ALL Socket.IO guidance
 * with zero signal. Both engines must now WARN, naming the successors for a
 * known retired id and pointing at `navori update` for a plain unknown one.
 */

function configWithLibraries(engines: string[], libraries: string[]): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "warn-demo",
    engines,
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
    project: { libraries },
  });
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-unknown-lib-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe.each([
  ["claude", (c: NavoriConfig) => renderClaudeEngine(cwd, c, { dryRun: true }).warnings],
  ["codex", (c: NavoriConfig) => renderCodexEngine(cwd, c, { dryRun: true }).warnings],
] as const)("%s engine — unknown project.libraries ids warn (audit A1)", (engine, render) => {
  it("warns on a retired id, naming its successors and 'navori update'", () => {
    const warnings = render(configWithLibraries([engine], ["socketio"]));
    const warning = warnings.find((w) => w.includes("'socketio'"));
    expect(warning).toBeDefined();
    expect(warning).toContain("socketio-server, socketio-client");
    expect(warning).toContain("navori update");
  });

  it("warns on a plain unknown id, pointing at 'navori update'", () => {
    const warnings = render(configWithLibraries([engine], ["not-a-lib"]));
    const warning = warnings.find((w) => w.includes("'not-a-lib'"));
    expect(warning).toBeDefined();
    expect(warning).toContain("navori update");
  });

  it("does NOT warn when every id is known to the registry", () => {
    const warnings = render(configWithLibraries([engine], ["zod-validation", "vitest"]));
    expect(warnings.some((w) => w.includes("project.libraries"))).toBe(false);
  });
});
