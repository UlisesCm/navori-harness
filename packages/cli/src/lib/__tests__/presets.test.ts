import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPreset, PresetError, PresetDefinitionSchema } from "../presets.ts";
import * as bundled from "../bundled-assets.ts";

let fakeCoreRoot: string;

beforeEach(() => {
  fakeCoreRoot = mkdtempSync(join(tmpdir(), "navori-preset-test-"));
  mkdirSync(join(fakeCoreRoot, "core-assets/presets"), { recursive: true });
  vi.spyOn(bundled, "getCoreRoot").mockReturnValue(fakeCoreRoot);
});

afterEach(() => {
  rmSync(fakeCoreRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("loadPreset", () => {
  it("returns null when the preset file does not exist", () => {
    expect(loadPreset("nonexistent")).toBeNull();
  });

  it("parses a minimal valid preset", () => {
    writeFileSync(
      join(fakeCoreRoot, "core-assets/presets/minimal.json"),
      JSON.stringify({ id: "minimal", displayName: "Minimal" }),
    );
    const p = loadPreset("minimal");
    expect(p).not.toBeNull();
    expect(p!.id).toBe("minimal");
    expect(p!.displayName).toBe("Minimal");
    expect(p!.extends).toBe("core");
    expect(p!.extras.managed).toEqual([]);
    expect(p!.extras.skills).toEqual([]);
  });

  it("parses a preset with extras.skills", () => {
    writeFileSync(
      join(fakeCoreRoot, "core-assets/presets/medusa.json"),
      JSON.stringify({
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
      }),
    );
    const p = loadPreset("medusa");
    expect(p!.extras.skills).toHaveLength(1);
    expect(p!.extras.skills[0]!.id).toBe("medusa-db");
  });

  it("throws PresetError when JSON is invalid", () => {
    writeFileSync(join(fakeCoreRoot, "core-assets/presets/broken.json"), "{ not json");
    expect(() => loadPreset("broken")).toThrow(PresetError);
  });

  it("throws PresetError when the schema fails (kebab-case id)", () => {
    writeFileSync(
      join(fakeCoreRoot, "core-assets/presets/bad-id.json"),
      JSON.stringify({ id: "BadID", displayName: "x" }),
    );
    expect(() => loadPreset("bad-id")).toThrow(PresetError);
  });

  it("rejects relPath with traversal", () => {
    writeFileSync(
      join(fakeCoreRoot, "core-assets/presets/escape.json"),
      JSON.stringify({
        id: "escape",
        displayName: "x",
        extras: {
          skills: [
            {
              id: "x",
              relPath: "../../etc/passwd",
              destRelPath: "skills/x.md",
            },
          ],
        },
      }),
    );
    expect(() => loadPreset("escape")).toThrow(PresetError);
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
