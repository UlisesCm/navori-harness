import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/schema.ts";
import {
  buildGitignoreBody,
  scanGitignoreHarness,
} from "../../engines/shared/gitignore-harness.ts";
import { injectManagedSection } from "../../lib/marker.ts";

/**
 * #313 (R10): `doctor` reports drift when the harness `.gitignore` block is
 * missing or differs from the config-derived body, and skips the check entirely
 * in mode "off". Exercised through `scanGitignoreHarness` (the function doctor
 * calls). `render` uses the same `injectManagedSection` primitive, so an
 * in-sync block written here matches what render would produce.
 */

let cwd: string;

function config(overrides: Partial<NavoriConfig> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "gi",
    engines: ["claude"],
    preset: "custom",
    ...overrides,
  });
}

/** Write a `.gitignore` whose managed block is in sync with `cfg`. */
function writeInSyncGitignore(cfg: NavoriConfig): void {
  const body = buildGitignoreBody(cfg);
  const out = injectManagedSection("", "gitignore-harness", body ?? "", {}, "shell");
  writeFileSync(join(cwd, ".gitignore"), out.output);
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-gitignore-doctor-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("scanGitignoreHarness (#313 R10)", () => {
  // Covers: R10
  it("flags a missing block when mode != off and .gitignore has none", () => {
    const health = scanGitignoreHarness(cwd, config({ gitignoreHarness: "local" }));
    expect(health).toEqual({ missing: true, drift: false });
  });

  // Covers: R10
  it("flags a missing block when the file exists but has no managed region", () => {
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
    const health = scanGitignoreHarness(cwd, config({ gitignoreHarness: "local" }));
    expect(health?.missing).toBe(true);
  });

  // Covers: R10
  it("reports no drift when the block matches the config", () => {
    const cfg = config({ gitignoreHarness: "full", engines: ["claude", "codex"] });
    writeInSyncGitignore(cfg);
    expect(scanGitignoreHarness(cwd, cfg)).toEqual({ missing: false, drift: false });
  });

  // Covers: R10
  it("reports drift when the block differs from the current config", () => {
    // Block written for a full+codex config, then evaluated against claude-only.
    writeInSyncGitignore(config({ gitignoreHarness: "full", engines: ["claude", "codex"] }));
    const health = scanGitignoreHarness(
      cwd,
      config({ gitignoreHarness: "full", engines: ["claude"] }),
    );
    expect(health).toEqual({ missing: false, drift: true });
  });

  // Covers: R8, R10
  it("does not evaluate .gitignore in mode off", () => {
    expect(scanGitignoreHarness(cwd, config({ gitignoreHarness: "off" }))).toBeNull();
    // Even with a stale block on disk, mode off returns null (no evaluation).
    writeFileSync(join(cwd, ".gitignore"), "stale\n");
    expect(scanGitignoreHarness(cwd, config())).toBeNull();
  });
});
