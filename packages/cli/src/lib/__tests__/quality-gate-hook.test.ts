import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { getCoreRoot } from "../bundled-assets.ts";
import { shellSingleQuote } from "../shell-escape.ts";
import { expandHookIncludes } from "../hook-includes.ts";
import { acrossShells } from "./helpers/shells.ts";

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

/** Runs under every available shell (bash AND zsh, #391); the outcomes must agree. */
function runHook(hookPath: string, command: string) {
  return acrossShells((shell) => {
    const r = spawnSync(shell, [hookPath], {
      cwd: dir,
      input: JSON.stringify({ tool_input: { command } }),
      encoding: "utf-8",
      env: { PATH: `${binDir}:${BASE_PATH}` },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
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

/**
 * #511 — an EMPTY command is "nothing could be read from the payload", not
 * "some command that isn't a commit".
 *
 * `is_scan_trigger ""` finds no git segment, so the whole gate block was
 * skipped with NO output at all: a gate that omits itself in silence is
 * byte-for-byte indistinguishable from a gate that ran and passed. Both
 * siblings (`check-semgrep.sh`, `check-jscpd.sh`) already scan unconditionally
 * in that case — the contract the shared extractor documents — and this file
 * already carries the doctrine two blocks below (#88: never skip the gate
 * silently). It was the one gate that drifted from both.
 *
 * The suite did not catch it because it only ever fed the hook REAL commands:
 * `git commit …` (gate runs) or `ls -la` (gate skips). The degenerate input was
 * never exercised, so there was nothing to assert against.
 */
describe("quality-gate hook — an empty command is not a silent skip (#511)", () => {
  it("runs the gate and SAYS why when no command could be extracted", () => {
    fakeBin("pnpm", 0);
    const r = runHook(installHook("pnpm run typecheck"), "");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("no command could be read from the tool input");
    expect(r.stderr).toContain("running quality-gate fast");
    expect(r.stdout).toContain("RAN pnpm run typecheck");
  });

  it("a red gate on that path still BLOCKS (exit 2), it is not advisory", () => {
    fakeBin("pnpm", 1);
    const r = runHook(installHook("pnpm run typecheck"), "");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("quality-gate fast failed");
  });

  // ANTI-FALSE-GREEN: the two cases above would also pass if the hook had
  // started running the gate on EVERY Bash call. A real non-commit command must
  // still skip — silently, which is correct there because the command itself is
  // the evidence that no gate was owed.
  it("a real non-commit command still skips, with no gate output", () => {
    fakeBin("pnpm", 0);
    const r = runHook(installHook("pnpm run typecheck"), "ls -la");
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("no command could be read");
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
    // #454 replaced the `$CLAUDE_PROJECT_DIR`-first form: the root now comes
    // from the tree the COMMIT acts on (which is still the project root in the
    // ordinary case), with $CLAUDE_PROJECT_DIR kept as the no-git fallback.
    expect(hook).toContain("gate_root=$(navori_worktree)");
    expect(hook).toContain('cd "${gate_root:-${CLAUDE_PROJECT_DIR:-}}" || exit 2');
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
    const r = acrossShells((shell) => {
      const s = spawnSync(shell, [hook], {
        cwd: sub,
        input: JSON.stringify({ tool_input: { command: "git commit -m x" } }),
        encoding: "utf-8",
        env: { PATH: BASE_PATH },
      });
      return { status: s.status, stderr: s.stderr };
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

// The content receipt (RDD, #167) binds a commit to the exact bytes the reviewer
// approved. The hook used to re-verify it over the staged set; #365 removed that
// backstop (five fail-open paths, zero documented catches) and left the receipt
// as a handoff the `commit-pr-pilot` verifies agent-side. These two tests pin the
// removal: a receipt is now inert here, in both directions.
describe("quality-gate hook — the content receipt is NOT a hook concern (#365)", () => {
  function git(...args: string[]): void {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  function initRepo(): void {
    git("init", "-q");
    git("config", "user.email", "t@t.co");
    git("config", "user.name", "t");
  }
  function writeReceipt(body: string): void {
    const full = join(dir, ".claude/progress/receipt.txt");
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `# navori-receipt v1 feature=demo\n${body}`);
  }

  it("a staged file that drifted from the approval no longer blocks — the gate just runs", () => {
    initRepo();
    fakeBin("pnpm", 0);
    writeFileSync(join(dir, "a.txt"), "approved\n");
    git("add", "a.txt");
    // A sha that matches nothing: maximal drift, the case the backstop existed for.
    writeReceipt("0000000000000000000000000000000000000000  a.txt\n");
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m x");
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("receipt mismatch");
    expect(r.stderr).toContain("running quality-gate fast");
  });

  it("a red gate still blocks with a receipt present — removing the backstop kept the gate", () => {
    initRepo();
    fakeBin("pnpm", 1);
    writeFileSync(join(dir, "a.txt"), "approved\n");
    git("add", "a.txt");
    writeReceipt("0000000000000000000000000000000000000000  a.txt\n");
    const r = runHook(installHook("pnpm run typecheck"), "git commit -m x");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("quality-gate fast failed");
  });
});
