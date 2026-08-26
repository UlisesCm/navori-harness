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
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPluginPath } from "../bundled-assets.ts";
import { interpolate } from "../interpolate.ts";
import { expandHookIncludes } from "../hook-includes.ts";
import type { NavoriConfig } from "../config.ts";
import { acrossShells, type HookShell } from "./helpers/shells.ts";

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
    writeFileSync(
      stub,
      `#!/usr/bin/env bash\n` +
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
