import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireDistLock,
  releaseOnProcessExit,
  type DistLockHandle,
} from "../vitest.distLock.ts";

/**
 * Spec 0054 D2 — build `dist/` only when its inputs changed.
 *
 * The seal `dist/.build-fingerprint` holds the fingerprint computed BEFORE the
 * build, and is written only after a build that exited 0, produced
 * `dist/index.js`, and left the inputs unchanged (an edit during the build must
 * not be sealed against a dist that lacks it). `tsdown` runs with `clean: true`,
 * which wipes the seal when a build starts.
 *
 * The caller owns the dist lock for the whole time it uses `dist/`
 * (`vitest.globalSetup.ts`, `check-render-locked.ts`, or this file's own entry
 * point). The lock is not reentrant, so `ensureDist` never acquires it.
 */

const SEAL_FILE = ".build-fingerprint";

export interface BuildOutcome {
  status: number | null;
  output?: string;
}

export interface EnsureDistOptions {
  /** Absolute path of `packages/cli`. */
  packageRoot: string;
  /** The caller already holds the dist lock; `ensureDist` never takes it. */
  lockHeld: true;
  /** Test seam: replaces `bun run build`. */
  build?: () => BuildOutcome;
  /** Test seam: replaces the bun/node/tsdown version probe. */
  versions?: string;
}

export interface EnsureDistResult {
  /** True when a build ran in this call. */
  built: boolean;
  /** True when `dist/.build-fingerprint` now matches the inputs. */
  sealed: boolean;
}

function git(repoRoot: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 28 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function toolVersions(packageRoot: string, repoRoot: string): string {
  // Spawned, not `process.version`: bun reports a Node-compat version that differs from real node,
  // and the fingerprint must be identical whichever runtime computes it (vitest vs bun).
  const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
  const node = spawnSync("node", ["--version"], { encoding: "utf8" });
  const declared = (() => {
    try {
      const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
        devDependencies?: Record<string, string>;
      };
      return pkg.devDependencies?.tsdown ?? "undeclared";
    } catch {
      return "unreadable";
    }
  })();
  const installed = [
    join(packageRoot, "node_modules/tsdown/package.json"),
    join(repoRoot, "node_modules/tsdown/package.json"),
  ].flatMap((path) => {
    try {
      return [(JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version ?? "?"];
    } catch {
      return [];
    }
  });
  return [`bun=${bun.stdout.trim() || "unknown"}`, `node=${node.stdout.trim() || "unknown"}`, `tsdown=${declared}@${installed[0] ?? "none"}`].join(";");
}

function listDirFiles(dir: string, pattern: RegExp): string[] {
  try {
    return readdirSync(dir).filter((name) => pattern.test(name));
  } catch {
    return [];
  }
}

/** Repo-relative, sorted, de-duplicated list of every file that feeds the build. */
function inputPaths(repoRoot: string, packageRoot: string): string[] {
  const cliRel = packageRoot.slice(repoRoot.length + 1) || ".";
  const listed = git(repoRoot, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    `${cliRel}/src`,
    "packages/core",
    "packages/plugins",
  ])
    .split("\0")
    .filter((path) => path !== "" && !path.split("/").includes("__tests__"));
  const fixed = [
    "package.json",
    "bunfig.toml",
    "bun.lock",
    "bun.lockb",
    ...listDirFiles(repoRoot, /^tsconfig.*\.json$/),
    ...["package.json", "tsdown.config.ts", "scripts/copy-assets.mjs", "scripts/bundle-comments.ts", "scripts/bundle-render-data.ts"].map(
      (name) => `${cliRel}/${name}`,
    ),
    ...listDirFiles(packageRoot, /^tsconfig.*\.json$/).map((name) => `${cliRel}/${name}`),
  ];
  return [...new Set([...listed, ...fixed])].sort();
}

/**
 * Fingerprint of everything that feeds `dist/`. A listed file that no longer
 * exists contributes `deleted`, so a deletion changes the hash instead of
 * crashing it. Content is hashed in-process (no git object is written).
 */
export function computeFingerprint(packageRoot: string, versions?: string): string {
  const root = realpathSync(resolve(packageRoot));
  const repoRoot = git(root, ["rev-parse", "--show-toplevel"]).trim();
  const lines = inputPaths(repoRoot, root).map((path) => {
    const abs = join(repoRoot, path);
    try {
      if (!statSync(abs).isFile()) return `nonfile\t${path}`;
      return `${sha256(readFileSync(abs))}\t${path}`;
    } catch {
      return `deleted\t${path}`;
    }
  });
  lines.push(`versions\t${versions ?? toolVersions(root, repoRoot)}`);
  return sha256(lines.join("\n"));
}

function defaultBuild(packageRoot: string): BuildOutcome {
  const result = spawnSync("bun", ["run", "build"], {
    cwd: packageRoot,
    // Piped so a green build adds nothing to the caller's log; shown only on failure.
    stdio: "pipe",
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * Builds `dist/` unless its seal matches the current input fingerprint.
 *
 * @throws when the build exits non-zero or leaves no `dist/index.js`.
 */
export function ensureDist(options: EnsureDistOptions): EnsureDistResult {
  const packageRoot = resolve(options.packageRoot);
  const dist = join(packageRoot, "dist");
  const sealPath = join(dist, SEAL_FILE);
  const before = computeFingerprint(packageRoot, options.versions);

  if (existsSync(join(dist, "index.js")) && existsSync(sealPath)) {
    if (readFileSync(sealPath, "utf8").trim() === before) return { built: false, sealed: true };
  }

  rmSync(sealPath, { force: true });
  const outcome = (options.build ?? (() => defaultBuild(packageRoot)))();
  if (outcome.status !== 0 || !existsSync(join(dist, "index.js"))) {
    if (outcome.output) process.stderr.write(outcome.output);
    throw new Error(
      `ensureDist: build failed (exit ${outcome.status ?? "signal"}) or ${join(dist, "index.js")} is missing.`,
    );
  }

  const after = computeFingerprint(packageRoot, options.versions);
  if (after !== before) return { built: true, sealed: false };
  mkdirSync(dist, { recursive: true });
  writeFileSync(sealPath, `${before}\n`);
  return { built: true, sealed: true };
}

/** Standalone entry (`bun packages/cli/scripts/ensure-dist.ts`): takes the lock, ensures, releases. */
async function main(): Promise<void> {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const lock: DistLockHandle = await acquireDistLock({ packageRoot });
  const disarm = releaseOnProcessExit(lock);
  try {
    const { built } = ensureDist({ packageRoot, lockHeld: true });
    process.stdout.write(built ? "ensure-dist: built dist/\n" : "ensure-dist: dist/ is up to date\n");
  } finally {
    disarm();
    lock.release();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
