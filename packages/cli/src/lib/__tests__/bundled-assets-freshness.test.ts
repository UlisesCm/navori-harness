import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { findStaleBundleSource } from "../bundled-assets.ts";

/**
 * Freshness guard for the bundled asset copy.
 *
 * `render` reads `dist/assets/core`, a build-time COPY of `packages/core`, while
 * `pnpm check:render` rebuilds that copy BEFORE rendering. With a stale `dist/`
 * the two answer about different assets: render compares the mirror against
 * yesterday's core, says `unchanged`, and an `--apply` can even revert the
 * mirror to the older asset. Measured on `main` @ 416d39e: 4 files would have
 * been silently rewritten backwards.
 *
 * The guard is a HINT, so what these tests pin is as much what it must NOT do
 * (fire outside navori's monorepo, throw, or block) as what it must catch.
 */

/** Seconds → ms, as a fixed instant. Fixed instants keep the test clock-race free. */
const T0 = 1_700_000_000_000;

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

interface Layout {
  /** `<root>/packages` — the live sources. */
  devPackages: string;
  /** `<root>/dist/assets` — the build-time copy. */
  bundleAssets: string;
}

/** Write `content` at `file` (creating parents) and stamp it at `mtimeMs`. */
function writeAt(file: string, content: string, mtimeMs: number): void {
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, content, "utf-8");
  const seconds = mtimeMs / 1000;
  utimesSync(file, seconds, seconds);
}

/**
 * Minimal two-tier layout: live `packages/core/core-assets` + the build copy
 * under `dist/assets/core/core-assets`. `coreName` drives the identity check
 * that fences the guard to navori's own monorepo.
 */
function seedLayout(opts: { devMtime: number; bundleMtime: number; coreName?: string }): Layout {
  const root = mkdtempSync(join(tmpdir(), "navori-freshness-"));
  dirs.push(root);
  const devPackages = join(root, "packages");
  const bundleAssets = join(root, "dist", "assets");

  writeAt(
    join(devPackages, "core", "package.json"),
    JSON.stringify({ name: opts.coreName ?? "@navori/core", version: "0.0.0" }),
    opts.devMtime,
  );
  writeAt(join(devPackages, "core", "core-assets", "agents", "leader.md"), "v1\n", opts.devMtime);
  writeAt(
    join(bundleAssets, "core", "core-assets", "agents", "leader.md"),
    "v1\n",
    opts.bundleMtime,
  );
  return { devPackages, bundleAssets };
}

describe("findStaleBundleSource — is dist/ behind packages/?", () => {
  it("returns null when the build copy is newer than the sources (the normal case)", () => {
    const { devPackages, bundleAssets } = seedLayout({
      devMtime: T0 - 60_000,
      bundleMtime: T0,
    });
    expect(findStaleBundleSource(bundleAssets, devPackages)).toBeNull();
  });

  it("names the source tree when a core asset was touched after the last build", () => {
    const { devPackages, bundleAssets } = seedLayout({
      devMtime: T0 - 60_000,
      bundleMtime: T0 - 30_000,
    });
    // The developer edits the SOURCE and does not rebuild — the exact state in
    // which a bare `render --apply` reverts the mirror.
    writeAt(join(devPackages, "core", "core-assets", "agents", "leader.md"), "v2\n", T0);

    expect(findStaleBundleSource(bundleAssets, devPackages)).toBe(
      resolve(devPackages, "core/core-assets"),
    );
  });

  it("also catches a PLUGIN asset, not just the core (#429 slipped in exactly there)", () => {
    const { devPackages, bundleAssets } = seedLayout({
      devMtime: T0 - 60_000,
      bundleMtime: T0 - 30_000,
    });
    writeAt(join(bundleAssets, "plugins", "engram", "plugin.json"), "{}\n", T0 - 30_000);
    writeAt(join(devPackages, "plugins", "engram", "skills", "x.md"), "v2\n", T0);

    expect(findStaleBundleSource(bundleAssets, devPackages)).toBe(resolve(devPackages, "plugins"));
  });

  it("stays silent in a consumer repo that merely happens to have packages/core", () => {
    // Constraint: this branch is dev-only. A consumer with an unrelated
    // `packages/core` must never be nagged about a monorepo it doesn't have —
    // and, above all, must never lose its render over it.
    const { devPackages, bundleAssets } = seedLayout({
      devMtime: T0,
      bundleMtime: T0 - 30_000,
      coreName: "@acme/core",
    });
    expect(findStaleBundleSource(bundleAssets, devPackages)).toBeNull();
  });

  it("stays silent when there are no live sources at all (published install)", () => {
    const { bundleAssets } = seedLayout({ devMtime: T0, bundleMtime: T0 - 30_000 });
    expect(findStaleBundleSource(bundleAssets, join(tmpdir(), "navori-does-not-exist"))).toBeNull();
  });

  it("stays silent when the bundle has no readable assets (broken build ≠ stale build)", () => {
    const { devPackages } = seedLayout({ devMtime: T0, bundleMtime: T0 - 30_000 });
    expect(findStaleBundleSource(join(tmpdir(), "navori-no-bundle"), devPackages)).toBeNull();
  });

  it("never throws on a malformed core package.json", () => {
    const { devPackages, bundleAssets } = seedLayout({
      devMtime: T0,
      bundleMtime: T0 - 30_000,
    });
    writeAt(join(devPackages, "core", "package.json"), "{ not json", T0);
    expect(() => findStaleBundleSource(bundleAssets, devPackages)).not.toThrow();
    expect(findStaleBundleSource(bundleAssets, devPackages)).toBeNull();
  });
});
