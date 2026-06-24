import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installRemotePreset } from "../preset-install.ts";
import { PresetError } from "../presets.ts";

// installRemotePreset shells out to `npm pack <source>`. Using a local directory
// as the source keeps these tests offline: npm packs the folder in place.

let repoRoot: string;
let pkgDir: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "navori-pi-repo-"));
  pkgDir = mkdtempSync(join(tmpdir(), "navori-pi-pkg-"));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(pkgDir, { recursive: true, force: true });
});

function writePackage(
  opts: { id?: string; manifest?: unknown; withFiles?: boolean } = {},
): void {
  const id = opts.id ?? "demo-stack";
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: `preset-${id}`, version: "1.0.0" }),
  );
  const manifest =
    opts.manifest === undefined
      ? {
          $schema: "https://navori.dev/schema/navori.preset.v1.json",
          id,
          displayName: id,
          extends: "core",
          extras: {
            managed: [{ id: `stack-${id}`, relPath: "managed/stack.md" }],
            skills: [
              {
                id: `${id}-skill`,
                relPath: "skills/demo.md",
                destRelPath: `.claude/skills/${id}-skill.md`,
              },
            ],
          },
          invariants: [],
        }
      : opts.manifest;
  if (manifest !== null) writeFileSync(join(pkgDir, "preset.json"), JSON.stringify(manifest));
  if (opts.withFiles !== false) {
    mkdirSync(join(pkgDir, "managed"), { recursive: true });
    mkdirSync(join(pkgDir, "skills"), { recursive: true });
    writeFileSync(join(pkgDir, "managed/stack.md"), "## Stack — demo\n");
    writeFileSync(
      join(pkgDir, "skills/demo.md"),
      "---\nname: demo\ndescription: x\ntype: reference\n---\n# demo\n",
    );
  }
}

describe("installRemotePreset (npm pack of a local path)", () => {
  it("materializes a valid preset into .navori/presets/<id>/", () => {
    writePackage();
    const { id } = installRemotePreset(pkgDir, repoRoot);
    expect(id).toBe("demo-stack");
    expect(existsSync(join(repoRoot, ".navori/presets/demo-stack/demo-stack.json"))).toBe(true);
    expect(existsSync(join(repoRoot, ".navori/presets/demo-stack/managed/stack.md"))).toBe(true);
    expect(existsSync(join(repoRoot, ".navori/presets/demo-stack/skills/demo.md"))).toBe(true);
    // npm metadata is not copied into the preset folder.
    expect(existsSync(join(repoRoot, ".navori/presets/demo-stack/package.json"))).toBe(false);
  });

  it("throws when the package has no preset.json, without touching .navori/", () => {
    writePackage({ manifest: null });
    expect(() => installRemotePreset(pkgDir, repoRoot)).toThrow(PresetError);
    expect(existsSync(join(repoRoot, ".navori/presets"))).toBe(false);
  });

  it("throws when an extra references a missing file", () => {
    // Manifest declares managed/skills but the asset files are not shipped.
    writePackage({ withFiles: false });
    expect(() => installRemotePreset(pkgDir, repoRoot)).toThrow(/no such file/);
    expect(existsSync(join(repoRoot, ".navori/presets"))).toBe(false);
  });

  it("refuses to overwrite an existing preset unless --force", () => {
    writePackage();
    installRemotePreset(pkgDir, repoRoot);
    expect(() => installRemotePreset(pkgDir, repoRoot)).toThrow(/already exists/);
    expect(() => installRemotePreset(pkgDir, repoRoot, { force: true })).not.toThrow();
  });

  it("rejects a reserved 'custom' id", () => {
    writePackage({ id: "custom" });
    expect(() => installRemotePreset(pkgDir, repoRoot)).toThrow(/reserved/);
  });
});
