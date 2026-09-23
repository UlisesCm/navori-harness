import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavoriConfig } from "../../lib/config/config.ts";

/**
 * #943 — tgrep and codegraph both cache a point-in-time snapshot on disk.
 * `doctor` never asked whether that snapshot is still safe to trust: is the
 * tgrep server alive to keep the index warm, and does the installed codegraph
 * engine match the one that built its database. Two sibling scans, informative
 * only, per the issue: navori diagnoses, it never starts a server, indexes, or
 * installs one.
 */

const hasBinary = vi.fn();
vi.mock(import("../../lib/primitives/which.ts"), () => ({
  hasBinary: (n: string) => hasBinary(n),
}));

const execFileSync = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSync(...args),
}));

const {
  scanTgrepFreshness,
  scanCodegraphDrift,
  parseTgrepStatusOutput,
  needsExternalProviderSetupHint,
} = await import("../doctor.ts");

function config(plugins: Record<string, { enabled: boolean }>): NavoriConfig {
  return { plugins } as unknown as NavoriConfig;
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-search-freshness-"));
  hasBinary.mockReset();
  execFileSync.mockReset();
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("parseTgrepStatusOutput", () => {
  // `tgrep status` is parsed as TEXT, not `--json` (silently ignored by this
  // subcommand) or exit code (0 in all three states) — see scanTgrepFreshness.
  it("recognizes a repo with no index", () => {
    const out = `No index found at ${cwd}/.tgrep\nRun \`tgrep index ${cwd}\` to build one.\n`;
    expect(parseTgrepStatusOutput(out)).toEqual({ kind: "no-index" });
  });

  it("recognizes a live server", () => {
    const out = `Server status for ${cwd}\n  PID:        123\n  Port:       456\n`;
    expect(parseTgrepStatusOutput(out)).toEqual({ kind: "serving" });
  });

  it("recognizes an index with no server, and extracts the age + root path", () => {
    const out =
      `Index status for ${cwd}\n` +
      `  Files:      1\n  Trigrams:   28\n  Created:    1d ago\n  Updated:    1d ago\n` +
      `  Server:     not running\n  Hidden coverage: complete\n`;
    expect(parseTgrepStatusOutput(out)).toEqual({ kind: "stale", age: "1d", rootPath: cwd });
  });

  it("degrades to unrecognized instead of guessing on an unexpected shape", () => {
    expect(parseTgrepStatusOutput("something tgrep never printed before\n")).toEqual({
      kind: "unrecognized",
    });
  });
});

describe("scanTgrepFreshness", () => {
  it("stays silent when tgrep is disabled", () => {
    expect(scanTgrepFreshness(cwd, config({ tgrep: { enabled: false } }))).toBeNull();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("stays silent when the binary is missing", () => {
    hasBinary.mockReturnValue(false);
    expect(scanTgrepFreshness(cwd, config({ tgrep: { enabled: true } }))).toBeNull();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("stays silent on a repo with no index (tgrep scans directly and is correct)", () => {
    hasBinary.mockReturnValue(true);
    execFileSync.mockReturnValue(`No index found at ${cwd}/.tgrep\n`);
    expect(scanTgrepFreshness(cwd, config({ tgrep: { enabled: true } }))).toBeNull();
  });

  it("stays silent when the server is running", () => {
    hasBinary.mockReturnValue(true);
    execFileSync.mockReturnValue(`Server status for ${cwd}\n  PID:  1\n`);
    expect(scanTgrepFreshness(cwd, config({ tgrep: { enabled: true } }))).toBeNull();
  });

  it("flags an index with no server, no age threshold — any staleness is a finding", () => {
    hasBinary.mockReturnValue(true);
    execFileSync.mockReturnValue(
      `Index status for ${cwd}\n  Updated:    30s ago\n  Server:     not running\n`,
    );
    const report = scanTgrepFreshness(cwd, config({ tgrep: { enabled: true } }));
    expect(report).toEqual({ age: "30s", rootPath: cwd });
  });

  it("stays silent when `tgrep status` errors", () => {
    hasBinary.mockReturnValue(true);
    execFileSync.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(scanTgrepFreshness(cwd, config({ tgrep: { enabled: true } }))).toBeNull();
  });
});

describe("scanCodegraphDrift", () => {
  it("stays silent when codegraph is disabled", () => {
    mkdirSync(join(cwd, ".codegraph"));
    expect(scanCodegraphDrift(cwd, config({ codegraph: { enabled: false } }))).toBeNull();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("stays silent when there is no index", () => {
    expect(scanCodegraphDrift(cwd, config({ codegraph: { enabled: true } }))).toBeNull();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("reports the engine drift `codegraph status --json` exposes", () => {
    mkdirSync(join(cwd, ".codegraph"));
    hasBinary.mockReturnValue(true);
    execFileSync.mockReturnValue(
      JSON.stringify({
        version: "1.6.0",
        index: { builtWithVersion: "1.5.0", reindexRecommended: true },
      }),
    );
    const report = scanCodegraphDrift(cwd, config({ codegraph: { enabled: true } }));
    expect(report).toEqual({ builtWithVersion: "1.5.0", currentVersion: "1.6.0" });
  });

  it("stays silent when no reindex is recommended", () => {
    mkdirSync(join(cwd, ".codegraph"));
    hasBinary.mockReturnValue(true);
    execFileSync.mockReturnValue(
      JSON.stringify({
        version: "1.6.0",
        index: { builtWithVersion: "1.6.0", reindexRecommended: false },
      }),
    );
    expect(scanCodegraphDrift(cwd, config({ codegraph: { enabled: true } }))).toBeNull();
  });

  it("stays silent when the binary is missing", () => {
    mkdirSync(join(cwd, ".codegraph"));
    hasBinary.mockReturnValue(false);
    expect(scanCodegraphDrift(cwd, config({ codegraph: { enabled: true } }))).toBeNull();
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

/**
 * #982 — pins every input explicitly instead of depending on whether
 * codegraph/tgrep happen to be installed on the machine running the suite
 * (a real e2e run of `doctor` can't control that deterministically).
 */
describe("needsExternalProviderSetupHint", () => {
  it("is false when nothing is missing, stale, or available-not-enabled", () => {
    expect(needsExternalProviderSetupHint([], [], null, null)).toBe(false);
  });

  it("is true when codegraph/tgrep's binary is enabled but missing", () => {
    expect(needsExternalProviderSetupHint([{ pluginId: "codegraph" }], [], null, null)).toBe(true);
  });

  it("stays false for an unrelated plugin's missing binary (e.g. semgrep)", () => {
    expect(needsExternalProviderSetupHint([{ pluginId: "semgrep" }], [], null, null)).toBe(false);
  });

  it("is true when codegraph/tgrep is available but never enabled", () => {
    expect(needsExternalProviderSetupHint([], ["tgrep"], null, null)).toBe(true);
  });

  it("stays false for an unrelated available provider (e.g. jscpd)", () => {
    expect(needsExternalProviderSetupHint([], ["jscpd"], null, null)).toBe(false);
  });

  it("is true when tgrep's index is stale", () => {
    expect(needsExternalProviderSetupHint([], [], { age: "1d", rootPath: "/x" }, null)).toBe(true);
  });

  it("is true when codegraph's index has drifted", () => {
    expect(
      needsExternalProviderSetupHint([], [], null, {
        builtWithVersion: "1.0",
        currentVersion: "1.1",
      }),
    ).toBe(true);
  });
});
