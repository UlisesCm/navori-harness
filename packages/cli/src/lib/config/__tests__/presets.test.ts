import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPreset,
  resolvePreset,
  presetExists,
  PresetError,
  PresetDefinitionSchema,
  droppedLibrariesWarnings,
  effectiveLibraries,
  isPresetLoaded,
} from "../presets.ts";
import type { NavoriConfig } from "../schema.ts";
import * as bundled from "../../render/bundled-assets.ts";
import { getCoreRoot } from "../../render/bundled-assets.ts";

let fakeCoreRoot: string;
let repoRoot: string;

/** Write a bundled preset manifest under the mocked core root. */
function writeBundled(id: string, def: Record<string, unknown>): void {
  writeFileSync(join(fakeCoreRoot, "core-assets/presets", `${id}.json`), JSON.stringify(def));
}

/** Write a local preset manifest under repoRoot/.navori/presets/<id>/. */
function writeLocal(id: string, def: Record<string, unknown>): void {
  const dir = join(repoRoot, ".navori/presets", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(def));
}

beforeEach(() => {
  fakeCoreRoot = mkdtempSync(join(tmpdir(), "navori-preset-core-"));
  repoRoot = mkdtempSync(join(tmpdir(), "navori-preset-repo-"));
  mkdirSync(join(fakeCoreRoot, "core-assets/presets"), { recursive: true });
  vi.spyOn(bundled, "getCoreRoot").mockReturnValue(fakeCoreRoot);
});

afterEach(() => {
  rmSync(fakeCoreRoot, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("loadPreset", () => {
  it("returns null when the preset exists neither local nor bundled", () => {
    expect(loadPreset("nonexistent", repoRoot)).toBeNull();
  });

  it("parses a minimal valid bundled preset", () => {
    writeBundled("minimal", { id: "minimal", displayName: "Minimal" });
    const p = loadPreset("minimal", repoRoot);
    expect(p).not.toBeNull();
    expect(p!.def.id).toBe("minimal");
    expect(p!.def.displayName).toBe("Minimal");
    expect(p!.def.extends).toBe("core");
    expect(p!.def.extras.managed).toEqual([]);
    expect(p!.def.extras.skills).toEqual([]);
    expect(p!.source).toBe("bundled");
    expect(p!.assetRoot).toBe(join(fakeCoreRoot, "core-assets"));
  });

  it("parses a bundled preset with extras.skills", () => {
    writeBundled("medusa", {
      id: "medusa",
      displayName: "Medusa",
      extras: {
        skills: [
          {
            id: "medusa-db",
            relPath: "presets/medusa/skills/medusa-db.md",
            destRelPath: ".claude/skills/medusa-db.md",
          },
        ],
      },
    });
    const p = loadPreset("medusa", repoRoot);
    expect(p!.def.extras.skills).toHaveLength(1);
    expect(p!.def.extras.skills[0]!.id).toBe("medusa-db");
  });

  it("throws PresetError when JSON is invalid", () => {
    writeBundled("broken", "{ not json" as unknown as Record<string, unknown>);
    expect(() => loadPreset("broken", repoRoot)).toThrow(PresetError);
  });

  it("throws PresetError when the schema fails (kebab-case id)", () => {
    writeBundled("bad-id", { id: "BadID", displayName: "x" });
    expect(() => loadPreset("bad-id", repoRoot)).toThrow(PresetError);
  });

  it("rejects relPath with traversal", () => {
    writeBundled("escape", {
      id: "escape",
      displayName: "x",
      extras: {
        skills: [{ id: "x", relPath: "../../etc/passwd", destRelPath: "skills/x.md" }],
      },
    });
    expect(() => loadPreset("escape", repoRoot)).toThrow(PresetError);
  });

  it("rejects extends other than 'core'", () => {
    const result = PresetDefinitionSchema.safeParse({
      id: "x",
      displayName: "x",
      extends: "other",
    });
    expect(result.success).toBe(false);
  });
});

describe("resolvePreset — local wins over bundled", () => {
  it("returns null for 'custom' (no manifest, no extras)", () => {
    expect(resolvePreset("custom", repoRoot)).toBeNull();
    expect(loadPreset("custom", repoRoot)).toBeNull();
  });

  it("prefers a local preset over a bundled one of the same id", () => {
    writeBundled("dual", { id: "dual", displayName: "Bundled dual" });
    writeLocal("dual", { id: "dual", displayName: "Local dual" });

    const resolved = resolvePreset("dual", repoRoot);
    expect(resolved!.source).toBe("local");
    expect(resolved!.assetRoot).toBe(join(repoRoot, ".navori/presets/dual"));

    const p = loadPreset("dual", repoRoot);
    expect(p!.source).toBe("local");
    expect(p!.def.displayName).toBe("Local dual");
  });

  it("loads a local-only preset; bundled falls through when no local exists", () => {
    writeLocal("onlylocal", { id: "onlylocal", displayName: "Only local" });
    const p = loadPreset("onlylocal", repoRoot);
    expect(p!.source).toBe("local");
    expect(p!.def.displayName).toBe("Only local");
  });
});

describe("presetExists — bundled only (drives the detector's gap)", () => {
  it("is true for a bundled preset", () => {
    writeBundled("bun", { id: "bun", displayName: "B" });
    expect(presetExists("bun")).toBe(true);
  });

  it("ignores local presets: a local-only id is NOT 'existing' for gap purposes", () => {
    writeLocal("onlylocal", { id: "onlylocal", displayName: "Only local" });
    expect(presetExists("onlylocal")).toBe(false);
    // but it IS loadable (local resolution)
    expect(loadPreset("onlylocal", repoRoot)).not.toBeNull();
  });

  it("'custom' always counts as existing", () => {
    expect(presetExists("custom")).toBe(true);
  });
});

describe("preset `libraries` (#1094)", () => {
  // Covers: A4
  it("defaults to [] and keeps known ids", () => {
    writeBundled("plain", { id: "plain", displayName: "Plain" });
    expect(loadPreset("plain", repoRoot)!.def.libraries).toEqual([]);
    writeBundled("lib", {
      id: "lib",
      displayName: "Lib",
      libraries: ["mantine-ui-patterns"],
    });
    const p = loadPreset("lib", repoRoot)!;
    expect(p.def.libraries).toEqual(["mantine-ui-patterns"]);
    expect(p.droppedLibraries).toEqual([]);
  });

  // Covers: A4 — lenient parse: unknown ids are dropped and reported, not fatal.
  it("drops unknown ids and reports them", () => {
    writeLocal("lenient", {
      id: "lenient",
      displayName: "Lenient",
      libraries: ["mantine-ui-patterns", "nope"],
    });
    const p = loadPreset("lenient", repoRoot)!;
    expect(p.def.libraries).toEqual(["mantine-ui-patterns"]);
    expect(p.droppedLibraries).toEqual(["nope"]);
    expect(droppedLibrariesWarnings(p)[0]).toContain("'nope'");
  });

  // Covers: A4 — C1: a manifest whose id differs from the requested one is loud.
  it("throws PresetError when def.id differs from the requested id", () => {
    writeLocal("wanted", { id: "other", displayName: "Other" });
    expect(() => loadPreset("wanted", repoRoot)).toThrow(PresetError);
  });

  // Covers: A4 — every bundled preset's libraries exist in the registry.
  it("every core preset declares only registered libraries", () => {
    vi.restoreAllMocks();
    const dir = join(getCoreRoot(), "core-assets/presets");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const p = loadPreset(f.replace(/\.json$/, ""), repoRoot)!;
      expect(p.droppedLibraries, f).toEqual([]);
    }
  });

  // Covers: A1
  it("effectiveLibraries unions detected + extra + preset, deduped (#1104)", () => {
    writeBundled("lib", {
      id: "lib",
      displayName: "Lib",
      libraries: ["mantine-ui-patterns", "vitest"],
    });
    const p = loadPreset("lib", repoRoot)!;
    const cfg = {
      preset: "lib",
      project: {
        libraries: ["zod-validation"],
        extraLibraries: ["vitest", "zod-validation", "citty"],
      },
    } as unknown as NavoriConfig;
    expect(effectiveLibraries(cfg, p)).toEqual([
      "zod-validation",
      "vitest",
      "citty",
      "mantine-ui-patterns",
    ]);
  });

  // Covers: A4
  it("effectiveLibraries unions detected + preset ids; isPresetLoaded gates", () => {
    const cfg = (o: Record<string, unknown>) => o as unknown as NavoriConfig;
    writeBundled("lib", {
      id: "lib",
      displayName: "Lib",
      libraries: ["mantine-ui-patterns", "zod-validation"],
    });
    const p = loadPreset("lib", repoRoot)!;
    expect(
      effectiveLibraries(
        cfg({ preset: "lib", project: { libraries: ["zod-validation", "vitest"] } }),
        p,
      ),
    ).toEqual(["zod-validation", "vitest", "mantine-ui-patterns"]);
    expect(effectiveLibraries(cfg({ project: { libraries: ["vitest"] } }), null)).toEqual([
      "vitest",
    ]);
    expect(isPresetLoaded(cfg({ preset: "lib" }), p)).toBe(true);
    expect(isPresetLoaded(cfg({ preset: "lib" }), null)).toBe(false);
    expect(isPresetLoaded(cfg({ preset: "custom" }), null)).toBe(true);
  });
});
