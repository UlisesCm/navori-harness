import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPluginPath } from "../bundled-assets.ts";
import { acrossShells, type HookShell } from "./helpers/shells.ts";

/**
 * Covers: R8 — the SessionStart hook of the tgrep plugin (spec 0017).
 *
 * Its whole contract is "one plain line, exit 0, always". Plain stdout because
 * that is what Claude Code appends to session context for SessionStart; exit 0
 * on every path because a hook that fails must never be the reason a session
 * doesn't open. Everything else it does (warming the index) is best-effort, so
 * the cases below drive it through the states that could plausibly break it: no
 * binary, a cache it cannot write, and both shells the harness may run under.
 */

const HOOK = resolve(getPluginPath("tgrep"), "scripts/tgrep-session.sh");
const runsBash = process.platform !== "win32";

function resolveBin(name: string): string {
  return execFileSync("bash", ["-c", `command -v ${name}`], { encoding: "utf-8" }).trim();
}

const SHIM_TOOLS = [
  "bash",
  "zsh",
  "git",
  "grep",
  "sed",
  "cut",
  "tail",
  "tr",
  "mkdir",
  "shasum",
  "dirname",
];

interface Env {
  cwd: string;
  bin: string;
  cache: string;
}

/** A git fixture plus a PATH holding only the hook's own utilities. */
function makeEnv(withTgrep: boolean): Env {
  const base = mkdtempSync(join(tmpdir(), "navori-tgrep-hook-"));
  const cwd = join(base, "repo con espacio");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "a.txt"), "alpha token_uno\n");
  execFileSync("git", ["init", "-q", "."], { cwd });

  const bin = join(base, "bin");
  mkdirSync(bin, { recursive: true });
  for (const tool of SHIM_TOOLS) {
    try {
      symlinkSync(resolveBin(tool), join(bin, tool));
    } catch {
      // Optional tool absent on this machine — the hook doesn't require it.
    }
  }
  if (withTgrep) {
    // A stand-in, not the real binary: this suite pins the hook's contract, and
    // tgrep's own behaviour is covered by tgrep-search-script.test.ts.
    const fake = join(bin, "tgrep");
    writeFileSync(fake, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(fake, 0o755);
  }
  return { cwd, bin, cache: join(base, "cache") };
}

function runHook(env: Env, shell: HookShell, cache = env.cache) {
  const r = spawnSync(resolveBin(shell), [HOOK], {
    cwd: env.cwd,
    encoding: "utf-8",
    env: { PATH: env.bin, HOME: env.cwd, XDG_CACHE_HOME: cache },
  });
  return {
    status: r.status,
    lines: (r.stdout ?? "").split("\n").filter((l) => l.trim() !== ""),
  };
}

describe.runIf(runsBash)("tgrep-session.sh — SessionStart notice (spec 0017)", () => {
  it("announces the wrapper as the search path when tgrep is present", () => {
    const env = makeEnv(true);
    const r = acrossShells((shell) => runHook(env, shell));
    expect(r.status).toBe(0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain("tgrep-search.sh");
  });

  it("names the install command when tgrep is absent", () => {
    const env = makeEnv(false);
    const r = acrossShells((shell) => runHook(env, shell));
    expect(r.status).toBe(0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain("brew install tgrep");
  });

  // The warm-up writes to the cache; an unwritable one must cost the session
  // nothing but the warm-up itself.
  it("still exits 0 with its line when the cache is read-only", () => {
    const env = makeEnv(true);
    const ro = join(env.cwd, "..", "read-only-cache");
    mkdirSync(ro, { recursive: true });
    chmodSync(ro, 0o500);
    const r = acrossShells((shell) => runHook(env, shell, ro));
    expect(r.status).toBe(0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain("tgrep-search.sh");
  });
});
