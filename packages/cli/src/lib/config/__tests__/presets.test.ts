import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPreset,
  resolvePreset,
  presetExists,
  PresetError,
  PresetDefinitionSchema,
} from "../presets.ts";
import * as bundled from "../bundled-assets.ts";

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
