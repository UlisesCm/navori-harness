import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  existsSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { getCoreRoot, getPluginPath } from "../render/bundled-assets.ts";
import { shellSingleQuote } from "../primitives/shell-escape.ts";
import { interpolate } from "../render/interpolate.ts";
import { expandHookIncludes } from "../render/hook-includes.ts";
import type { NavoriConfig } from "../config/config.ts";
import { acrossShells, HOOK_SHELLS, type HookShell } from "./helpers/shells.ts";

/**
 * #510 — what a gate hook EXITS WITH is its verdict, and `PreToolUse` reads
 * exactly one code as a block.
 *
 * Claude Code blocks a tool call only on exit 2. Any other non-zero code is
 * printed and the call PROCEEDS. Both gates used to hand their scanner's own
 * code through — semgrep maps findings to 1 with `--error`, jscpd maps "over
 * threshold" to 1 — so each printed a `▶ …` progress line, wrote its findings
 * to a stdout the hook does not show, and blocked nothing. The gates announced
 * activity and delivered no guarantee, which costs more trust than having no
 * gate at all.
 *
 * Nothing in the suite asserted a gate's exit code against a SEEDED finding
 * before this file: the closest cases (`gate-hook-worktree.test.ts`) used the
 * stub's exit 1 as a probe for "did we reach the scanner?" and titled it
 * "BLOCKS", which pinned the wrong contract instead of catching it. So the
 * three outcomes are separated here, each with its own code:
 *
 *   findings          → 2   the verdict blocks
 *   clean             → 0
 *   scanner exploded  → 1   NOT a verdict: nothing was validated, so it is
 *                           reported and the call proceeds
 *
 * Every case also counts stub invocations, so "clean" can never be produced by
 * a gate that silently never ran.
 */

const runsBash = process.platform !== "win32";
/** /usr/bin + /bin give the real git/sed/date the hooks need. */
const BASE_PATH = "/usr/bin:/bin";

/** `PreToolUse`'s only blocking code. */
const BLOCKS = 2;
/** Reported to the user, but the tool call proceeds. */
const WARNS = 1;
const CLEAN = 0;

type GateId = "semgrep" | "jscpd";
const GATES: readonly GateId[] = ["semgrep", "jscpd"];

/** The line each stub writes to STDOUT — the hook must relay it to stderr. */
const FINDING_LINE = "navori-test-finding: rule X matched a.ts";

function realBin(name: string): string {
  return execFileSync("bash", ["-c", `command -v ${name}`], { encoding: "utf-8" }).trim();
}

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
      ...args,
    ],
    { cwd, stdio: "pipe", encoding: "utf-8" },
  );
}

/** Render a gate script exactly as `navori render` does. */
function renderGate(id: GateId): string {
  const raw = expandHookIncludes(
    readFileSync(resolve(getPluginPath(id), `scripts/check-${id}.sh`), "utf-8"),
  );
  const config = { branchBase: "main", preset: "custom" } as unknown as NavoriConfig;
  return interpolate(raw, config, { extraVars: { jscpdThreshold: "10" } });
}

interface Fixture {
  dir: string;
  binDir: string;
  log: string;
  hooks: Record<GateId, string>;
  baseSha: string;
  baseShort: string;
}

/**
 * A repo on `main` with one modified `.ts` file, so both gates have exactly one
 * file to scan, plus scanner stubs that log their argv, print a finding to
 * STDOUT and exit with `scanExit`.
 */
function setupFixture(scanExit: number): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "navori-510-")));
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  git(dir, "init", "-q");
  git(dir, "add", "a.ts");
  git(dir, "commit", "-q", "--no-verify", "-m", "base");
  git(dir, "branch", "-M", "main");
  const baseSha = git(dir, "rev-parse", "main").trim();
  const baseShort = git(dir, "rev-parse", "--short", baseSha).trim();
  // The diff the gates must scan.
  writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");

  const binDir = join(dir, "fakebin");
  mkdirSync(binDir);
  const log = join(dir, "invocations.log");
  for (const tool of GATES) {
    const stub = join(binDir, tool);
    // jscpd's capability probe (#1060) calls `--help` before it ever scans;
    // answer it with both flags so the probe never intercepts the scan this
    // fixture is actually testing. Harmless for semgrep, which never calls it.
    const helpBranch =
      tool === "jscpd"
        ? `if [ "\${1:-}" = "--help" ]; then\n` +
          `  printf '%s\\n' "--baseline-from-ref --fail-on-new-clones"\n` +
          `  exit 0\n` +
          `fi\n`
        : "";
    writeFileSync(
      stub,
      `#!/usr/bin/env bash\n` +
        helpBranch +
        `printf '%s %s\\n' ${JSON.stringify(tool)} "$*" >> ${JSON.stringify(log)}\n` +
        `printf '%s\\n' ${JSON.stringify(FINDING_LINE)}\n` +
        `exit ${scanExit}\n`,
    );
    chmodSync(stub, 0o755);
  }

  const hooks = {} as Record<GateId, string>;
  for (const id of GATES) {
    const p = join(dir, `${id}-hook.sh`);
    writeFileSync(p, renderGate(id));
    chmodSync(p, 0o755);
    hooks[id] = p;
  }
  return { dir, binDir, log, hooks, baseSha, baseShort };
}

/**
 * Replace everything that differs between two runs of the same case — the
 * mkdtemp path and the base SHA — with stable placeholders. `acrossShells`
 * deep-equals bash's result against zsh's, and each shell gets its own fixture.
 */
function scrub(fx: Fixture, text: string): string {
  return text
    .split(fx.dir)
    .join("<REPO>")
    .split(fx.baseSha)
    .join("<BASE_SHA>")
    .split(fx.baseShort)
    .join("<BASE_SHORT>");
}

/**
 * Shadow `git` with a wrapper that forwards everything to the real binary
 * EXCEPT `git diff`, which fails the way a broken repo does (exit 128 with a
 * message on stderr). `$1` is enough: the gates always spell it `git diff …`
 * with no global option in front.
 */
function breakGitDiff(fx: Fixture): void {
  const shim = join(fx.binDir, "git");
  writeFileSync(
    shim,
    `#!/usr/bin/env bash\n` +
      `if [ "\${1:-}" = "diff" ]; then\n` +
      `  echo "fatal: navori-test: the object database is unreadable" >&2\n` +
      `  exit 128\n` +
      `fi\n` +
      `exec ${JSON.stringify(realBin("git"))} "$@"\n`,
  );
  chmodSync(shim, 0o755);
}

interface GateRun {
  status: number | null;
  stdout: string;
  stderr: string;
  /** How many times a scanner stub actually ran. */
  scans: number;
}

function runGate(fx: Fixture, shell: HookShell, id: GateId): GateRun {
  const r = spawnSync(shell, [fx.hooks[id]], {
    cwd: fx.dir,
    input: JSON.stringify({ tool_input: { command: "git commit -m x" } }),
    encoding: "utf-8",
    env: { PATH: `${fx.binDir}:${BASE_PATH}`, CLAUDE_PROJECT_DIR: fx.dir },
  });
  const scans = existsSync(fx.log)
    ? readFileSync(fx.log, "utf-8").trimEnd().split("\n").filter(Boolean).length
    : 0;
  return {
    status: r.status,
    stdout: scrub(fx, r.stdout ?? ""),
    stderr: scrub(fx, r.stderr ?? ""),
    scans,
  };
}

/** One fresh fixture per shell; the verdicts must agree (#391). */
function drive(scanExit: number, id: GateId, mutate?: (fx: Fixture) => void): GateRun {
  return acrossShells((shell) => {
    const fx = setupFixture(scanExit);
    mutate?.(fx);
    return runGate(fx, shell, id);
  });
}

describe.runIf(runsBash)("gate hooks — PreToolUse exit contract (#510)", () => {
  for (const id of GATES) {
    describe(id, () => {
      it("maps a SEEDED finding to exit 2 — the only code that blocks", () => {
        const out = drive(1, id);
        // The scanner ran: a verdict about a scan that never happened would be
        // worthless whatever its code.
        expect(out.scans).toBe(1);
        expect(out.status).toBe(BLOCKS);
      });

      it("relays the finding detail to stderr, which the hook actually shows", () => {
        const out = drive(1, id);
        expect(out.stderr).toContain(FINDING_LINE);
        // stdout is swallowed by the hook runner: nothing the user needs may
        // be left there.
        expect(out.stdout).not.toContain(FINDING_LINE);
      });

      it("exits 0 on a clean scan — and only after really scanning", () => {
        const out = drive(0, id);
        expect(out.status).toBe(CLEAN);
        // ANTI-FALSE-GREEN: without this, a gate that skipped itself entirely
        // would produce the same exit 0 as a gate that scanned and found
        // nothing. The stub log is what tells them apart.
        expect(out.scans).toBe(1);
      });

      it("does NOT block when the scanner itself falls over — that is no verdict", () => {
        const out = drive(3, id);
        expect(out.scans).toBe(1);
        expect(out.status).toBe(WARNS);
        expect(out.status).not.toBe(BLOCKS);
        expect(out.stderr).toContain("nothing was validated");
      });
    });
  }
});

/**
 * #511.4 — a `git diff` that FAILS must not be reported as "0 files".
 *
 * The list of files came out of a process substitution whose stderr went to
 * `/dev/null` and whose exit status the shell never reports, so exit 128 (an
 * unborn HEAD, a corrupt index, the wrong cwd) produced zero records and the
 * hook printed `⊘ 0 files to scan` and exited 0. The failure and the benign
 * result had the SAME visible output.
 */
describe.runIf(runsBash)("gate hooks — a failed `git diff` is not an empty diff (#511)", () => {
  for (const id of GATES) {
    it(`${id}: says NOTHING was scanned instead of posing as an empty diff`, () => {
      const out = drive(0, id, breakGitDiff);

      expect(out.scans).toBe(0);
      // Not the success code, and not the block code either: nothing was
      // verified, which is a tooling failure, not a verdict.
      expect(out.status).toBe(WARNS);
      expect(out.stderr).toContain("FAILED");
      expect(out.stderr).toContain("NOTHING was scanned");
      // The sentence that used to stand in for it must NOT appear: that is the
      // whole defect — an error wearing a benign result's clothes.
      expect(out.stderr).not.toContain("0 files to scan");
    });

    it(`${id}: an empty diff still reads as an empty diff (control)`, () => {
      // ANTI-FALSE-GREEN for the case above: if the new branch fired on every
      // run, the assertions above would pass for the wrong reason. A clean tree
      // is the legitimate "nothing to scan" and must still say so, at exit 0.
      const out = acrossShells((shell) => {
        const fx = setupFixture(0);
        git(fx.dir, "checkout", "-q", "--", "a.ts");
        return runGate(fx, shell, id);
      });

      expect(out.status).toBe(CLEAN);
      expect(out.scans).toBe(0);
      expect(out.stderr).toContain("0 files to scan");
      expect(out.stderr).not.toContain("NOTHING was scanned");
    });
  }
});

/**
 * #1060 — jscpd's capability probe. `--baseline-from-ref`/`--fail-on-new-clones`
 * only exist from jscpd 5.1.1 on; a binary that lacks them must BLOCK with an
 * actionable message, never be misread as a duplication verdict.
 *
 * A single-file jscpd fixture, independent of `setupFixture` above: the stub's
 * `--help` output (not its scan exit code) is what each case varies.
 */
function setupJscpdCapabilityFixture(helpOutput: string, hasFiles = true): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "navori-1060-cap-")));
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  git(dir, "init", "-q");
  git(dir, "add", "a.ts");
  git(dir, "commit", "-q", "--no-verify", "-m", "base");
  git(dir, "branch", "-M", "main");
  const baseSha = git(dir, "rev-parse", "main").trim();
  const baseShort = git(dir, "rev-parse", "--short", baseSha).trim();
  if (hasFiles) writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");

  const binDir = join(dir, "fakebin");
  mkdirSync(binDir);
  const log = join(dir, "invocations.log");
  const stub = join(binDir, "jscpd");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash\n` +
      `if [ "\${1:-}" = "--help" ]; then\n` +
      `  printf '%s\\n' ${JSON.stringify(helpOutput)}\n` +
      `  exit 0\n` +
      `fi\n` +
      `printf '%s %s\\n' "jscpd" "$*" >> ${JSON.stringify(log)}\n` +
      `printf '%s\\n' ${JSON.stringify(FINDING_LINE)}\n` +
      `exit 0\n`,
  );
  chmodSync(stub, 0o755);

  const hooks = { jscpd: join(dir, "jscpd-hook.sh") } as Record<GateId, string>;
  writeFileSync(hooks.jscpd, renderGate("jscpd"));
  chmodSync(hooks.jscpd, 0o755);
  return { dir, binDir, log, hooks, baseSha, baseShort };
}

describe.runIf(runsBash)(
  "jscpd capability probe — binary without the new flags BLOCKS (#1060)",
  () => {
    it("a --help without either flag blocks with the upgrade message, 0 scans", () => {
      const out = acrossShells((shell) => {
        const fx = setupJscpdCapabilityFixture("Usage: jscpd [options] <path>");
        return runGate(fx, shell, "jscpd");
      });

      expect(out.status).toBe(BLOCKS);
      expect(out.stderr).toContain("upgrade");
      expect(out.stderr).toContain("5.1.1");
      expect(out.stderr).not.toContain(FINDING_LINE);
      expect(out.scans).toBe(0);
    });

    it("with 0 TS files to scan, an old binary does not block (never reached)", () => {
      const out = acrossShells((shell) => {
        const fx = setupJscpdCapabilityFixture("Usage: jscpd [options] <path>", false);
        git(fx.dir, "checkout", "-q", "--", "a.ts");
        return runGate(fx, shell, "jscpd");
      });

      expect(out.status).toBe(CLEAN);
      expect(out.scans).toBe(0);
    });

    it("a long --help that DOES contain both flags does not block (no SIGPIPE false negative)", () => {
      const longHelp =
        "Usage: jscpd [options]\n" +
        Array.from(
          { length: 200 },
          (_, i) => `  --some-unrelated-flag-${i} <value>  description text`,
        ).join("\n") +
        "\n  --baseline-from-ref <ref>\n  --fail-on-new-clones [<N>]\n";
      const out = acrossShells((shell) => {
        const fx = setupJscpdCapabilityFixture(longHelp);
        return runGate(fx, shell, "jscpd");
      });

      expect(out.status).toBe(CLEAN);
      expect(out.scans).toBe(1);
    });
  },
);

/**
 * #1117 — a gate whose TOOL failed has no verdict. Under a Claude PreToolUse
 * hook the user is asked (exit 0 + `permissionDecision: "ask"`); Codex drops
 * that field, and a git hook / CLI has nobody to ask, so both keep blocking.
 * Real verdicts (red gate, semgrep findings) stay hard blocks everywhere.
 */
const hasJq = spawnSync("jq", ["--version"], { env: { PATH: BASE_PATH } }).status === 0;
const HOOK_PAYLOAD = (
  cwd: string,
  command = "git commit -m x",
  permissionMode: string | null = "default",
): string =>
  JSON.stringify({
    session_id: "s1",
    cwd,
    hook_event_name: "PreToolUse",
    ...(permissionMode === null ? {} : { permission_mode: permissionMode }),
    tool_name: "Bash",
    tool_input: { command },
  });

interface AskRun {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Audit events written by the run. */
  events: { verdict?: string; reason?: string; kind?: string }[];
}

/**
 * Run `script` (copied to `relPath` under the fixture, so `.codex/` placement
 * can be simulated) with `input` on stdin and a throwaway audit root.
 */
function runAsk(
  shell: HookShell,
  dir: string,
  binDir: string,
  script: string,
  relPath: string,
  input: string,
): AskRun {
  const target = join(dir, relPath);
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, readFileSync(script, "utf-8"));
  chmodSync(target, 0o755);
  const auditsRoot = realpathSync(mkdtempSync(join(tmpdir(), "navori-1117-audits-")));
  mkdirSync(join(auditsRoot, basename(dir)), { mode: 0o700 });
  writeFileSync(
    join(binDir, "navori"),
    `#!/bin/sh\nexec '${process.execPath}' '${resolve("dist/index.js")}' "$@"\n`,
    { mode: 0o700 },
  );
  const log = join(auditsRoot, basename(dir), "session-s1.log");
  writeFileSync(
    log,
    `${JSON.stringify({ event: "start", host: relPath.includes(".codex/") ? "codex" : "claude", sessionId: "s1", cwd: dir })}\n`,
    {
      mode: 0o600,
    },
  );
  const r = spawnSync(shell, [target], {
    cwd: dir,
    input,
    encoding: "utf-8",
    env: {
      PATH: `${binDir}:${BASE_PATH}`,
      CLAUDE_PROJECT_DIR: dir,
      NAVORI_AUDITS_ROOT: auditsRoot,
    },
  });
  const events = readFileSync(log, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { verdict?: string; reason?: string; kind?: string });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", events };
}

/** Parse the single ask decision a hook printed on stdout. */
function askDecision(stdout: string): { decision: string; reason: string; event: string } {
  const out = JSON.parse(stdout) as {
    hookSpecificOutput: {
      hookEventName: string;
      permissionDecision: string;
      permissionDecisionReason: string;
    };
  };
  return {
    decision: out.hookSpecificOutput.permissionDecision,
    reason: out.hookSpecificOutput.permissionDecisionReason,
    event: out.hookSpecificOutput.hookEventName,
  };
}

describe.runIf(runsBash && hasJq)("jscpd no-verdict cases ask under Claude (#1117)", () => {
  /** Old binary: lacks the flags → no verdict. */
  const noFlags = (shell: HookShell, relPath: string, input?: (dir: string) => string) => {
    const fx = setupJscpdCapabilityFixture("Usage: jscpd [options] <path>");
    return runAsk(
      shell,
      fx.dir,
      fx.binDir,
      fx.hooks.jscpd,
      relPath,
      input ? input(fx.dir) : HOOK_PAYLOAD(fx.dir),
    );
  };

  // Covers: A1
  it("missing flags + Claude hook payload → ask JSON, exit 0, reason names the cause", () => {
    for (const shell of HOOK_SHELLS) {
      const out = noFlags(shell, "hook.sh");
      expect(out.status).toBe(CLEAN);
      const d = askDecision(out.stdout);
      expect(d.decision).toBe("ask");
      expect(d.event).toBe("PreToolUse");
      expect(d.reason).toContain("--baseline-from-ref");
      expect(d.reason).toContain("5.1.1");
      expect(d.reason).not.toContain("outside the agent");
    }
  });

  // Covers: A3
  it("records the ask outcome in the audit log with its reason", () => {
    const out = noFlags("bash", "hook.sh");
    const ask = out.events.find((e) => e.verdict === "ask");
    expect(ask?.reason).toBe("unspecified");
    expect(out.events.some((e) => e.verdict === "block")).toBe(false);
  });

  /**
   * Exit-1 jscpd stub shaped like the real binary (samples captured from jscpd
   * 5.3.2): a finished scan with clones writes `jscpd-report.json` under
   * `--output` with `statistics.total.newClones`; a crash writes nothing.
   */
  const exit1Fixture = (newClones: number | null | "corrupt"): Fixture => {
    const fx = setupFixture(1);
    const stub = join(fx.binDir, "jscpd");
    const report =
      newClones === null
        ? ""
        : `out=""; prev=""; for a in "$@"; do [ "$prev" = "--output" ] && out="$a"; prev="$a"; done\n` +
          `printf '%s' '${newClones === "corrupt" ? "{not json" : `{"statistics":{"total":{"newClones":${newClones}}}}`}' > "$out/jscpd-report.json"\n`;
    writeFileSync(
      stub,
      `#!/usr/bin/env bash\n` +
        `if [ "\${1:-}" = "--help" ]; then printf '%s\\n' "--baseline-from-ref --fail-on-new-clones"; exit 0; fi\n` +
        report +
        `exit 1\n`,
    );
    chmodSync(stub, 0o755);
    return fx;
  };

  // Covers: A1
  it("exit 1 with a report showing NEW CLONES stays a hard block (exit 2) under a Claude payload", () => {
    const fx = exit1Fixture(2);
    const out = runAsk("bash", fx.dir, fx.binDir, fx.hooks.jscpd, "hook.sh", HOOK_PAYLOAD(fx.dir));
    expect(out.status).toBe(BLOCKS);
    expect(out.stdout).not.toContain("permissionDecision");
    expect(out.events.find((e) => e.verdict === "block")?.reason).toBe("unspecified");
    expect(out.stderr).toContain("2 new clone(s)");
    expect(out.events.some((e) => e.verdict === "ask")).toBe(false);
  });

  // Covers: A1
  it("exit 1 with a report that EXISTS but is corrupt fails closed (exit 2, block) under a Claude payload", () => {
    const fx = exit1Fixture("corrupt");
    const out = runAsk("bash", fx.dir, fx.binDir, fx.hooks.jscpd, "hook.sh", HOOK_PAYLOAD(fx.dir));
    expect(out.status).toBe(BLOCKS);
    expect(out.stdout).not.toContain("permissionDecision");
    expect(out.events.find((e) => e.verdict === "block")?.reason).toBe("unspecified");
    expect(out.stderr).toContain("cannot rule out new clones");
  });

  // Covers: A1
  it("exit 1 with a report but no jq stays exit 2 under a Claude payload", () => {
    const fx = exit1Fixture(0);
    // PATH without jq: shim only the tools the hook needs.
    const lean = join(fx.dir, "leanbin");
    mkdirSync(lean);
    for (const t of [
      "bash",
      "git",
      "sed",
      "cat",
      "mktemp",
      "rm",
      "env",
      "date",
      "head",
      "tr",
      "dirname",
      "basename",
      "grep",
      "uname",
      "perl",
      "node",
    ]) {
      try {
        symlinkSync(realBin(t), join(lean, t));
      } catch {
        /* tool absent on this host */
      }
    }
    symlinkSync(join(fx.binDir, "jscpd"), join(lean, "jscpd"));
    const target = join(fx.dir, "hook-nojq.sh");
    writeFileSync(target, readFileSync(fx.hooks.jscpd, "utf-8"));
    const r = spawnSync("bash", [target], {
      cwd: fx.dir,
      input: HOOK_PAYLOAD(fx.dir),
      encoding: "utf-8",
      env: { PATH: lean, CLAUDE_PROJECT_DIR: fx.dir },
    });
    expect(r.status).toBe(BLOCKS);
    expect(r.stdout).not.toContain("permissionDecision");
    expect(r.stderr).toContain("report is unreadable");
  });

  // Covers: A1
  it("exit 1 with NO report (crash) + Claude hook payload → ask, audited as ask", () => {
    const fx = exit1Fixture(null);
    const out = runAsk("bash", fx.dir, fx.binDir, fx.hooks.jscpd, "hook.sh", HOOK_PAYLOAD(fx.dir));
    expect(out.status).toBe(CLEAN);
    const d = askDecision(out.stdout);
    expect(d.decision).toBe("ask");
    expect(d.reason).toContain("no duplication verdict");
    expect(d.reason).not.toContain("outside the agent");
    expect(out.events.find((e) => e.verdict === "ask")?.reason).toBe("unspecified");
  });

  // Covers: A1
  it("exit 1 with no report and no hook payload keeps today's exit 2", () => {
    const fx = exit1Fixture(null);
    const out = runAsk("bash", fx.dir, fx.binDir, fx.hooks.jscpd, "hook.sh", "");
    expect(out.status).toBe(BLOCKS);
    expect(out.stdout).toBe("");
  });

  // Covers: A1
  it("Codex copy (.codex/scripts) keeps blocking with exit 2 and prints no ask", () => {
    const out = noFlags("bash", ".codex/scripts/check-jscpd.sh");
    expect(out.status).toBe(BLOCKS);
    expect(out.stdout).not.toContain("permissionDecision");
    expect(out.stderr).toContain("5.1.1");
    expect(out.events.some((e) => e.verdict === "block")).toBe(true);
  });

  // Covers: A1
  it("no hook payload (git hook / CLI, stdin empty) keeps today's exit 2", () => {
    const out = noFlags("bash", "hook.sh", () => "");
    expect(out.status).toBe(BLOCKS);
    expect(out.stdout).toBe("");
  });

  // Covers: A1
  it("a payload without hook_event_name (not a recognised hook call) keeps blocking", () => {
    const out = noFlags("bash", "hook.sh", (dir) =>
      JSON.stringify({ session_id: "s1", cwd: dir, tool_input: { command: "git commit -m x" } }),
    );
    expect(out.status).toBe(BLOCKS);
    expect(out.stdout).toBe("");
  });

  // Covers: A1
  it("a real semgrep verdict (findings) stays exit 2 under a Claude hook payload", () => {
    const fx = setupFixture(1);
    const out = runAsk(
      "bash",
      fx.dir,
      fx.binDir,
      fx.hooks.semgrep,
      "hook.sh",
      HOOK_PAYLOAD(fx.dir),
    );
    expect(out.status).toBe(BLOCKS);
    expect(out.stdout).not.toContain("permissionDecision");
  });
});

describe.runIf(runsBash && hasJq)("quality-gate runner missing asks under Claude (#1117)", () => {
  const HOOK_SRC = resolve(getCoreRoot(), "core-assets/hooks/quality-gate-pre-commit.sh");

  /** A non-git dir, a gate whose runner is absent from PATH or present-but-red. */
  function qgFixture(runner: "missing" | "red"): { dir: string; binDir: string; script: string } {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "navori-1117-qg-")));
    const binDir = join(dir, "fakebin");
    mkdirSync(binDir);
    if (runner === "red") {
      const stub = join(binDir, "pnpm");
      writeFileSync(stub, "#!/usr/bin/env bash\nexit 1\n");
      chmodSync(stub, 0o755);
    }
    const script = join(dir, "src-hook.sh");
    writeFileSync(
      script,
      expandHookIncludes(readFileSync(HOOK_SRC, "utf-8")).replace(
        "{{shq:qualityGate.fast}}",
        shellSingleQuote("pnpm run typecheck"),
      ),
    );
    return { dir, binDir, script };
  }

  // Covers: A2
  it("runner not on PATH + Claude hook payload → ask JSON, exit 0, no 'outside the agent'", () => {
    for (const shell of HOOK_SHELLS) {
      const fx = qgFixture("missing");
      const out = runAsk(shell, fx.dir, fx.binDir, fx.script, "hook.sh", HOOK_PAYLOAD(fx.dir));
      expect(out.status).toBe(CLEAN);
      const d = askDecision(out.stdout);
      expect(d.decision).toBe("ask");
      expect(d.reason).toContain("'pnpm'");
      expect(d.reason).toContain("no verdict");
      expect(d.reason).not.toContain("outside the agent");
    }
  });

  // Covers: A3
  it("records the ask outcome in the audit log with its reason", () => {
    const fx = qgFixture("missing");
    const out = runAsk("bash", fx.dir, fx.binDir, fx.script, "hook.sh", HOOK_PAYLOAD(fx.dir));
    expect(out.events.find((e) => e.verdict === "ask")?.reason).toBe("unspecified");
    expect(out.events.some((e) => e.verdict === "block")).toBe(false);
  });

  // Covers: A1, A2
  it("the ask record carries kind=ask", () => {
    const fx = qgFixture("missing");
    const out = runAsk("bash", fx.dir, fx.binDir, fx.script, "hook.sh", HOOK_PAYLOAD(fx.dir));
    expect(out.events.find((e) => e.verdict === "ask")?.kind).toBe("ask");
  });

  // Covers: A1, A2
  it("a red gate records its own block reason with kind=hard", () => {
    const fx = qgFixture("red");
    const out = runAsk("bash", fx.dir, fx.binDir, fx.script, "hook.sh", HOOK_PAYLOAD(fx.dir));
    const block = out.events.find((e) => e.verdict === "block");
    expect(block?.reason).toBe("unspecified");
    expect(out.stderr).toContain("quality-gate fast failed. Commit aborted.");
    expect(block?.kind).toBe("hard");
  });

  // Covers: A1, A2
  it("a missing runner outside an ask-capable context records a distinct block reason", () => {
    const fx = qgFixture("missing");
    const out = runAsk(
      "bash",
      fx.dir,
      fx.binDir,
      fx.script,
      ".codex/hooks/qg.sh",
      HOOK_PAYLOAD(fx.dir),
    );
    const block = out.events.find((e) => e.verdict === "block");
    expect(block?.reason).toBe("unspecified");
    expect(out.stderr).toContain("Commit BLOCKED to avoid skipping the gate silently");
    expect(block?.kind).toBe("hard");
  });

  // Covers: A2
  it("a red gate stays exit 2 under a Claude hook payload", () => {
    const fx = qgFixture("red");
    const out = runAsk("bash", fx.dir, fx.binDir, fx.script, "hook.sh", HOOK_PAYLOAD(fx.dir));
    expect(out.status).toBe(BLOCKS);
    expect(out.stdout).not.toContain("permissionDecision");
  });

  // Covers: A2
  it("Codex copy (.codex/hooks) keeps exit 2 with the original block message", () => {
    const fx = qgFixture("missing");
    const out = runAsk(
      "bash",
      fx.dir,
      fx.binDir,
      fx.script,
      ".codex/hooks/qg.sh",
      HOOK_PAYLOAD(fx.dir),
    );
    expect(out.status).toBe(BLOCKS);
    expect(out.stdout).not.toContain("permissionDecision");
    expect(out.stderr).toContain("Commit BLOCKED");
    expect(out.events.some((e) => e.verdict === "block")).toBe(true);
  });

  // Covers: A2
  it("a payload with no hook_event_name keeps exit 2", () => {
    const fx = qgFixture("missing");
    const out = runAsk(
      "bash",
      fx.dir,
      fx.binDir,
      fx.script,
      "hook.sh",
      JSON.stringify({ session_id: "s1", cwd: fx.dir, tool_input: { command: "git commit -m x" } }),
    );
    expect(out.status).toBe(BLOCKS);
    expect(out.stdout).toBe("");
  });
});

describe.runIf(runsBash && hasJq)("navori_can_ask only asks where the prompt shows (#1117)", () => {
  const HOOK_SRC = resolve(getCoreRoot(), "core-assets/hooks/quality-gate-pre-commit.sh");
  const runMode = (mode: string | null, relPath = "hook.sh"): AskRun => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "navori-1117-mode-")));
    const binDir = join(dir, "fakebin");
    mkdirSync(binDir);
    const script = join(dir, "src-hook.sh");
    writeFileSync(
      script,
      expandHookIncludes(readFileSync(HOOK_SRC, "utf-8")).replace(
        "{{shq:qualityGate.fast}}",
        shellSingleQuote("pnpm run typecheck"),
      ),
    );
    return runAsk("bash", dir, binDir, script, relPath, HOOK_PAYLOAD(dir, "git commit -m x", mode));
  };

  // Covers: A1
  it.each(["default", "acceptEdits", "auto"])(
    "permission_mode %s asks (exit 0 + ask JSON)",
    (m) => {
      const out = runMode(m);
      expect(out.status).toBe(CLEAN);
      expect(askDecision(out.stdout).decision).toBe("ask");
    },
  );

  // Covers: A1
  it.each(["bypassPermissions", "dontAsk", "plan", "", "weird", null])(
    "permission_mode %s fails closed (exit 2, no stdout)",
    (m) => {
      const out = runMode(m);
      expect(out.status).toBe(BLOCKS);
      expect(out.stdout).toBe("");
    },
  );

  // Covers: A1
  it("permission_mode default on a Codex copy keeps exit 2", () => {
    const out = runMode("default", ".codex/hooks/qg.sh");
    expect(out.status).toBe(BLOCKS);
    expect(out.stdout).toBe("");
  });
});
