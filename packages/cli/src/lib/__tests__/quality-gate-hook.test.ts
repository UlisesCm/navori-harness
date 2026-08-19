import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { getCoreRoot } from "../bundled-assets.ts";
import { shellSingleQuote } from "../shell-escape.ts";
import { expandHookIncludes } from "../hook-includes.ts";

/**
 * Behavioral tests for the quality-gate pre-commit hook (#88). We install the
 * core-asset script into a temp repo (replacing the {{qualityGate.fast}}
 * placeholder as `navori render` does), then drive it with a restricted PATH so
 * we control exactly which package managers are "installed".
 */
const HOOK_SRC = resolve(getCoreRoot(), "core-assets/hooks/quality-gate-pre-commit.sh");
// /usr/bin + /bin give coreutils (sed/cat/head/jq) but NO pnpm/bun/npm/node —
// those only exist if we fake them into binDir.
const BASE_PATH = "/usr/bin:/bin";

let dir: string;
let binDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "navori-qg-"));
  binDir = join(dir, "fakebin");
  mkdirSync(binDir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function installHook(gate: string): string {
  // `navori render` inlines the shared `# navori:include` partials and
  // shell-quotes `{{shq:qualityGate.fast}}` (#197); mirror both.
  const raw = expandHookIncludes(readFileSync(HOOK_SRC, "utf-8")).replace(
    "{{shq:qualityGate.fast}}",
    shellSingleQuote(gate),
  );
  const path = join(dir, "hook.sh");
  writeFileSync(path, raw);
  chmodSync(path, 0o755);
  return path;
}

/** Put a fake executable on PATH that echoes its invocation and exits `code`. */
function fakeBin(name: string, code = 0): void {
  const p = join(binDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\necho "RAN ${name} $*"\nexit ${code}\n`);
  chmodSync(p, 0o755);
}

function runHook(hookPath: string, command: string) {
  return spawnSync("bash", [hookPath], {
    cwd: dir,
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf-8",
    env: { PATH: `${binDir}:${BASE_PATH}` },
  });
}

describe("quality-gate hook — declared runner present", () => {
  it("runs the gate when the declared package manager is on PATH", () => {
    fakeBin("pnpm", 0);
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m test");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("running quality-gate fast");
    expect(r.stdout).toContain("RAN pnpm run typecheck");
  });

  it("aborts with exit 2 when the gate command fails", () => {
    fakeBin("pnpm", 2);
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m test");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("quality-gate fast failed");
  });

  it("ignores commands that are not a git commit", () => {
    fakeBin("pnpm", 0);
    const r = runHook(installHook("pnpm run typecheck"), "ls -la");
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("running quality-gate fast");
  });

  // Segment-based detection: a compound command must NOT skip the gate silently.
  it("runs the gate on a compound `cd x && git commit` (no silent skip)", () => {
    fakeBin("pnpm", 0);
    const r = runHook(installHook("pnpm run typecheck"), "cd sub && git commit -m x");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("running quality-gate fast");
    expect(r.stdout).toContain("RAN pnpm run typecheck");
  });

  // Commit-only: the quality gate no longer runs on push (the diff was already
  // gated at commit; the remote-push backstop is semgrep, not this gate).
  it("does NOT run the gate on `echo done; git push` (push not gated)", () => {
    fakeBin("pnpm", 0);
    const r = runHook(installHook("pnpm run typecheck"), "echo done; git push");
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("running quality-gate fast");
  });

  it("does NOT run the gate on `gh pr create` (commit-only)", () => {
    fakeBin("pnpm", 0);
    const r = runHook(installHook("pnpm run typecheck"), "gh pr create --title x");
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("running quality-gate fast");
  });

  it("runs the gate past an env-var prefix `FOO=bar git commit`", () => {
    fakeBin("pnpm", 0);
    const r = runHook(installHook("pnpm run typecheck"), "FOO=bar git commit -m x");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("running quality-gate fast");
  });

  // FIX B: a backslash-newline continuation must not split the command past the
  // gate. `cd x && \<NL> git commit` still triggers.
  it("runs the gate on a multi-line `cd x && \\\\<NL> git commit`", () => {
    fakeBin("pnpm", 0);
    const r = runHook(installHook("pnpm run typecheck"), "cd x && \\\n git commit -m x");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("running quality-gate fast");
  });

  // FIX C: git global options between `git` and the subcommand still gate.
  it("runs the gate on `git -c k=v commit` (interleaved global option)", () => {
    fakeBin("pnpm", 0);
    const r = runHook(installHook("pnpm run typecheck"), "git -c k=v commit -m x");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("running quality-gate fast");
  });

  it('does NOT trigger on a quoted `echo "git commit"` (not a real invocation)', () => {
    fakeBin("pnpm", 0);
    const r = runHook(installHook("pnpm run typecheck"), 'echo "git commit"');
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("running quality-gate fast");
  });
});

// #309: Claude Code fires the hook from the session's persistent cwd, which is
// not always the repo root. The hook must cd to the root before running the
// gate, or a relative gate (`cd packages/cli && pnpm lint`) fails with "No such
// file or directory" from a subdir.
describe("quality-gate hook — runs from the repo root (#309)", () => {
  it("renders the cd-to-root guard before the gate", () => {
    const hook = readFileSync(installHook("pnpm run typecheck"), "utf-8");
    expect(hook).toContain(
      'cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}" || exit 2',
    );
  });

  it("resolves a root-relative gate even when invoked from a subdir", () => {
    // git repo with a marker at the root; the gate reads it by a root-relative
    // path. Invoked from a subdir with no CLAUDE_PROJECT_DIR, the hook must fall
    // back to the git top-level and still find the file. `cat`/`git`/`sed` come
    // from BASE_PATH, so no fake package manager is needed.
    spawnSync("git", ["init", "-q"], { cwd: dir });
    const sub = join(dir, "packages", "cli");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(dir, "root-marker.txt"), "ok\n");
    const hook = installHook("cat root-marker.txt");
    const r = spawnSync("bash", [hook], {
      cwd: sub,
      input: JSON.stringify({ tool_input: { command: "git commit -m x" } }),
      encoding: "utf-8",
      env: { PATH: BASE_PATH },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("running quality-gate fast");
  });
});

describe("quality-gate hook — declared runner missing (#88)", () => {
  it("remaps to the lockfile-detected package manager (pnpm gate in a bun repo)", () => {
    // Only bun is installed; the repo carries a bun lockfile. The pnpm-based
    // gate must be retried through bun instead of skipped.
    fakeBin("bun", 0);
    writeFileSync(join(dir, "bun.lock"), "");
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m test");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("using the lockfile-detected package manager: 'bun'");
    expect(r.stdout).toContain("RAN bun run typecheck");
  });

  it("detects the PM from the packageManager field in package.json", () => {
    fakeBin("bun", 0);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "bun@1.3.9" }));
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m test");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("RAN bun run typecheck");
  });

  it("BLOCKS the commit (exit 2) instead of skipping silently when nothing can run it", () => {
    // No package manager installed, no lockfile — the old behavior was a silent
    // `exit 0`. It must now block loudly.
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m test");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("BLOCKED");
    expect(r.stderr).not.toContain("running quality-gate fast");
  });
});

// The content receipt (RDD, #167) binds the commit to the exact bytes the
// reviewer approved: a `<blob-sha>  <path>` line per approved file. The hook
// recomputes it over the STAGED set and blocks if an approved file drifted.
describe("quality-gate hook — content receipt (RDD)", () => {
  function git(...args: string[]): void {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  function hashObject(rel: string): string {
    return spawnSync("git", ["hash-object", rel], { cwd: dir, encoding: "utf-8" }).stdout.trim();
  }
  function initRepo(): void {
    git("init", "-q");
    git("config", "user.email", "t@t.co");
    git("config", "user.name", "t");
  }
  /** Write a receipt fingerprinting `paths` (default Claude location). */
  function writeReceipt(paths: string[], rel = ".claude/progress/receipt.txt"): void {
    const lines = ["# navori-receipt v1 feature=demo"];
    for (const p of paths) lines.push(`${hashObject(p)}  ${p}`);
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `${lines.join("\n")}\n`);
  }

  it("no receipt present → the gate still runs unchanged in a git repo", () => {
    initRepo();
    fakeBin("pnpm", 0);
    writeFileSync(join(dir, "a.txt"), "hello\n");
    git("add", "a.txt");
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m x");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("running quality-gate fast");
  });

  it("receipt matches the staged content → the gate runs (exit 0)", () => {
    initRepo();
    fakeBin("pnpm", 0);
    writeFileSync(join(dir, "a.txt"), "hello\n");
    git("add", "a.txt");
    writeReceipt(["a.txt"]);
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m x");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("running quality-gate fast");
    expect(r.stderr).not.toContain("receipt mismatch");
  });

  it("a staged file drifted from the approval → BLOCKS (exit 2) before the gate", () => {
    initRepo();
    fakeBin("pnpm", 0);
    writeFileSync(join(dir, "a.txt"), "approved\n");
    git("add", "a.txt");
    writeReceipt(["a.txt"]);
    writeFileSync(join(dir, "a.txt"), "tampered\n"); // drift, restaged below
    git("add", "a.txt");
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m x");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("receipt mismatch");
    expect(r.stderr).toContain("a.txt");
    expect(r.stderr).not.toContain("running quality-gate fast");
  });

  it("drift in an UNSTAGED file (not part of this commit) → does NOT block", () => {
    initRepo();
    fakeBin("pnpm", 0);
    writeFileSync(join(dir, "a.txt"), "approved\n");
    git("add", "a.txt");
    git("commit", "-qm", "seed"); // a.txt now tracked
    writeReceipt(["a.txt"]);
    writeFileSync(join(dir, "a.txt"), "drifted-but-unstaged\n"); // NOT staged
    writeFileSync(join(dir, "b.txt"), "new\n");
    git("add", "b.txt"); // only b.txt is in this commit
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m x");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("running quality-gate fast");
    expect(r.stderr).not.toContain("receipt mismatch");
  });

  // The REAL Codex location: `compat.ts` rewrites `.claude/progress/` into
  // `.codex/progress/`, never into bare `progress/` (#208 — that root dir holds
  // git-persisted session state). The hook body is copied verbatim per engine,
  // so it has to probe this path itself; until #352 it didn't, and the backstop
  // silently passed every commit under Codex.
  it("enforces a receipt at the Codex location (.codex/progress/receipt.txt)", () => {
    initRepo();
    fakeBin("pnpm", 0);
    writeFileSync(join(dir, "a.txt"), "approved\n");
    git("add", "a.txt");
    writeReceipt(["a.txt"], ".codex/progress/receipt.txt");
    writeFileSync(join(dir, "a.txt"), "tampered\n");
    git("add", "a.txt");
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m x");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("receipt mismatch");
  });

  // Defensive fallback for any pre-#208 layout. Kept last in the probe order.
  it("still enforces a receipt at the bare progress/ fallback", () => {
    initRepo();
    fakeBin("pnpm", 0);
    writeFileSync(join(dir, "a.txt"), "approved\n");
    git("add", "a.txt");
    writeReceipt(["a.txt"], "progress/receipt.txt");
    writeFileSync(join(dir, "a.txt"), "tampered\n");
    git("add", "a.txt");
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m x");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("receipt mismatch");
  });

  // A file the reviewer approved REMOVING is recorded as `deleted  <path>`
  // (#202). A staged deletion must NOT drift — its expected state is "absent".
  it("a `deleted`-marked file staged as a deletion → does NOT block", () => {
    initRepo();
    fakeBin("pnpm", 0);
    writeFileSync(join(dir, "a.txt"), "gone soon\n");
    git("add", "a.txt");
    git("commit", "-qm", "seed"); // a.txt tracked
    const rel = ".claude/progress/receipt.txt";
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), "# navori-receipt v1 feature=demo\ndeleted  a.txt\n");
    git("rm", "-q", "a.txt"); // stage the removal the reviewer signed off on
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m x");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("running quality-gate fast");
    expect(r.stderr).not.toContain("receipt mismatch");
  });

  // #344: the loop must not report drift for content that did NOT change — the
  // failure mode that made the pilot loop forever. Several files at once, since
  // the zsh bug poisoned the whole receipt from the first line on.
  it("every receipt file unchanged → no drift, the gate just runs", () => {
    initRepo();
    fakeBin("pnpm", 0);
    writeFileSync(join(dir, "a.txt"), "alpha\n");
    writeFileSync(join(dir, "b.txt"), "beta\n");
    git("add", "a.txt", "b.txt");
    writeReceipt(["a.txt", "b.txt"]);
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m x");
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("receipt mismatch");
    expect(r.stderr).not.toContain("could NOT verify");
    expect(r.stderr).toContain("running quality-gate fast");
  });

  // An approved file staged as a DELETION (the receipt recorded content, not a
  // `deleted` marker) is real drift — its approved bytes are gone. It must keep
  // blocking as drift, not degrade into the "could not verify" branch.
  it("an approved file staged as a deletion → BLOCKS as drift (missing)", () => {
    initRepo();
    fakeBin("pnpm", 0);
    writeFileSync(join(dir, "a.txt"), "approved\n");
    git("add", "a.txt");
    git("commit", "-qm", "seed");
    writeReceipt(["a.txt"]);
    git("rm", "-q", "a.txt"); // removal the reviewer never approved
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m x");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("receipt mismatch");
    expect(r.stderr).toContain("a.txt (missing)");
  });

  // #344: a `git hash-object` that fails for environment reasons (unreadable
  // file, missing binary, wrong cwd) is a VERIFICATION failure. It still blocks,
  // but it must not be dressed up as an accusation of drift — re-running the
  // reviewer can never clear it. Skipped as root, where chmod 000 is no barrier.
  const notRoot = (process.getuid?.() ?? 1) !== 0;
  it.skipIf(!notRoot)("an unhashable (unreadable) file → verification error, not drift", () => {
    initRepo();
    fakeBin("pnpm", 0);
    writeFileSync(join(dir, "a.txt"), "approved\n");
    git("add", "a.txt");
    writeReceipt(["a.txt"]);
    chmodSync(join(dir, "a.txt"), 0o000); // exists, but git cannot read it
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m x");
    chmodSync(join(dir, "a.txt"), 0o644); // restore so afterEach can clean up
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("could NOT verify");
    expect(r.stderr).toContain("a.txt");
    expect(r.stderr).not.toContain("receipt mismatch");
    expect(r.stderr).not.toContain("running quality-gate fast");
  });

  // The other direction: the receipt says the file was removed, but it's back
  // (staged with content) → that IS drift, block.
  it("a `deleted`-marked file that reappeared (staged with content) → BLOCKS", () => {
    initRepo();
    fakeBin("pnpm", 0);
    const rel = ".claude/progress/receipt.txt";
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), "# navori-receipt v1 feature=demo\ndeleted  a.txt\n");
    writeFileSync(join(dir, "a.txt"), "resurrected\n"); // came back
    git("add", "a.txt");
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m x");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("receipt mismatch");
    expect(r.stderr).toContain("a.txt");
  });
});
