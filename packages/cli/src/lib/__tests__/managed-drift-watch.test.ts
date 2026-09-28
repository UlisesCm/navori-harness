import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { expandHookIncludes } from "../render/hook-includes.ts";
import { computeManagedHash } from "../render/marker.ts";
import { buildClaudeSettings } from "../../engines/claude/build-settings.ts";
import type { NavoriConfig } from "../config/config.ts";

const MINIMAL_CONFIG = {
  name: "test",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
} as unknown as NavoriConfig;

/**
 * Behavioral tests for core-assets/hooks/managed-drift-watch.sh (#530).
 *
 * The hook's whole premise is that it does NOT read the command: it asks
 * whether navori's managed blocks still hash to what their markers claim, so it
 * catches a write no rule enumerated (`python`, `perl -i`, a formatter). These
 * drive it the way Claude Code does — spawn it with the project dir in the
 * environment — and check the verdict, never the script's shape.
 *
 * The load-bearing one is `agrees with computeManagedHash`: the hook reimplements
 * that algorithm in shell, so if the TS side ever changes its normalization the
 * hook starts crying wolf on healthy files. That test fails the moment they part.
 */

const runsBash = process.platform !== "win32";
// spec 0035 D2: the hook now ships `# navori:include` directives (hook-input,
// extract-cmd) that `navori render` inlines. Expand them once here, same as
// `guard-destructive.test.ts`, so the tests drive exactly what a rendered
// hook runs — running the raw source left `nv_project_dir` undefined.
const driftSource = resolve(getCoreRoot(), "core-assets/hooks/managed-drift-watch.sh");
const hookPath = (() => {
  const dir = mkdtempSync(join(tmpdir(), "navori-drift-src-"));
  const p = join(dir, "managed-drift-watch.sh");
  writeFileSync(p, expandHookIncludes(readFileSync(driftSource, "utf-8")));
  return p;
})();

let cwd: string;

/** `git init` a fresh repo, quietly — the hook validates its checkout root,
 *  so every project dir below is a real repo unless a test
 *  is specifically about the no-git case. */
function gitInit(dir: string): void {
  execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
}

/** The legacy shared Git dir, used only to assert old stamps remain untouched
 *  and linked worktrees share metadata despite isolated stamps. */
function gitCommonDir(dir: string): string {
  const raw = execFileSync("git", ["-C", dir, "rev-parse", "--git-common-dir"], {
    encoding: "utf-8",
  }).trim();
  // Realpath'd: on macOS `/tmp` is a symlink into `/private/tmp`, and git
  // itself resolves that symlink for a WORKTREE's common dir (its gitdir file
  // stores an absolute, already-resolved path) but not for a plain repo's
  // relative ".git" — the two forms name the same directory, so comparisons
  // across a main checkout and its worktree must normalize both.
  return realpathSync(raw.startsWith("/") ? raw : join(dir, raw));
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-drift-"));
  gitInit(cwd);
  mkdirSync(join(cwd, ".claude", "agents"), { recursive: true });
});

/** Run the hook against `cwd` (or `projectDir`, for a test driving a second
 *  directory); returns exit code and stderr. */
function runHook(
  payload?: Record<string, unknown>,
  projectDir: string = cwd,
): { code: number; stderr: string } {
  try {
    execFileSync("bash", [hookPath], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      input: payload ? JSON.stringify(payload) : "",
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });
    return { code: 0, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { code: e.status ?? -1, stderr: e.stderr ?? "" };
  }
}

/** A `PostToolUse` payload for a native write tool. */
function nativeWrite(filePath: string, tool = "Edit"): Record<string, unknown> {
  return {
    session_id: "sess-drift-1",
    tool_name: tool,
    tool_input: { file_path: filePath, old_string: "a", new_string: "b" },
  };
}

/** A CLAUDE.md whose managed block carries the hash navori would write. */
function writeManagedClaudeMd(body: string, hash = computeManagedHash(body)): void {
  writeFileSync(
    join(cwd, "CLAUDE.md"),
    `# Project\n\nMy own notes.\n\n<!-- navori:managed id="demo" hash="${hash}" version="9.9.9" source="@navori/core" -->\n${body}\n<!-- /navori:managed id="demo" -->\n\nMore of my notes.\n`,
    "utf-8",
  );
}

describe.runIf(runsBash)("managed-drift-watch.sh (#530)", () => {
  it("says nothing on its first run — it adopts the current state as baseline", () => {
    writeManagedClaudeMd("Managed body.");
    expect(runHook().code).toBe(0);
    // The stamp lives in checkout-local state, never `.claude/` — see
    // the dedicated describe block below for the worktree/no-git cases.
    expect(existsSync(join(cwd, ".navori", "state", "hooks", "managed-drift-stamp"))).toBe(true);
    expect(existsSync(join(cwd, ".claude", ".managed-drift-stamp"))).toBe(false);
  });

  it("stays silent when an edit lands OUTSIDE every managed block", () => {
    writeManagedClaudeMd("Managed body.");
    runHook();
    // The user section is the user's: editing it changes no block hash, and a
    // hook that fired here would be noise on a legitimate action.
    writeFileSync(
      join(cwd, "CLAUDE.md"),
      `${readFileSync(join(cwd, "CLAUDE.md"), "utf-8")}\n- a note of mine\n`,
    );
    expect(runHook().code).toBe(0);
  });

  it("reports the block, the declared hash and the real one when a body is rewritten", () => {
    writeManagedClaudeMd("Managed body.");
    runHook();
    const declared = computeManagedHash("Managed body.");
    writeFileSync(
      join(cwd, "CLAUDE.md"),
      readFileSync(join(cwd, "CLAUDE.md"), "utf-8").replace(
        "Managed body.",
        "Rewritten by a script.",
      ),
    );

    const { code, stderr } = runHook();

    expect(code).toBe(2);
    expect(stderr).toContain("CLAUDE.md");
    expect(stderr).toContain("demo");
    expect(stderr).toContain(declared);
    expect(stderr).toContain(computeManagedHash("Rewritten by a script."));
    // The message has to name the way out, or it is just an alarm.
    expect(stderr).toContain("navori sync");
  });

  /**
   * The wiring half (#775), and the reason it belongs in the SAME test as the
   * behaviour: this script never reads `tool_name`, so its matcher is the only
   * statement about when it runs and nothing inside the script can contradict a
   * wrong one. Scoped to `Bash` it was blind to the native lane — in
   * `default`/`acceptEdits` an `Edit` over CLAUDE.md broke a block's hash and
   * this said nothing until the next shell command, if one ever came.
   *
   * So: the registration must deliver `Edit`, AND an `Edit` payload over a
   * broken block must produce the report in that same call. Either one alone is
   * the half that never failed.
   */
  it("un Edit sobre un bloque roto dispara el aviso en la misma llamada", () => {
    const post = (
      buildClaudeSettings(MINIMAL_CONFIG, []).hooks as {
        PostToolUse?: Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
      }
    ).PostToolUse;
    const bucket = post?.find((b) =>
      b.hooks.some((h) => h.command.includes("managed-drift-watch.sh")),
    );
    expect(bucket?.matcher?.split("|")).toContain("Edit");

    writeManagedClaudeMd("Managed body.");
    // Baseline adopted through the native lane too — the stamp must exist after
    // an Edit, not only after a Bash.
    expect(runHook(nativeWrite(join(cwd, "CLAUDE.md"))).code).toBe(0);

    writeFileSync(
      join(cwd, "CLAUDE.md"),
      readFileSync(join(cwd, "CLAUDE.md"), "utf-8").replace(
        "Managed body.",
        "Rewritten through Edit.",
      ),
    );

    const { code, stderr } = runHook(nativeWrite(join(cwd, "CLAUDE.md")));
    expect(code).toBe(2);
    expect(stderr).toContain("CLAUDE.md");
    expect(stderr).toContain("demo");
    expect(stderr).toContain(computeManagedHash("Rewritten through Edit."));
  });

  it("agrees with computeManagedHash — the shell and TS algorithms must not part", () => {
    // A body with the things normalization touches: CRLF and trailing blank
    // space. If the hook's `$(…)`/sha1 pipeline ever diverges from
    // `hashContent`, this fires on a HEALTHY file and the hook becomes noise.
    const body = "Line one.\n\nLine two with detail.";
    writeManagedClaudeMd(body);
    runHook();
    expect(runHook().code).toBe(0);
  });

  it("reports a rewritten hook (shell-syntax markers), not just markdown", () => {
    const body = 'echo "hello"';
    const hash = computeManagedHash(body);
    const hook = join(cwd, ".claude", "agents", "sample.md");
    writeFileSync(
      hook,
      `# navori:managed start id="sample" hash="${hash}" version="9.9.9" source="@navori/core"\n${body}\n# navori:managed end id="sample"\n`,
      "utf-8",
    );
    runHook();
    writeFileSync(
      hook,
      readFileSync(hook, "utf-8").replace('echo "hello"', 'echo "tampered"'),
      "utf-8",
    );

    expect(runHook().code).toBe(2);
  });

  it("does not walk .claude/progress — every subagent writes there", () => {
    writeManagedClaudeMd("Managed body.");
    mkdirSync(join(cwd, ".claude", "progress"), { recursive: true });
    runHook();
    // A handoff file that QUOTES a marker (agent reports do this constantly)
    // must not be read as a real one.
    writeFileSync(
      join(cwd, ".claude", "progress", "impl_x.md"),
      '<!-- navori:managed id="quoted" hash="deadbeef" -->\nbody\n<!-- /navori:managed id="quoted" -->\n',
      "utf-8",
    );
    expect(runHook().code).toBe(0);
  });

  it("catches a second write that lands in the same second as the first", () => {
    // The regression that CI caught and macOS hid. The first implementation
    // asked `find -newer <stamp>`, and `find` compares mtimes at the
    // filesystem's resolution — ONE SECOND on ext4 under the runner. Two writes
    // inside the same second as the stamp were invisible: the watcher reported
    // the first and silently missed the second, which is the exact failure it
    // exists to prevent. No sleeps here on purpose — the writes below land
    // milliseconds apart, so a clock-based implementation fails this test.
    writeManagedClaudeMd("Managed body.");
    runHook();

    const md = join(cwd, "CLAUDE.md");
    writeFileSync(md, readFileSync(md, "utf-8").replace("Managed body.", "First rewrite."));
    expect(runHook().code).toBe(2);

    writeFileSync(md, readFileSync(md, "utf-8").replace("First rewrite.", "Second rewrite."));
    const second = runHook();
    expect(second.code).toBe(2);
    expect(second.stderr).toContain(computeManagedHash("Second rewrite."));
  });

  it("reports one write once, not on every command that follows", () => {
    writeManagedClaudeMd("Managed body.");
    runHook();
    writeFileSync(
      join(cwd, "CLAUDE.md"),
      readFileSync(join(cwd, "CLAUDE.md"), "utf-8").replace("Managed body.", "Tampered."),
    );

    expect(runHook().code).toBe(2);
    // Same broken file, no new write: silence. Otherwise the hook would shout
    // on every command for the rest of the session and get tuned out.
    expect(runHook().code).toBe(0);
  });
});

/**
 * Spec 0036 — linked worktrees must have isolated stamps, and an unavailable
 * checkout must degrade to "write nothing, exit 0, no new stderr".
 */
describe.runIf(runsBash)("managed-drift-watch.sh — where the stamp lives (#1024)", () => {
  it("writes an isolated stamp inside an agent worktree", () => {
    const branch = "wt-1024";
    const wtDir = join(cwd, ".claude", "worktrees", branch);
    mkdirSync(join(cwd, ".claude", "worktrees"), { recursive: true });
    execFileSync(
      "git",
      [
        "-C",
        cwd,
        "-c",
        "user.email=t@t.io",
        "-c",
        "user.name=t",
        "commit",
        "--allow-empty",
        "-q",
        "-m",
        "init",
      ],
      { stdio: "ignore" },
    );
    execFileSync("git", ["-C", cwd, "worktree", "add", "-q", "-b", branch, wtDir], {
      stdio: "ignore",
    });
    // Covers: R2, R10
    const otherDir = join(cwd, ".claude", "worktrees", "wt-1046-other");
    execFileSync("git", ["-C", cwd, "worktree", "add", "-q", "-b", "wt-1046-other", otherDir], {
      stdio: "ignore",
    });
    writeFileSync(
      join(wtDir, "CLAUDE.md"),
      `<!-- navori:managed id="demo" hash="${computeManagedHash("Managed body.")}" version="9.9.9" source="@navori/core" -->\nManaged body.\n<!-- /navori:managed id="demo" -->\n`,
      "utf-8",
    );
    writeFileSync(join(otherDir, "CLAUDE.md"), readFileSync(join(wtDir, "CLAUDE.md"), "utf-8"));

    const result = runHook(undefined, wtDir);
    expect(result.code).toBe(0);

    // Linked worktrees share a Git dir, but must not share detector state.
    expect(gitCommonDir(wtDir)).toBe(gitCommonDir(cwd));
    expect(existsSync(join(cwd, ".navori", "state", "hooks", "managed-drift-stamp"))).toBe(false);
    expect(existsSync(join(wtDir, ".navori", "state", "hooks", "managed-drift-stamp"))).toBe(true);
    expect(existsSync(join(otherDir, ".navori", "state", "hooks", "managed-drift-stamp"))).toBe(
      false,
    );
    expect(runHook(undefined, otherDir).code).toBe(0);
    expect(existsSync(join(otherDir, ".navori", "state", "hooks", "managed-drift-stamp"))).toBe(
      true,
    );
    // Nothing was ever written under the worktree's own `.claude/`.
    expect(existsSync(join(wtDir, ".claude", ".managed-drift-stamp"))).toBe(false);
  });

  it("outside a git repo: no stamp anywhere, exit 0, no new stderr", () => {
    const noGitDir = mkdtempSync(join(tmpdir(), "navori-drift-nogit-"));
    mkdirSync(join(noGitDir, ".claude"), { recursive: true });
    writeFileSync(
      join(noGitDir, "CLAUDE.md"),
      `<!-- navori:managed id="demo" hash="${computeManagedHash("Managed body.")}" version="9.9.9" source="@navori/core" -->\nManaged body.\n<!-- /navori:managed id="demo" -->\n`,
      "utf-8",
    );

    const result = runHook(undefined, noGitDir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(existsSync(join(noGitDir, ".claude", ".managed-drift-stamp"))).toBe(false);
  });

  // Covers: R10
  it("leaves the old shared stamp untouched and skips unsafe or missing roots", () => {
    const legacy = join(gitCommonDir(cwd), "navori", "managed-drift-stamp");
    mkdirSync(join(gitCommonDir(cwd), "navori"), { recursive: true });
    writeFileSync(legacy, "legacy-stamp\n");
    writeManagedClaudeMd("Managed body.");
    expect(runHook().code).toBe(0);
    expect(readFileSync(legacy, "utf-8")).toBe("legacy-stamp\n");

    const unsafe = mkdtempSync(join(tmpdir(), "navori-drift-unsafe-"));
    const anotherRepo = mkdtempSync(join(tmpdir(), "navori-drift-symlink-"));
    gitInit(anotherRepo);
    symlinkSync(unsafe, join(anotherRepo, ".navori"));
    expect(runHook(undefined, anotherRepo)).toEqual({ code: 0, stderr: "" });
    expect(existsSync(join(unsafe, "state"))).toBe(false);
    expect(runHook(undefined, "")).toEqual({ code: 0, stderr: "" });
  });

  // Covers: R10
  it("does not follow a final stamp symlink outside the checkout", () => {
    writeManagedClaudeMd("Managed body.");
    const outside = join(mkdtempSync(join(tmpdir(), "navori-drift-target-")), "target");
    writeFileSync(outside, "outside-content\n");
    const stateDir = join(cwd, ".navori", "state", "hooks");
    mkdirSync(stateDir, { recursive: true });
    symlinkSync(outside, join(stateDir, "managed-drift-stamp"));

    expect(runHook()).toEqual({ code: 0, stderr: "" });
    expect(readFileSync(outside, "utf-8")).toBe("outside-content\n");
  });
});
