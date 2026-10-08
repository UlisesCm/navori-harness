import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavoriConfig } from "../../lib/config/config.ts";
import { tc } from "../../lib/i18n.ts";

/**
 * #1244 — `doctor` shows newer releases of opted-in tools from the per-machine cache, without
 * network, and as information only: never `computeHealthVerdict`, never `--strict`.
 */
const execFileSync = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSync(...args),
}));
vi.mock(import("../../lib/primitives/which.ts"), () => ({ hasBinary: () => true }));

const { computeHealthVerdict, isStrictModeFailure } = await import("../doctor.ts");
const { scanToolUpdates } = await import("../../lib/primitives/tool-version-notice.ts");

const ENGRAM = { plugins: { engram: { enabled: true } } } as unknown as NavoriConfig;
let home: string;

function cache(entry: Record<string, unknown>): void {
  const dir = join(home, ".navori", "tool-versions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "latest.json"),
    JSON.stringify({
      tools: {
        engram: { at: Date.now(), source: "github", id: "Gentleman-Programming/engram", ...entry },
      },
    }),
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "navori-tooldoctor-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("CI", "");
  vi.stubEnv("NAVORI_NO_UPDATE_NOTIFIER", "");
  execFileSync.mockReset();
  execFileSync.mockReturnValue("engram 3.0.0\n");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("doctor toolUpdates", () => {
  it("lists a newer release from the cache, including one already announced", () => {
    cache({ status: "ok", version: "3.2.1" });
    mkdirSync(join(home, ".navori", "tool-versions"), { recursive: true });
    writeFileSync(
      join(home, ".navori", "tool-versions", "notice.json"),
      JSON.stringify({ engram: { at: Date.now(), version: "3.2.1" } }),
    );
    expect(scanToolUpdates(ENGRAM).updates).toEqual([
      { pluginId: "engram", binary: "engram", installedVersion: "3.0.0", latestVersion: "3.2.1" },
    ]);
  });

  it("flags an upstream tag navori could not read, so the silence is explained", () => {
    cache({ status: "unparseable", version: null });
    expect(scanToolUpdates(ENGRAM)).toMatchObject({
      updates: [],
      unparseable: [{ pluginId: "engram", source: "github" }],
    });
  });

  it("is silent when the user opted out", () => {
    cache({ status: "ok", version: "3.2.1" });
    vi.stubEnv("NAVORI_NO_UPDATE_NOTIFIER", "1");
    expect(scanToolUpdates(ENGRAM)).toEqual({ updates: [], unparseable: [] });
  });

  it("never gates: the verdict stays ok and --strict green", () => {
    cache({ status: "ok", version: "3.2.1" });
    expect(scanToolUpdates(ENGRAM).updates).toHaveLength(1);
    const cwd = mkdtempSync(join(tmpdir(), "navori-tooldoctor-repo-"));
    const cfg = {
      name: "t",
      engines: ["claude"],
      preset: "custom",
      plugins: {},
    } as unknown as NavoriConfig;
    expect(computeHealthVerdict(cwd, cfg).ok).toBe(true);
    expect(isStrictModeFailure(true, [], [])).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("is wired into the JSON report and kept out of the verdict inputs", () => {
    const source = readFileSync(join(import.meta.dirname, "../doctor.ts"), "utf8");
    expect(source).toContain("toolUpdates: toolUpdates.updates");
    expect(source).not.toMatch(/computeHealthVerdict\([^)]*toolUpdates/);
  });

  it.each(["es", "en"] as const)("%s rows render versions and counts", (lang) => {
    const d = tc(lang).doctor;
    expect(d.toolUpdateRow("3.0.0", "3.2.1")).toMatch(/3\.0\.0.*3\.2\.1/);
    expect(d.toolUpdates(2, "x")).toContain("(2)");
    expect(d.toolReleaseUnparseableRow("github", "o/r")).toContain("github:o/r");
  });
});
