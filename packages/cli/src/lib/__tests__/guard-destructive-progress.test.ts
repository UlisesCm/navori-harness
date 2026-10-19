import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { emptyRepo, type RepoTemplate } from "../../__tests__/helpers/repo-template.ts";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { expandHookIncludes } from "../render/hook-includes.ts";
import { PROGRESS_HARD_CAP_BYTES } from "../assets/doc-budgets.ts";
import { acrossShells } from "./helpers/shells.ts";

// Covers: #1266
// The commit lane of `guard-destructive`: the session-state ratchet (#1263) for repos
// WITHOUT `qualityGate.fast`, where `quality-gate-pre-commit` is not registered.
// Real temp git repos, the hook expanded and rendered the way `navori render` does it.

const GUARD_SRC = resolve(getCoreRoot(), "core-assets/hooks/guard-destructive.sh");
const CURRENT = "progress/current.md";
const OVER = PROGRESS_HARD_CAP_BYTES + 1000;

/** Hook directory per engine: `hook-input` derives `nv_engine` from the script path. */
const ENGINE_DIRS = {
  claude: ".claude/hooks",
  codex: ".codex/hooks",
  pi: ".pi/navori/hooks",
} as const;
type Engine = keyof typeof ENGINE_DIRS;

let dir: string;

/** One empty repo per file, copied into each case's `dir` (spec 0055 D7). */
let gitTemplate: RepoTemplate;
beforeAll(() => {
  gitTemplate = emptyRepo({ branch: "master" });
});
afterAll(() => gitTemplate.dispose());

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "navori-guard-progress-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Render the guard like `navori render` (includes inlined, placeholders resolved).
 * `lane` is the render-time flag: "1" = `qualityGate.fast` not declared, "0" = declared,
 * `null` = a raw copy that keeps the placeholder text. The audit recorder is swapped for
 * a stderr line so the verdict and reason the trap would record are observable.
 */
function installGuard(lane: "0" | "1" | null, engine: Engine = "claude"): string {
  let raw = expandHookIncludes(readFileSync(GUARD_SRC, "utf-8"))
    .replace(/\{\{shq:branchBase\}\}/g, "'main'")
    .replace(/\{\{shq:piPermissionRules\}\}/g, "'-'")
    .replace("{{navori.progressHardCapBytes}}", String(PROGRESS_HARD_CAP_BYTES))
    .replace(
      'navori_audit_log "$navori_audit_verdict" "$navori_audit_reason" || true',
      'printf \'AUDIT %s %s\\n\' "$navori_audit_verdict" "$navori_audit_reason" >&2',
    );
  if (lane !== null) raw = raw.replace("{{navori.progressGuardLane}}", lane);
  const path = join(dir, "hooks", ENGINE_DIRS[engine], "guard-destructive.sh");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw);
  chmodSync(path, 0o755);
  return path;
}

function git(...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { cwd: dir, stdio: "pipe", encoding: "utf-8" },
  );
}

function put(bytes: number, rel = CURRENT): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), "a".repeat(bytes));
}

/** A repo whose HEAD holds `headBytes` of session state (0 = absent at HEAD). */
function repo(headBytes: number, rel = CURRENT): void {
  gitTemplate.copyInto(dir);
  writeFileSync(join(dir, "base.txt"), "base\n");
  git("add", "base.txt");
  if (headBytes > 0) {
    put(headBytes, rel);
    git("add", rel);
  }
  git("commit", "-q", "-m", "base");
}

/** Runs under every available shell (bash AND zsh, #391); the verdicts must agree. */
function run(hook: string, command: string, cwd = dir) {
  return acrossShells((shell) => {
    const r = spawnSync(shell, [hook], {
      cwd,
      input: JSON.stringify({ tool_input: { command } }),
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir },
    });
    return { status: r.status, stderr: r.stderr };
  });
}

const blocked = (r: { status: number | null; stderr: string }) => {
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("Commit BLOCKED");
  expect(r.stderr).toContain("progress/history.md");
  expect(r.stderr).toContain("AUDIT block unspecified");
};
const notMeasured = (r: { status: number | null; stderr: string }) => {
  expect(r.status).toBe(0);
  expect(r.stderr).not.toContain("Commit BLOCKED");
};

describe("guard-destructive commit lane — no qualityGate.fast (#1266)", () => {
  it.each(Object.keys(ENGINE_DIRS) as Engine[])(
    "blocks a commit that grows the session state past the ceiling (%s render)",
    (engine) => {
      repo(100);
      put(OVER);
      git("add", CURRENT);
      blocked(run(installGuard("1", engine), "git commit -m x"));
    },
  );

  it("blocks the first commit (unborn HEAD) that stages an oversized file", () => {
    gitTemplate.copyInto(dir);
    put(OVER);
    git("add", CURRENT);
    blocked(run(installGuard("1"), "git commit -m x"));
  });

  it("blocks `git add && git commit` and `git commit -am` (worktree growth)", () => {
    repo(100);
    put(OVER);
    const hook = installGuard("1");
    blocked(run(hook, "git add -A && git commit -m x"));
    blocked(run(hook, "git commit -am x"));
  });

  it("blocks growth over the fallback session-state paths", () => {
    repo(0, ".claude/progress/current.md");
    put(OVER, ".claude/progress/current.md");
    blocked(run(installGuard("1"), "git commit -am x"));
  });

  it("measures the tree being committed when the hook runs from a subdirectory", () => {
    repo(100);
    put(OVER);
    git("add", CURRENT);
    mkdirSync(join(dir, "sub"), { recursive: true });
    const hook = installGuard("1");
    blocked(run(hook, "git commit -m x", join(dir, "sub")));
    blocked(run(hook, `git -C ${dir} commit -m x`, join(dir, "sub")));
  });

  it("skips a commit that lands in ANOTHER repository (`git -C <other>`)", () => {
    repo(100);
    put(OVER);
    git("add", CURRENT);
    const other = mkdtempSync(join(tmpdir(), "navori-guard-progress-other-"));
    try {
      gitTemplate.copyInto(other);
      const hook = installGuard("1");
      notMeasured(run(hook, `git -C ${other} commit --allow-empty -m x`));
      notMeasured(run(hook, `cd ${other} && git commit --allow-empty -m x`));
      // Control: the same anchor still blocks a commit that lands in it.
      blocked(run(hook, "git commit -m x"));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("passes a trim that is still over the ceiling", () => {
    repo(OVER * 4);
    put(OVER);
    git("add", CURRENT);
    notMeasured(run(installGuard("1"), "git commit -m x"));
  });

  it("passes an untouched legacy oversized file (an unrelated commit)", () => {
    repo(OVER * 4);
    writeFileSync(join(dir, "other.txt"), "x\n");
    git("add", "other.txt");
    notMeasured(run(installGuard("1"), "git commit -m x"));
  });

  it("passes a gitignored session-state directory", () => {
    gitTemplate.copyInto(dir);
    writeFileSync(join(dir, ".gitignore"), "progress/\n");
    put(OVER * 2);
    notMeasured(run(installGuard("1"), "git commit --allow-empty -m x"));
  });

  it("does not measure a command that is not a commit", () => {
    repo(100);
    put(OVER);
    const hook = installGuard("1");
    for (const command of ["git status", "git log --oneline", "echo commit", "git push origin x"]) {
      notMeasured(run(hook, command));
    }
  });

  it("does not run when qualityGate.fast is declared (the gate hook covers it)", () => {
    repo(100);
    put(OVER);
    git("add", CURRENT);
    notMeasured(run(installGuard("0"), "git commit -m x"));
  });

  it("stays off in a raw, unrendered copy (placeholder kept)", () => {
    repo(100);
    put(OVER);
    git("add", CURRENT);
    notMeasured(run(installGuard(null), "git commit -m x"));
  });

  it("keeps the other rules intact: --no-verify still blocks first", () => {
    repo(100);
    put(OVER);
    git("add", CURRENT);
    const r = run(installGuard("1"), "git commit --no-verify -m x");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--no-verify");
    expect(r.stderr).not.toContain("Commit BLOCKED");
  });
});
