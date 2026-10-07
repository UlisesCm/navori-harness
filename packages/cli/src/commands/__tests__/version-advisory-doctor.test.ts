import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NavoriConfig } from "../../lib/config/config.ts";
import type { PluginExternalTool } from "../../lib/config/plugins.ts";
import { tc } from "../../lib/i18n.ts";

/**
 * #1210 — `doctor` warns, offline, when an enabled plugin's binary is below a
 * curated known-bad floor in its manifest (`externalTool.versionAdvisory`).
 * Informational only: it never feeds `computeHealthVerdict` or `--strict`.
 * Spawn and PATH lookup are mocked so no test ever runs a real `engram`.
 */

const hasBinary = vi.fn();
vi.mock(import("../../lib/primitives/which.ts"), () => ({
  hasBinary: (n: string) => hasBinary(n),
}));

const execFileSync = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSync(...args),
}));

/** When set, replaces the manifest `externalTool` of the plugin id it names. */
const toolOverride = vi.hoisted(() => ({ tool: null as unknown }));
vi.mock(import("../../lib/config/plugins.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadPlugin: (...args: Parameters<typeof actual.loadPlugin>) => {
      const id = args[0];
      const loaded = actual.loadPlugin(...args);
      if (toolOverride.tool === null || id !== "engram") return loaded;
      return {
        ...loaded,
        manifest: { ...loaded.manifest, externalTool: toolOverride.tool as PluginExternalTool },
      };
    },
  };
});

const { scanVersionAdvisories, computeHealthVerdict, isStrictModeFailure } =
  await import("../doctor.ts");

function config(plugins: Record<string, { enabled: boolean }>): NavoriConfig {
  return { plugins } as unknown as NavoriConfig;
}

const ENGRAM = config({ engram: { enabled: true } });

// Real `engram --version` output (2.2.1 / 3.0.0 builds) and a `v`-prefixed form.
const ENGRAM_2_2_1 = "engram 2.2.1\n";
const ENGRAM_V_2_2_1 = "engram version v2.2.1 (commit abc1234)\n";

beforeEach(() => {
  hasBinary.mockReset();
  execFileSync.mockReset();
  toolOverride.tool = null;
});

describe("scanVersionAdvisories", () => {
  it.each([ENGRAM_2_2_1, ENGRAM_V_2_2_1])("flags engram below 3.0.0: %j", (output) => {
    hasBinary.mockReturnValue(true);
    execFileSync.mockReturnValue(output);
    const hits = scanVersionAdvisories(ENGRAM);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      pluginId: "engram",
      binary: "engram",
      installedVersion: "2.2.1",
      below: "3.0.0",
      ref: "https://github.com/Gentleman-Programming/engram/issues/1549",
    });
    expect(hits[0]?.reason.en).toContain("model_instructions_file");
    expect(hits[0]?.reason.es).toContain("model_instructions_file");
  });

  it.each(["engram 3.0.0\n", "engram 3.1.0\n", "engram 3.0.0-rc.1\n"])(
    "is silent for %j (floor is exclusive; prerelease of the fix counts as fixed)",
    (output) => {
      hasBinary.mockReturnValue(true);
      execFileSync.mockReturnValue(output);
      expect(scanVersionAdvisories(ENGRAM)).toEqual([]);
    },
  );

  it("is silent and does not spawn when the binary is missing", () => {
    hasBinary.mockReturnValue(false);
    expect(scanVersionAdvisories(ENGRAM)).toEqual([]);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("is silent when --version throws or is unparseable", () => {
    hasBinary.mockReturnValue(true);
    execFileSync.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(scanVersionAdvisories(ENGRAM)).toEqual([]);
    execFileSync.mockReset();
    execFileSync.mockReturnValue("engram dev build\n");
    expect(scanVersionAdvisories(ENGRAM)).toEqual([]);
  });

  it("is silent and never touches PATH when the plugin is disabled", () => {
    expect(scanVersionAdvisories(config({ engram: { enabled: false } }))).toEqual([]);
    expect(hasBinary).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("is silent for a plugin that declares no advisory, without checking PATH", () => {
    expect(scanVersionAdvisories(config({ codegraph: { enabled: true } }))).toEqual([]);
    expect(hasBinary).not.toHaveBeenCalled();
  });

  it("reports one hit per matching entry", () => {
    toolOverride.tool = {
      name: "engram",
      checkBinary: "engram",
      versionAdvisory: [
        { below: "3.0.0", reason: { es: "a", en: "a" } },
        { below: "2.5.0", reason: { es: "b", en: "b" } },
        { below: "2.0.0", reason: { es: "c", en: "c" } },
      ],
    };
    hasBinary.mockReturnValue(true);
    execFileSync.mockReturnValue(ENGRAM_2_2_1);
    const hits = scanVersionAdvisories(ENGRAM);
    expect(hits.map((h) => h.below)).toEqual(["3.0.0", "2.5.0"]);
    expect(hits.map((h) => h.ref)).toEqual([null, null]);
  });
});

describe("version advisories never gate", () => {
  it("an advisory-only repo keeps the verdict ok and --strict green", () => {
    hasBinary.mockReturnValue(true);
    execFileSync.mockReturnValue(ENGRAM_2_2_1);
    expect(scanVersionAdvisories(ENGRAM)).toHaveLength(1);
    const cwd = mkdtempSync(join(tmpdir(), "navori-advisory-"));
    const cfg = {
      name: "adv",
      engines: ["claude"],
      preset: "custom",
      plugins: {},
    } as unknown as NavoriConfig;
    expect(computeHealthVerdict(cwd, cfg).ok).toBe(true);
    expect(isStrictModeFailure(true, [], [])).toBe(false);
  });
});

describe("versionAdvisoryRow i18n", () => {
  it.each(["es", "en"] as const)("%s row renders installed, floor and reason", (lang) => {
    const reason = "motivo curado";
    const row = tc(lang).doctor.versionAdvisoryRow("2.2.1", "3.0.0", reason);
    expect(row).toContain("2.2.1");
    expect(row).toContain("3.0.0");
    expect(row).toContain(reason);
    expect(tc(lang).doctor.versionAdvisories(1, "x")).toContain("(1)");
  });
});
