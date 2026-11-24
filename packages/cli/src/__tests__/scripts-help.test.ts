import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Every scripts/js entry that writes or compiles answers `--help` / `-h` with its usage on stdout
 * and exit 0 BEFORE any side effect (the rust-hooks-sync incident: `--help` was ignored and ran a
 * build + `render --apply`).
 *
 * A regression must be harmless, so scripts never run against the real repo: `scripts/js` is copied
 * into a scratch root (scripts resolve REPO_ROOT from their own location), the cwd is that root
 * (not a git repo), HOME is a scratch dir, and PATH holds only stubs of the tools a script could
 * spawn, which record every call. The test asserts the root is byte-for-byte unchanged and that no
 * tool was called.
 */

const REAL_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const REAL_SCRIPTS = join(REAL_ROOT, "scripts", "js");
const STUBBED_TOOLS = [
  "git",
  "cargo",
  "bun",
  "npm",
  "npx",
  "pnpm",
  "docker",
  "tar",
  "rustc",
] as const;

const SCRIPTS = [
  "bench-context",
  "bench-hooks",
  "dist-assemble",
  "dist-legacy-cutover",
  "gen-pi-extension-asset",
  "hook-fuzz",
  "hook-verdict-replay",
  "install-git-hooks",
  "post-cutover-check",
  "probe-lazy-load",
  "rust-hooks-sync",
  "rust-oracle",
  "rust-verify",
  "test-import-graph",
  "rust-oracle/plan-tables",
  "rust-oracle/tools-tables",
] as const;

let base: string;
let root: string;
let home: string;
let binDir: string;
let callsFile: string;

/** Every file under `dir` as `relative path | size | mtime`, sorted: any write changes it. */
function snapshot(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) out.push(`${rel}/`, ...snapshot(path, `${rel}/`));
    else {
      const stat = lstatSync(path);
      out.push(`${rel}|${stat.size}|${stat.mtimeMs}`);
    }
  }
  return out.sort();
}

beforeAll(() => {
  // Real path: on macOS tmpdir() is a symlink (/var -> /private/var) and the scripts' entry guard
  // compares argv[1] with the resolved import.meta.url, so a symlinked path skips main (#1816).
  base = realpathSync(mkdtempSync(join(tmpdir(), "navori-scripts-help-")));
  root = join(base, "root");
  home = join(base, "home");
  binDir = join(base, "bin");
  callsFile = join(base, "calls.log");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(home);
  mkdirSync(binDir);
  writeFileSync(callsFile, "");
  cpSync(REAL_SCRIPTS, join(root, "scripts", "js"), { recursive: true });
  // Some scripts import library modules of the CLI at load time (not tests): copy them, and link
  // node_modules so bare specifiers resolve. The link is dependency lookup only; it is never a
  // path a script writes to.
  const cliSrc = join(REAL_ROOT, "packages", "cli", "src");
  cpSync(cliSrc, join(root, "packages", "cli", "src"), {
    recursive: true,
    filter: (source) => !source.includes("__tests__"),
  });
  cpSync(
    join(REAL_ROOT, "packages", "cli", "package.json"),
    join(root, "packages", "cli", "package.json"),
  );
  // post-cutover-check reads the manifest at module load (read-only), before its entry guard.
  mkdirSync(join(root, "crates"));
  cpSync(join(REAL_ROOT, "crates", "ported.json"), join(root, "crates", "ported.json"));
  symlinkSync(join(REAL_ROOT, "node_modules"), join(root, "node_modules"));
  symlinkSync(
    join(REAL_ROOT, "packages", "cli", "node_modules"),
    join(root, "packages", "cli", "node_modules"),
  );
  for (const tool of STUBBED_TOOLS) {
    const stub = join(binDir, tool);
    writeFileSync(stub, `#!/bin/sh\necho "${tool} $*" >> "${callsFile}"\nexit 97\n`);
    chmodSync(stub, 0o755);
  }
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("scripts/js --help / -h", () => {
  for (const name of SCRIPTS) {
    it.each(["--help", "-h"])(
      `${name} ${"%s"} prints usage, exits 0, has no side effect`,
      (flag) => {
        const before = snapshot(root);
        const result = spawnSync(
          process.execPath,
          [join(root, "scripts", "js", `${name}.mjs`), flag],
          {
            cwd: root,
            encoding: "utf8",
            timeout: 30_000,
            env: { PATH: binDir, HOME: home, TMPDIR: join(base, "home") },
          },
        );
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain(`usage: node scripts/js/${name}.mjs`);
        expect(result.stdout).toContain("-h, --help");
        expect(result.stderr).toBe("");
        expect(snapshot(root)).toEqual(before);
        expect(readFileSync(callsFile, "utf8")).toBe("");
        expect(readdirSync(home)).toEqual([]);
      },
    );
  }

  it("hook-shadow-report -h keeps printing its usage", () => {
    const before = snapshot(root);
    const script = join(root, "scripts", "js", "hook-shadow-report.mjs");
    const result = spawnSync(process.execPath, [script, "-h"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: binDir, HOME: home, TMPDIR: join(base, "home") },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("usage: node scripts/js/hook-shadow-report.mjs");
    expect(snapshot(root)).toEqual(before);
    expect(readFileSync(callsFile, "utf8")).toBe("");
  });
});

describe("gen-pi-extension-asset.mjs rejects unknown arguments (#1789)", () => {
  // Any argument other than --check used to fall through to the write path and rewrite
  // crates/navori-core/assets/pi/extension.ts.in from whatever dist NAVORI_TS_CLI pointed at.
  it.each([["--bogus"], ["--check", "--bogus"], ["check"], ["--chek"]])(
    "%s exits 2, names the argument and writes nothing",
    (...args) => {
      const before = snapshot(root);
      const result = spawnSync(
        process.execPath,
        [join(root, "scripts", "js", "gen-pi-extension-asset.mjs"), ...args],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            PATH: binDir,
            HOME: home,
            TMPDIR: join(base, "home"),
            NAVORI_TS_CLI: join(base, "missing.js"),
          },
        },
      );
      const bad = args.find((arg) => arg !== "--check");
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`unknown argument: ${bad}`);
      expect(result.stderr).toContain("usage: node scripts/js/gen-pi-extension-asset.mjs");
      expect(snapshot(root)).toEqual(before);
      expect(readFileSync(callsFile, "utf8")).toBe("");
    },
  );
});
