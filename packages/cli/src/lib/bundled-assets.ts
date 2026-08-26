import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";

/**
 * Locate the bundled assets directory. After build, dist/assets/ contains
 * the materialized copies of @navori/core and @navori/plugin-*. In dev
 * (running TS sources directly via Node), we fall back to the workspace
 * package roots so the CLI keeps working without a build.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

// Candidate 1: bundled (dist/assets/ next to the running JS file)
const BUNDLED_ASSETS = resolve(HERE, "assets");

// Candidate 2: dev mode — the workspace `packages/` root. A fixed count of
// `..` is wrong because HERE differs by origin: `src/lib/` (TS loader) sits two
// levels under packages/cli, but a partially-built `dist/` is only one — so the
// same "3 up" lands on `packages/` from src yet on `<repo>/` (→ missing
// `<repo>/core`) from dist. Instead we walk up until we find a dir whose
// `packages/core` exists, which is correct from either origin.
function findDevPackages(): string {
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "packages", "core", "package.json"))) {
      return resolve(dir, "packages");
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  // Fallback to the legacy 3-up guess so errors still point somewhere sane.
  return resolve(HERE, "..", "..", "..");
}

const DEV_PACKAGES = findDevPackages();

function isBundled(): boolean {
  return existsSync(resolve(BUNDLED_ASSETS, "core", "package.json"));
}

export function getCoreRoot(): string {
  if (isBundled()) return resolve(BUNDLED_ASSETS, "core");
  return resolve(DEV_PACKAGES, "core");
}

export function getPluginAssetsRoot(): string {
  if (isBundled()) return resolve(BUNDLED_ASSETS, "plugins");
  return resolve(DEV_PACKAGES, "plugins");
}

export function getPluginPath(pluginId: string): string {
  return resolve(getPluginAssetsRoot(), pluginId);
}

/**
 * `@navori/core`'s own package version — an internal, statically-versioned
 * package, so this is `0.0.1` and does not move with releases. Its ONLY use is
 * the `$navori.version` stamp in the generated `.claude/settings.json`, a
 * write-only provenance note nothing reads back.
 *
 * NOT the anti-rollback signal (#508.3 flagged the mismatch as a risk to it):
 * that guard is `isDowngrade()` in `lib/marker.ts`, which compares the
 * `version=` attribute of managed-block markers, and every stamp site takes
 * that from `readCliVersion()` below. One scale, one source — the two numbers
 * never meet.
 */
export function readBundledCoreVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(getCoreRoot(), "package.json"), "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * The navori CLI's own release version (e.g. "0.2.9"). This is the version that
 * actually bumps every release — unlike `@navori/core`, which is versioned
 * statically. Managed-block markers stamp THIS so the anti-retroceso guard
 * (#79) has a per-release signal to compare: a block written by a newer navori
 * is never silently overwritten by an older one. The `name === "navori"` guard
 * avoids reading a nested package.json (@navori/core) by mistake.
 */
export function readCliVersion(): string {
  for (const candidate of [
    resolve(HERE, "..", "package.json"), // bundled: dist/../package.json
    resolve(HERE, "..", "..", "package.json"), // dev: src/lib/../../package.json
  ]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.version && pkg.name === "navori") return pkg.version;
    } catch {
      // try next candidate
    }
  }
  return "0.0.0";
}

export function resolveBundledCoreAssetPath(relPath: string): string {
  return resolve(getCoreRoot(), relPath);
}

export function bundledPluginManifestPath(pluginId: string): string {
  return resolve(getPluginPath(pluginId), "plugin.json");
}

/** Returns true if running from the published/built CLI (dist/assets/ exists). */
export function isUsingBundledAssets(): boolean {
  return isBundled();
}

/**
 * Provenance of the assets a render actually read. The CLI has TWO possible
 * sources for the same asset — the build-time copy under `dist/assets/` and the
 * live `packages/` sources — and nothing used to say which one won. That silence
 * is the bug: with a stale `dist/`, `render` compares the mirror against
 * YESTERDAY's core, answers `unchanged`, and an `--apply` can even revert the
 * mirror to the older asset, while `pnpm check:render` (which rebuilds first)
 * reports the file as stale. Two commands the repo presents as "the same render"
 * disagreeing, with no way for the user to tell why.
 */
export interface CoreProvenance {
  /** Absolute path of the `@navori/core` root the render read assets from. */
  root: string;
  /** True when `root` is the build-time copy bundled under `dist/assets/`. */
  bundled: boolean;
  /**
   * Absolute path of a live source tree that is NEWER than the bundled copy —
   * i.e. `dist/` is stale and this render is comparing against the previous
   * build. `null` when fresh, and always `null` outside navori's own monorepo
   * (see `findStaleBundleSource`).
   */
  staleSource: string | null;
}

/**
 * Asset trees `scripts/copy-assets.mjs` materializes into `dist/assets/`, as
 * `[path under packages/, path under dist/assets/]`. Keep in sync with it:
 * a tree missing here is a tree the freshness hint can't see.
 *
 * KNOWN GAP: copy-assets also copies `packages/core/package.json`, which is not
 * a tree and is not listed here. Its `version` does reach the mirror (
 * `build-settings.ts` interpolates `{{coreVersion}}` into `settings.json`), so
 * bumping `@navori/core` without rebuilding is real drift this hint cannot see.
 * `check:render` still catches it — the hint is an accelerator, not the gate.
 *
 * The mirror image, also by design: dev-side files with NO bundle counterpart
 * (today every plugin's own `package.json` under `packages/plugins/` — copy-assets takes only
 * `plugin.json` + `{managed,scripts,skills,hooks}`) make the dev side newer on
 * their own, so touching one raises a spurious "rebuild" hint with no content
 * change behind it. Harmless, and the cheaper half of the trade for covering
 * plugins at all.
 */
const BUNDLED_TREES: ReadonlyArray<readonly [string, string]> = [
  ["core/core-assets", "core/core-assets"],
  ["plugins", "plugins"],
];

/** Max directory entries a single freshness walk may visit (see `newestMtimeMs`). */
const MTIME_WALK_BUDGET = 4000;

/**
 * Newest mtime (ms) of any file under `dir`; `0` when the dir can't be walked.
 * `node_modules` and dotfiles are skipped, and the walk shares a hard entry
 * budget across the recursion: this runs on every render, so it must stay a
 * rounding error rather than a scan that grows with the repo.
 */
function newestMtimeMs(dir: string, budget = { left: MTIME_WALK_BUDGET }): number {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let newest = 0;
  for (const entry of entries) {
    if (budget.left <= 0) break;
    budget.left -= 1;
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtimeMs(full, budget));
      continue;
    }
    try {
      newest = Math.max(newest, statSync(full).mtimeMs);
    } catch {
      // A file that vanished mid-walk can't make the bundle stale.
    }
  }
  return newest;
}

/**
 * Is the bundled asset copy in `bundleAssets` older than the `packages/` sources
 * it was built from? Returns the newest source tree when it is, `null` otherwise.
 *
 * DEV-ONLY BY CONSTRUCTION. This is production code, so the branch is fenced
 * twice: the caller only reaches it when running bundled, and here we require
 * `devPackages/core/package.json` to declare `"name": "@navori/core"`. A
 * consumer repo that merely happens to have a `packages/core` never matches, so
 * it can't be nagged about a monorepo it doesn't have.
 *
 * MECHANISM — newest mtime, not content hashes. Hashing the ~200 bundled assets
 * on every render buys exactness nobody needs here: the answer only drives a
 * hint, and `pnpm check:render` remains the real gate. The classic objection to
 * mtime — "a fresh clone rewrites every timestamp" — does not apply, because
 * `dist/` is gitignored build output: right after a clone there is no bundle at
 * all (`isBundled()` is false, so this never runs), and the first `pnpm build`
 * stamps the copies with the build time (`cpSync` does not preserve
 * timestamps). What remains is the intended signal: any source touched AFTER the
 * last build — including by a `git checkout`/rebase, which is exactly the
 * "el re-render caduca al rebasar" trap of #435 — reads as stale.
 * The residuals surface as a missing hint or a spurious warning; neither
 * produces a wrong render.
 */
export function findStaleBundleSource(bundleAssets: string, devPackages: string): string | null {
  try {
    const pkgRaw = readFileSync(resolve(devPackages, "core", "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw) as { name?: string };
    if (pkg.name !== "@navori/core") return null;

    let newestDev = 0;
    let newestDevPath: string | null = null;
    let newestBundle = 0;
    for (const [devRel, bundleRel] of BUNDLED_TREES) {
      const devDir = resolve(devPackages, devRel);
      const devMtime = newestMtimeMs(devDir);
      if (devMtime > newestDev) {
        newestDev = devMtime;
        newestDevPath = devDir;
      }
      newestBundle = Math.max(newestBundle, newestMtimeMs(resolve(bundleAssets, bundleRel)));
    }
    // newestBundle === 0 means the bundle has no readable assets: that's a
    // broken build, not a stale one, and it surfaces as a render error already.
    if (newestBundle === 0 || newestDev <= newestBundle) return null;
    return newestDevPath;
  } catch {
    return null;
  }
}

/**
 * Where did this run's assets come from, and is that source stale? Cheap enough
 * to call once per render. NEVER throws and never blocks: `staleSource` only
 * feeds a warning, so the worst case is losing the hint — a repo that trips any
 * edge of the heuristic still gets its render.
 */
export function describeCoreProvenance(): CoreProvenance {
  const bundled = isBundled();
  return {
    root: getCoreRoot(),
    bundled,
    staleSource: bundled ? findStaleBundleSource(BUNDLED_ASSETS, DEV_PACKAGES) : null,
  };
}

/** Names of plugins shipped with the CLI bundle. */
export function listBundledPluginIds(): string[] {
  const root = getPluginAssetsRoot();
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root).filter((entry) => {
      try {
        return statSync(join(root, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
