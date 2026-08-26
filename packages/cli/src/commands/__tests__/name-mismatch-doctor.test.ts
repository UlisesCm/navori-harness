import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NavoriConfig } from "../../lib/config.ts";
import { scanNameMismatch } from "../doctor.ts";
import { detectProject } from "../../lib/detect.ts";

/**
 * #315: doctor warns when config.name doesn't match the repo directory (a
 * harness copied from another repo whose name was never updated). Twin of the
 * placeholder-name check; informational, never flips `ok`. The scan takes the
 * cwd whose basename is compared, so a synthetic path exercises both branches
 * without touching disk.
 *
 * #520: the comparison is against the directory's KEBAB-CASE form, not its raw
 * basename. The schema requires kebab-case (`name must be kebab-case`), so in a
 * directory with an underscore the raw comparison had NO satisfying value —
 * `alertaciudadana_backend` rejects `alertaciudadana-backend` (kebab, doesn't
 * match) and the config rejects `alertaciudadana_backend` (matches, not kebab).
 * The warning was permanent and its advice unfollowable, in the command the
 * harness tells you to run at session start.
 */

function config(name: string): NavoriConfig {
  return { name } as NavoriConfig;
}

describe("scanNameMismatch", () => {
  it("returns null when the directory basename matches config.name", () => {
    expect(scanNameMismatch("/Users/dev/webapp", config("webapp"))).toBeNull();
  });

  it("flags a mismatch, reporting both the config name and the directory", () => {
    expect(scanNameMismatch("/Users/dev/my-real-repo", config("webapp"))).toEqual({
      configName: "webapp",
      dirName: "my-real-repo",
      suggestedName: "my-real-repo",
    });
  });

  it("stays silent for a placeholder name (warned separately)", () => {
    // 'temp-app' is a known placeholder — the placeholder check owns that hint.
    expect(scanNameMismatch("/Users/dev/my-real-repo", config("temp-app"))).toBeNull();
  });

  // #520 — the field case that made the warning unsatisfiable.
  it("stays silent when name is the kebab-case form of an underscored directory", () => {
    // The measured case: someone already followed doctor's advice and wrote the
    // only value the schema accepts. Before the fix this still warned, forever.
    expect(
      scanNameMismatch("/Users/dev/alertaciudadana_backend", config("alertaciudadana-backend")),
    ).toBeNull();
  });

  it("still flags a real mismatch under an underscored directory, suggesting a valid name", () => {
    expect(scanNameMismatch("/Users/dev/alertaciudadana_app", config("alertaciudadana"))).toEqual({
      configName: "alertaciudadana",
      dirName: "alertaciudadana_app",
      // Kebab-case (schema-valid) AND derived from the directory: writing it
      // satisfies both sides, which the old raw comparison could not offer.
      suggestedName: "alertaciudadana-app",
    });
  });

  it("suggests a name the schema accepts for every directory shape it flags", () => {
    // The schema's own regex (lib/schema.ts). A suggestion that fails it would
    // reproduce #520 with different characters.
    const kebab = /^[a-z0-9][a-z0-9-]*$/;
    for (const dir of ["Some_Repo", "my repo", "api.v2", "repo--name", "_leading", "trailing_"]) {
      const found = scanNameMismatch(`/Users/dev/${dir}`, config("unrelated-name"));
      expect(found, dir).not.toBeNull();
      expect(found!.suggestedName, dir).toMatch(kebab);
    }
  });

  it("normalizes case, spaces, dots and repeated separators", () => {
    expect(scanNameMismatch("/Users/dev/MyApp", config("myapp"))).toBeNull();
    expect(scanNameMismatch("/Users/dev/my repo", config("my-repo"))).toBeNull();
    expect(scanNameMismatch("/Users/dev/api.v2", config("api-v2"))).toBeNull();
    expect(scanNameMismatch("/Users/dev/foo__bar", config("foo-bar"))).toBeNull();
    expect(scanNameMismatch("/Users/dev/_leading_", config("leading"))).toBeNull();
  });

  it("stays silent when the directory has no kebab-case form at all", () => {
    // Nothing survives normalization, so no `name` could ever match: warning
    // about it would be the same unfollowable advice #520 removed.
    expect(scanNameMismatch("/Users/dev/___", config("real-name"))).toBeNull();
  });
});

describe("scanNameMismatch vs. the name init would derive (#520)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("never warns about the name init derives from the directory", () => {
    // The anti-drift pin: doctor normalizes the basename with its own copy of
    // init's transform (lib/detect.ts#normalizeName, not exported). If either
    // side changes, `init` starts writing a name its own doctor complains
    // about — exactly the #520 loop, one layer up.
    const parent = mkdtempSync(join(tmpdir(), "name-mismatch-"));
    dirs.push(parent);
    const repo = join(parent, "Alerta_Ciudadana_App");
    mkdirSync(repo);

    // No package.json / git remote here, so detection falls back to the
    // directory basename — the branch under test.
    const detected = detectProject(repo);
    expect(detected.name).toBe("alerta-ciudadana-app");
    expect(scanNameMismatch(repo, config(detected.name!))).toBeNull();
  });
});
