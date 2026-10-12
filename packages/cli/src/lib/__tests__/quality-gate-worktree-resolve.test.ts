import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { interpolate } from "../render/interpolate.ts";
import { expandHookIncludes } from "../render/hook-includes.ts";
import type { NavoriConfig } from "../config/config.ts";
import { acrossShells, type HookShell } from "./helpers/shells.ts";

/**
 * The `resolve-worktree` partial, exercised through the CORE quality-gate hook.
 *
 * It was previously proven only through the plugin gate hooks (#454). The
 * partial's one consumer in core is `quality-gate-pre-commit.sh`, so these
 * cases drive it directly: the gate is `cat tree.txt`, and every tree (main,
 * linked worktree, foreign repo) carries a `tree.txt` naming itself. The gate's
 * stdout therefore says WHERE it ran, with no scanner stub to count.
 *
 * Like `settings.json` does, the hook process starts in the MAIN repo and the
 * worktree is only reachable through the payload `.cwd` or the command.
 */

const runsBash = process.platform !== "win32";
const BASE_PATH = "/usr/bin:/bin";
const HOOK_SRC = resolve(getCoreRoot(), "core-assets/hooks/quality-gate-pre-commit.sh");

const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.email=t@navori.test",
      "-c",
      "user.name=navori",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "protocol.file.allow=always",
      ...args,
    ],
    { cwd, stdio: "pipe", encoding: "utf-8" },
  );
}

/** A repo on `main` whose `tree.txt` holds `name`, one commit deep. */
function makeRepo(prefix: string, name: string): string {
  const dir = mkTemp(prefix);
  writeFileSync(join(dir, "tree.txt"), `${name}\n`);
  git(dir, "init", "-q");
  git(dir, "add", "tree.txt");
  git(dir, "commit", "-q", "--no-verify", "-m", "base");
  git(dir, "branch", "-M", "main");
  return dir;
}

interface Fixture {
  main: string;
  worktree: string;
  foreign: string;
  hook: string;
}

function setup(): Fixture {
  const main = makeRepo("navori-qgwt-main-", "main");
  const foreign = makeRepo("navori-qgwt-other-", "foreign");
  const worktree = join(mkTemp("navori-qgwt-wt-"), "wt");
  git(main, "worktree", "add", "-q", "-b", "feature", worktree, "main");
  writeFileSync(join(worktree, "tree.txt"), "worktree\n");

  const config = {
    branchBase: "main",
    preset: "custom",
    qualityGate: { fast: "cat tree.txt" },
  } as unknown as NavoriConfig;
  const raw = interpolate(expandHookIncludes(readFileSync(HOOK_SRC, "utf-8")), config, {
    extraVars: {},
  });
  const hook = join(mkTemp("navori-qgwt-hook-"), "hook.sh");
  writeFileSync(hook, raw);
  chmodSync(hook, 0o755);
  return { main, worktree, foreign, hook };
}

/** The tree the gate ran in, read off the stdout of `cat tree.txt` ("" when it never ran). */
function gateTree(
  fx: Fixture,
  shell: HookShell,
  command: string,
  payloadCwd: string | undefined,
): { status: number | null; tree: string } {
  const payload: Record<string, unknown> = {};
  if (payloadCwd !== undefined) payload.cwd = payloadCwd;
  payload.tool_input = { command };
  const r = spawnSync(shell, [fx.hook], {
    cwd: fx.main,
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: { PATH: BASE_PATH, CLAUDE_PROJECT_DIR: fx.main },
  });
  return { status: r.status, tree: r.stdout.trim() };
}

describe.runIf(runsBash)("quality gate — runs in the tree the commit acts on (#454)", () => {
  it("resolves the tree from a leading `cd <worktree>` in the command", () => {
    const out = acrossShells((shell) => {
      const fx = setup();
      return gateTree(fx, shell, `cd '${fx.worktree}' && git commit -m x`, fx.main);
    });
    expect(out).toEqual({ status: 0, tree: "worktree" });
  });

  it("resolves the tree from `git -C <worktree> commit`", () => {
    const out = acrossShells((shell) => {
      const fx = setup();
      return gateTree(fx, shell, `git -C ${fx.worktree} commit -m x`, fx.main);
    });
    expect(out).toEqual({ status: 0, tree: "worktree" });
  });

  it("uses the payload cwd when the commit names no tree", () => {
    const out = acrossShells((shell) => {
      const fx = setup();
      return gateTree(fx, shell, "git commit -m x", fx.worktree);
    });
    expect(out).toEqual({ status: 0, tree: "worktree" });
  });

  it("falls back to the hook process's cwd when the payload carries no cwd", () => {
    const out = acrossShells((shell) => {
      const fx = setup();
      return gateTree(fx, shell, "git commit -m x", undefined);
    });
    expect(out).toEqual({ status: 0, tree: "main" });
  });
});

/**
 * The directory the COMMAND names must not override the tree the commit lands
 * in: accepting any git tree it mentions lets it aim the gate at a different
 * checkout. Each case is a command that names a foreign tree without the
 * commit landing there.
 */
describe.runIf(runsBash)("quality gate — the command cannot aim the gate elsewhere (#454)", () => {
  it("ignores a `cd <other repo>` earlier in the chain", () => {
    const out = acrossShells((shell) => {
      const fx = setup();
      return gateTree(
        fx,
        shell,
        `cd '${fx.foreign}' && cd '${fx.worktree}' && git commit -m x`,
        fx.worktree,
      );
    });
    expect(out).toEqual({ status: 0, tree: "worktree" });
  });

  it("ignores a `git -C <other repo>` in an unrelated leading segment", () => {
    const out = acrossShells((shell) => {
      const fx = setup();
      return gateTree(fx, shell, `git -C ${fx.foreign} log && git commit -m x`, fx.main);
    });
    expect(out).toEqual({ status: 0, tree: "main" });
  });

  it("ignores a `cd <other repo>` separated by `;`", () => {
    const out = acrossShells((shell) => {
      const fx = setup();
      return gateTree(
        fx,
        shell,
        `cd '${fx.foreign}' ; cd '${fx.worktree}' && git commit -m x`,
        fx.worktree,
      );
    });
    expect(out).toEqual({ status: 0, tree: "worktree" });
  });

  it("ignores `git -C <other repo>` quoted inside the commit message", () => {
    const out = acrossShells((shell) => {
      const fx = setup();
      return gateTree(
        fx,
        shell,
        `git commit -m "use git -C ${fx.foreign} everywhere"`,
        fx.worktree,
      );
    });
    expect(out).toEqual({ status: 0, tree: "worktree" });
  });

  it("ignores a `cd <submodule>` even though it lives inside the repo", () => {
    const out = acrossShells((shell) => {
      const fx = setup();
      // A submodule is its own working tree under the superproject: the gate must not land there.
      git(fx.main, "submodule", "add", "-q", fx.foreign, "sub");
      git(fx.main, "commit", "-q", "--no-verify", "-m", "add submodule");
      mkdirSync(join(fx.main, "sub"), { recursive: true });
      return gateTree(
        fx,
        shell,
        `cd '${join(fx.main, "sub")}' && cd .. && git commit -m x`,
        fx.main,
      );
    });
    expect(out).toEqual({ status: 0, tree: "main" });
  });
});
