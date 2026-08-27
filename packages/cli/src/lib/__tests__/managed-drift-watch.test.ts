import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { getCoreRoot } from "../bundled-assets.ts";
import { computeManagedHash } from "../marker.ts";

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
const hookPath = resolve(getCoreRoot(), "core-assets/hooks/managed-drift-watch.sh");

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-drift-"));
  mkdirSync(join(cwd, ".claude", "agents"), { recursive: true });
});

/** Run the hook against `cwd`; returns exit code and stderr. */
function runHook(): { code: number; stderr: string } {
  try {
    execFileSync("bash", [hookPath], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });
    return { code: 0, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { code: e.status ?? -1, stderr: e.stderr ?? "" };
  }
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
    expect(existsSync(join(cwd, ".claude", ".managed-drift-stamp"))).toBe(true);
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
