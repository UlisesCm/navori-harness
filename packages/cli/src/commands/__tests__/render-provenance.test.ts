import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Render provenance + freshness, end to end.
 *
 * The bug: `render` reads `packages/cli/dist/assets/core`, a build-time COPY of
 * `packages/core`, while `pnpm check:render` rebuilds that copy first. With a
 * stale `dist/` the two commands answer about DIFFERENT assets — render reports
 * `unchanged` over a mirror that is actually ahead of the copy, and an `--apply`
 * rewrites the mirror BACKWARDS. Nothing in the output said which core produced
 * the answer, so the contradiction was unattributable.
 *
 * These specs reproduce the two-tier layout (source + build copy) so the stale
 * state is real rather than mocked, and pin the three guarantees:
 *   - `--json` publishes the provenance (`coreRoot`, `bundled`),
 *   - a stale bundle is ANNOUNCED (`staleCore` + a human warning),
 *   - and announcing it never costs the user their render (warning, not error).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_DIST = resolve(__dirname, "..", "..", "..", "dist");
const CLI = join(REAL_DIST, "index.js");

/** Throwaway HOME so nothing self-registers into the real ~/.navori. */
const E2E_HOME = mkdtempSync(join(tmpdir(), "navori-prov-home-"));
afterAll(() => rmSync(E2E_HOME, { recursive: true, force: true }));

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  combined: string;
}

function runCli(cliPath: string, args: string[]): RunResult {
  const r = spawnSync("node", [cliPath, ...args], {
    encoding: "utf-8",
    env: { ...process.env, HOME: E2E_HOME, FORCE_COLOR: "0" },
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    combined: (r.stdout ?? "") + (r.stderr ?? ""),
  };
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Stamp every file under `dir` at `mtimeMs` — fixed instants, no clock races. */
function stampTree(dir: string, mtimeMs: number): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) stampTree(full, mtimeMs);
    else utimesSync(full, mtimeMs / 1000, mtimeMs / 1000);
  }
  utimesSync(dir, mtimeMs / 1000, mtimeMs / 1000);
}

const T0 = 1_700_000_000_000;

interface Fixture {
  /** The CLI to spawn — `<fake>/packages/cli/dist/index.js`. */
  cli: string;
  /** Live source tree the developer edits. */
  sourceCore: string;
  /** Build copy the CLI actually reads. */
  bundleCore: string;
  /** Repo rendered by that CLI. */
  project: string;
  /** The asset-copy half of `pnpm build` (copy-assets.mjs: wipe + full copy). */
  build: () => void;
}

/**
 * Reproduce navori's own two-level layout in a temp dir:
 *   <fake>/packages/core/core-assets      ← SOURCE the developer edits
 *   <fake>/packages/cli/dist/assets/core  ← BUILD COPY the CLI reads
 * `findDevPackages()` walks up from the running JS file until it finds a dir
 * whose `packages/core/package.json` exists, so this layout is what makes the
 * dev-only freshness branch reachable at all.
 */
function seedFakeMonorepo(): Fixture {
  // realpath: on macOS `os.tmpdir()` is the /var → /private/var symlink, and the
  // CLI reports paths resolved through `import.meta.url` (already real). Compare
  // like with like or every path assertion here is a coin flip.
  const base = realpathSync(tempDir("navori-prov-"));
  const repo = join(base, "repo");
  const dist = join(repo, "packages", "cli", "dist");
  const sourcePkg = join(repo, "packages", "core");

  mkdirSync(join(repo, "packages", "cli"), { recursive: true });
  cpSync(REAL_DIST, dist, { recursive: true });
  mkdirSync(sourcePkg, { recursive: true });
  cpSync(join(dist, "assets", "core", "core-assets"), join(sourcePkg, "core-assets"), {
    recursive: true,
  });
  cpSync(join(dist, "assets", "core", "package.json"), join(sourcePkg, "package.json"));

  const bundleCore = join(dist, "assets", "core", "core-assets");
  const sourceCore = join(sourcePkg, "core-assets");

  const build = (): void => {
    rmSync(bundleCore, { recursive: true, force: true });
    cpSync(sourceCore, bundleCore, { recursive: true });
    // A real `pnpm build` stamps the copies with the build time (cpSync does not
    // preserve timestamps); reproduce that explicitly so the test never races.
    stampTree(sourceCore, T0 - 60_000);
    stampTree(join(dist, "assets"), T0);
  };
  build();

  const project = join(base, "proj");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, "navori.config.json"),
    JSON.stringify({
      name: "prov",
      version: "1.0.0",
      engines: ["claude"],
      preset: "custom",
      branchBase: "main",
      commits: "conventional-es",
    }),
    "utf-8",
  );

  return { cli: join(dist, "index.js"), sourceCore, bundleCore, project, build };
}

/** Edit a managed asset at the SOURCE, after the last build. No rebuild. */
function editSourceAsset(fx: Fixture): string {
  const rel = join("agents", "commit-pr-pilot.md");
  const file = join(fx.sourceCore, rel);
  const before = readFileSync(file, "utf-8");
  writeFileSync(
    file,
    before.replace("# Commit & PR Pilot Agent", "# Commit & PR Pilot Agent\n\nPROVENANCE-V2-LINE"),
    "utf-8",
  );
  utimesSync(file, T0 / 1000 + 60, T0 / 1000 + 60);
  return rel;
}

interface RenderJson {
  coreRoot: string;
  bundled: boolean;
  staleCore: string | null;
  root: { written: Array<{ path: string; status: string }> };
}

const renderJson = (fx: Fixture): RenderJson =>
  JSON.parse(runCli(fx.cli, ["render", "--json", "--cwd", fx.project]).stdout) as RenderJson;

describe("render provenance — which core produced this answer", () => {
  beforeAll(() => {
    if (!existsSync(CLI)) throw new Error(`CLI not built at ${CLI}. Run 'pnpm build' first.`);
  });

  it("--json publishes coreRoot + bundled so two 'identical' renders are attributable", () => {
    const fx = seedFakeMonorepo();
    const report = renderJson(fx);

    expect(report.bundled).toBe(true);
    // The build COPY, not the live sources: naming it is the whole point.
    expect(report.coreRoot).toBe(resolve(fx.bundleCore, ".."));
    expect(report.staleCore).toBeNull();
  });

  it("the human report names the core it read", () => {
    const fx = seedFakeMonorepo();
    const r = runCli(fx.cli, ["render", "--cwd", fx.project]);

    expect(r.status).toBe(0);
    expect(r.combined).toContain("core:");
    expect(r.combined).toContain(resolve(fx.bundleCore, ".."));
  });
});

describe("render freshness — a stale dist/ can no longer answer in silence", () => {
  it("announces the stale bundle even while the plan itself says nothing changed", () => {
    const fx = seedFakeMonorepo();
    expect(runCli(fx.cli, ["render", "--apply", "--cwd", fx.project]).status).toBe(0);

    // The developer edits the SOURCE asset and does NOT rebuild.
    const rel = editSourceAsset(fx);
    const report = renderJson(fx);

    // THE BUG, still present by construction: the plan compares the mirror
    // against the OLD copy, so it sees nothing to write...
    expect(report.root.written.map((w) => w.path)).not.toContain(join(".claude", rel));
    // ...but the render now says WHY that answer can't be trusted.
    expect(report.staleCore).toBe(fx.sourceCore);
  });

  it("a stale bundle is a WARNING, never an error: the render still runs and writes", () => {
    const fx = seedFakeMonorepo();
    expect(runCli(fx.cli, ["render", "--apply", "--cwd", fx.project]).status).toBe(0);
    editSourceAsset(fx);

    const r = runCli(fx.cli, ["render", "--apply", "--cwd", fx.project]);

    // Non-negotiable: a consumer repo that happens to trip the heuristic cannot
    // be left without a render.
    expect(r.status).toBe(0);
    expect(existsSync(join(fx.project, "CLAUDE.md"))).toBe(true);
    expect(r.combined).toMatch(/dist\/? (es más viejo|is older)/);
    expect(r.combined).toContain("pnpm --filter navori build");
  });

  it("clears itself once the build runs, and only then does the file show as stale", () => {
    const fx = seedFakeMonorepo();
    expect(runCli(fx.cli, ["render", "--apply", "--cwd", fx.project]).status).toBe(0);
    const rel = editSourceAsset(fx);

    fx.build();
    const report = renderJson(fx);

    // Direction check: the warning is not a permanent alarm, and the drift it
    // was pointing at is real — after the build the file IS pending.
    expect(report.staleCore).toBeNull();
    expect(report.root.written.map((w) => w.path)).toContain(join(".claude", rel));
  });

  it("reports no stale source when the bundle was just built from these sources", () => {
    // Same real CLI, rendered from its own dist with no sibling packages/core:
    // the freshness branch must not exist for consumers.
    const project = tempDir("navori-prov-consumer-");
    writeFileSync(
      join(project, "navori.config.json"),
      JSON.stringify({
        name: "consumer",
        version: "1.0.0",
        engines: ["claude"],
        preset: "custom",
        branchBase: "main",
        commits: "conventional-es",
      }),
      "utf-8",
    );

    const r = runCli(CLI, ["render", "--json", "--cwd", project]);
    const report = JSON.parse(r.stdout) as RenderJson;

    expect(r.status).toBe(0);
    expect(report.bundled).toBe(true);
    // This repo IS the navori monorepo, so `staleCore` is only null when dist is
    // genuinely fresh — vitest's globalSetup builds before the suite, so it is.
    expect(report.staleCore).toBeNull();
    expect(statSync(report.coreRoot).isDirectory()).toBe(true);
  });
});
