import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { navoriAuthorship } from "../removable.ts";
import { renderManagedFile } from "../../../engines/shared/render-managed-file.ts";
import { getCoreRoot, readCliVersion } from "../bundled-assets.ts";
import type { NavoriConfig } from "../../config/config.ts";

/**
 * Spec 0043 T3 — `requirePristine.normalize`. A copy rendered by an older navori
 * lacks the frontmatter keys the asset gained since; re-rendering it with the
 * current asset refreshes them, so only what the user wrote counts.
 */

const CONFIG = {
  name: "demo",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
} as unknown as NavoriConfig;
const ASSET = join(getCoreRoot(), "core-assets/skills/review-diff.md");
const META = { source: "@navori/core", version: readCliVersion() };

const render = (existingContent: string | null): string =>
  renderManagedFile({
    assetPath: ASSET,
    existingContent,
    managedId: "review-diff-base",
    meta: META,
    config: CONFIG,
    engine: "claude",
  }).content;

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "navori-normalize-"));
  file = join(dir, "SKILL.md");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const verdict = (opts: { normalize: boolean }) =>
  navoriAuthorship(file, "review-diff-base", {
    verifyHash: true,
    requirePristine: { expected: render(null), normalize: opts.normalize ? render : undefined },
  });

/** The copy an older navori wrote: same block, frontmatter without navori's own metadata map. */
function oldCopy(): string {
  const fresh = render(null);
  const stripped = fresh.replace(/^metadata:\n(?: {2}.*\n)+/m, "");
  expect(stripped).not.toBe(fresh);
  return stripped;
}

describe("requirePristine.normalize (spec 0043 T3)", () => {
  it("una copia de un asset viejo, sin `type:` ni `maxWords:`, es `ours` con normalize", () => {
    // Covers: R3
    writeFileSync(file, oldCopy());
    expect(verdict({ normalize: false })).toBe("modified");
    expect(verdict({ normalize: true })).toBe("ours");
  });

  it("una clave de frontmatter agregada por el usuario la vuelve `modified`", () => {
    // Covers: R3
    writeFileSync(file, oldCopy().replace(/^---\n/, "---\nmy-key: mine\n"));
    expect(verdict({ normalize: true })).toBe("modified");
  });

  it("texto en la zona de usuario la vuelve `modified`", () => {
    // Covers: R3
    writeFileSync(file, `${oldCopy()}\nMy own notes about this skill.\n`);
    expect(verdict({ normalize: true })).toBe("modified");
  });

  it("la copia fresca sigue siendo `ours` con normalize", () => {
    // Covers: R3
    writeFileSync(file, render(null));
    expect(verdict({ normalize: true })).toBe("ours");
    expect(readFileSync(file, "utf-8")).toBe(render(null));
  });
});
