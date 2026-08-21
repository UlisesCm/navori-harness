import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getCoreRoot, resolveBundledCoreAssetPath } from "../bundled-assets.ts";

/**
 * `@navori/core` package contract — assets-only, consumed by FILESYSTEM (#406).
 *
 * ## The contract
 *
 * `@navori/core` is NOT a library: it ships zero code. It is a container of
 * managed assets (`core-assets/`) that the CLI reads off disk through
 * `lib/bundled-assets.ts` — `getCoreRoot()` points at `dist/assets/core` in a
 * built/published CLI and at `packages/core` in dev, and every asset is then
 * resolved with `resolveBundledCoreAssetPath()`. The `workspace:*` devDependency
 * in `packages/cli/package.json` exists ONLY so `scripts/copy-assets.mjs` can
 * materialize `core-assets/` into `dist/assets/core` at build time. Nothing
 * anywhere does `import ... from "@navori/core"`.
 *
 * ## Why this test exists
 *
 * The package used to ALSO export a code entry point (`src/index.ts`) that
 * nobody imported. Being unimported, it silently drifted into a lie: it declared
 * 4 managed assets against the 9 real ones in `lib/render-plan.ts`, kept an
 * `availableLanguages` field the CLI had already replaced with `baseLanguage`,
 * and duplicated `resolveAssetPath` with the pre-#229 fallback semantics. A
 * public export that invites an import and hands back stale data is a deferred
 * bug waiting for its first victim.
 *
 * So: `CORE_MANAGED_ASSETS` and `resolveAssetPath` have exactly ONE definition
 * in the monorepo — `packages/cli/src/lib/render-plan.ts` — and these assertions
 * make it impossible to grow a second one behind an importable specifier without
 * the suite noticing.
 */

interface CorePackageJson {
  name?: string;
  version?: string;
  exports?: Record<string, string>;
  files?: string[];
}

const CORE_ROOT = getCoreRoot();

function readCorePackageJson(): CorePackageJson {
  const path = resolve(CORE_ROOT, "package.json");
  expect(existsSync(path), `@navori/core package.json missing at ${path}`).toBe(true);
  return JSON.parse(readFileSync(path, "utf-8")) as CorePackageJson;
}

describe("@navori/core — no code entry point (#406)", () => {
  it('declares no "." export, so the package cannot be imported as a module', () => {
    const exportsMap = readCorePackageJson().exports ?? {};
    expect(
      Object.keys(exportsMap),
      'adding a "." export re-opens a parallel code surface that drifts from render-plan.ts — ' +
        "keep @navori/core assets-only and put shared code in packages/cli/src/lib/",
    ).not.toContain(".");
  });

  it("exposes only asset paths — every export target lives under core-assets/", () => {
    const exportsMap = readCorePackageJson().exports ?? {};
    expect(Object.keys(exportsMap).length).toBeGreaterThan(0);
    for (const [subpath, target] of Object.entries(exportsMap)) {
      expect(target, `export "${subpath}" must point into core-assets/`).toMatch(
        /^\.\/core-assets\//,
      );
    }
  });

  it("ships no source directory", () => {
    const srcDir = resolve(CORE_ROOT, "src");
    expect(
      existsSync(srcDir),
      `${srcDir} exists — @navori/core ships assets, not code (see #406)`,
    ).toBe(false);
    expect(readCorePackageJson().files ?? []).not.toContain("src");
  });

  it("rejects at runtime when imported by specifier", async () => {
    // Indirection through a variable: a literal specifier would be resolved
    // statically at transform time instead of exercising Node's exports map.
    const specifier = "@navori/core";
    await expect(import(/* @vite-ignore */ specifier)).rejects.toThrow();
  });
});

describe("@navori/core — the filesystem contract still holds (#406)", () => {
  it("getCoreRoot() lands on the package root: package.json + core-assets/", () => {
    expect(existsSync(resolve(CORE_ROOT, "package.json"))).toBe(true);
    expect(existsSync(resolve(CORE_ROOT, "core-assets"))).toBe(true);
  });

  it("keeps a version readable off disk (managed-marker provenance)", () => {
    expect(readCorePackageJson().version ?? "").toMatch(/^\d+\.\d+\.\d+/);
  });

  it("resolveBundledCoreAssetPath() reaches a real managed asset with no import", () => {
    // Same relPath shape as the entries in render-plan.ts's CORE_MANAGED_ASSETS.
    const path = resolveBundledCoreAssetPath("core-assets/managed/idioma-rol.md");
    expect(existsSync(path), `expected a managed asset at ${path}`).toBe(true);
    expect(readFileSync(path, "utf-8").length).toBeGreaterThan(0);
  });
});
