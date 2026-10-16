import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runGate } from "../lib/gate/run.ts";

/**
 * The versioned `scripts/git-hooks/pre-commit` runs `gate probe --index` before
 * `bun run check:fast`. A `bun` shim on PATH stands in for the gate (`run` appends to a
 * log) and, for the probe, either answers a scripted exit code or hands over to the real
 * CLI, so both the hook's control flow and the real index/temporary-index behaviour run.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const HOOK = resolve(REPO_ROOT, "scripts", "git-hooks", "pre-commit");
const CLI_INDEX = resolve(REPO_ROOT, "packages", "cli", "src", "index.ts");

const realBun = (() => {
  const found = spawnSync("which", ["bun"], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : "";
})();

let repo: string;
let bin: string;
let log: string;
let envLog: string;

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  return { ...env, PATH: `${bin}:${process.env.PATH ?? ""}`, ...extra };
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", env: cleanEnv() }).trim();
}

/** `git commit` with the hook live; returns the exit status and what the shim saw. */
function commit(args: string[], probe: string): { status: number | null; gateRuns: number } {
  writeFileSync(log, "");
  const result = spawnSync("git", ["commit", "-q", "-m", "x", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: cleanEnv({ PROBE_MODE: probe }),
  });
  const gateRuns = readFileSync(log, "utf8").split("\n").filter(Boolean).length;
  return { status: result.status, gateRuns };
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "navori-probe-")));
  bin = realpathSync(mkdtempSync(join(tmpdir(), "navori-probe-bin-")));
  log = join(bin, "gate-runs.log");
  envLog = join(bin, "probe-env.log");
  writeFileSync(
    join(bin, "bun"),
    `#!/usr/bin/env bash
if [ "$1" = --version ]; then exec "${realBun}" --version; fi
if [ "$1" = run ]; then echo "$*" >> "${log}"; exit 0; fi
env | grep '^GIT_' | sort > "${envLog}"
case "\${PROBE_MODE:-real}" in
  hit) exit 0 ;;
  miss) exit 1 ;;
  old) echo 'navori gate: unknown kind "probe"' >&2; exit 2 ;;
  crash) kill -SEGV $$ ;;
  real) exec "${realBun}" "${CLI_INDEX}" "\${@:2}" ;;
esac
`,
  );
  chmodSync(join(bin, "bun"), 0o755);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "p", version: "1.0.0", scripts: { ok: "echo hi" } }),
  );
  writeFileSync(
    join(repo, "navori.config.json"),
    JSON.stringify({
      name: "p",
      engines: ["claude"],
      preset: "custom",
      qualityGate: { fast: "npm run ok", full: "npm run ok" },
    }),
  );
  writeFileSync(join(repo, "a.txt"), "a\n");
  writeFileSync(join(repo, "b.txt"), "b\n");
  git("add", "-A");
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "base"], {
    cwd: repo,
    env: cleanEnv(),
  });
  copyFileSync(HOOK, join(repo, ".git", "hooks", "pre-commit"));
  chmodSync(join(repo, ".git", "hooks", "pre-commit"), 0o755);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

describe("pre-commit probe", () => {
  // Covers: R17
  it("skips the gate on a hit and runs it on a miss, a crash or an older CLI", () => {
    writeFileSync(join(repo, "a.txt"), "1\n");
    git("add", "a.txt");
    expect(commit([], "hit")).toEqual({ status: 0, gateRuns: 0 });

    for (const mode of ["miss", "old", "crash"]) {
      writeFileSync(join(repo, "a.txt"), `${mode}\n`);
      git("add", "a.txt");
      expect(commit([], mode), mode).toEqual({ status: 0, gateRuns: 1 });
    }
  });

  // Covers: R17
  it("hands the probe only an absolute GIT_INDEX_FILE and no other GIT_* variable", () => {
    writeFileSync(join(repo, "a.txt"), "env\n");
    git("add", "a.txt");
    expect(commit([], "hit").status).toBe(0);
    const seen = readFileSync(envLog, "utf8").split("\n").filter(Boolean);
    expect(seen.filter((line) => line.startsWith("GIT_INDEX_FILE="))).toEqual([
      expect.stringMatching(/^GIT_INDEX_FILE=\//),
    ]);
    // Git also exports GIT_EXEC_PATH, GIT_AUTHOR_*, GIT_EDITOR…; the repo-local ones are gone.
    const names = seen.map((line) => line.split("=")[0]);
    for (const name of ["GIT_DIR", "GIT_PREFIX", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) {
      expect(names).not.toContain(name);
    }
  });

  it.skipIf(realBun === "")(
    // Covers: R17
    "real CLI: a recorded green skips the commit's gate, `git commit <path>` uses the temporary index",
    async () => {
      // Plain commit of the recorded bytes: hit.
      writeFileSync(join(repo, "a.txt"), "one\n");
      await runGate({ cwd: repo, kind: "fast" });
      git("add", "a.txt");
      expect(commit([], "real")).toEqual({ status: 0, gateRuns: 0 });

      // Unrecorded bytes: miss, the gate runs.
      writeFileSync(join(repo, "a.txt"), "two\n");
      git("add", "a.txt");
      expect(commit([], "real")).toEqual({ status: 0, gateRuns: 1 });

      // `git commit a.txt` with b.txt also edited: git commits a temporary index holding
      // a.txt (new) and b.txt (as in HEAD). Recorded on both edits => not those bytes => miss.
      writeFileSync(join(repo, "a.txt"), "three\n");
      writeFileSync(join(repo, "b.txt"), "edited\n");
      await runGate({ cwd: repo, kind: "fast" });
      expect(commit(["a.txt"], "real")).toEqual({ status: 0, gateRuns: 1 });

      // Recorded on exactly the bytes the temporary index will hold: hit.
      writeFileSync(join(repo, "a.txt"), "four\n");
      git("checkout", "--", "b.txt");
      await runGate({ cwd: repo, kind: "fast" });
      expect(commit(["a.txt"], "real")).toEqual({ status: 0, gateRuns: 0 });
      expect(existsSync(join(repo, ".git", "index.lock"))).toBe(false);
    },
    60_000,
  );
});
