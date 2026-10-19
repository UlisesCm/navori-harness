import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Spec 0055 R15 — CLI surface golden.
 *
 * Runs `<dist>/index.js` for `--version`, `--help`, `<sub> --help` of every
 * subcommand listed in the root usage line, and an unknown command, and records
 * stdout, stderr and the exit code of each. The golden is captured ONCE from the
 * base `dist/` (before any product change); `cli-surface.test.ts` compares a later
 * `dist/` against it.
 *
 * Usage: node scripts/capture-cli-surface.mjs [--dist <index.js>] [--out <golden.json>]
 */

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_DIST = join(PACKAGE_ROOT, "dist", "index.js");
export const GOLDEN_PATH = join(
  PACKAGE_ROOT,
  "src",
  "__tests__",
  "fixtures",
  "cli-surface.golden.json",
);
const UNKNOWN_COMMAND = "no-such-command";

/**
 * @typedef {{ args: string[], status: number, stdout: string, stderr: string }} SurfaceCase
 */

/**
 * Runs the CLI with an isolated HOME so the update-notice state never touches the user's.
 *
 * @param {string} dist absolute path to `index.js`
 * @param {string[]} args
 * @param {string} home scratch HOME
 * @returns {SurfaceCase}
 */
export function runSurface(dist, args, home) {
  const run = spawnSync("node", [dist, ...args], {
    encoding: "utf8",
    cwd: home,
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", HOME: home, NO_COLOR: "1" },
  });
  // `gate --help` prints the cwd as the default of `--cwd`: mask the scratch dir and the
  // column padding that depends on its length (it differs between macOS and Linux tmpdirs).
  const mask = (text) =>
    text
      .replaceAll(realpathSync(home), "<HOME>")
      .replaceAll(home, "<HOME>")
      .replace(/ {2,}/g, "  ");
  return {
    args,
    status: run.status ?? -1,
    stdout: mask(run.stdout ?? ""),
    stderr: mask(run.stderr ?? ""),
  };
}

/**
 * Subcommand names from the root `--help` usage line (`USAGE navori a|b|c`).
 *
 * @param {string} rootHelp
 * @returns {string[]}
 */
export function parseSubcommands(rootHelp) {
  const usage = /^USAGE navori (\S+)$/m.exec(rootHelp);
  if (!usage?.[1]) throw new Error("cannot read the subcommand list from the root --help");
  return usage[1].split("|");
}

/**
 * Captures the whole surface of a `dist/index.js`.
 *
 * @param {string} dist
 * @returns {SurfaceCase[]}
 */
export function captureSurface(dist) {
  const home = mkdtempSync(join(tmpdir(), "navori-cli-surface-"));
  try {
    const root = runSurface(dist, ["--help"], home);
    const subs = parseSubcommands(root.stdout);
    return [
      runSurface(dist, ["--version"], home),
      root,
      ...subs.map((sub) => runSurface(dist, [sub, "--help"], home)),
      runSurface(dist, [UNKNOWN_COMMAND], home),
    ];
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** @param {string[]} argv */
function main(argv) {
  const flag = (name, fallback) => {
    const at = argv.indexOf(name);
    return at === -1 ? fallback : resolve(argv[at + 1] ?? fallback);
  };
  const cases = captureSurface(flag("--dist", DEFAULT_DIST));
  writeFileSync(flag("--out", GOLDEN_PATH), `${JSON.stringify({ cases }, null, 2)}\n`);
  process.stdout.write(`capture-cli-surface: ${cases.length} cases\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
