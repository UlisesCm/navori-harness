import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * Spec 0055 R16 / D9 — the zsh safety net. The suite runs the hooks under bash only (plus the cases
 * marked `shellSensitive`); this replays the COMPLETE committed verdict corpus under zsh and
 * requires the same verdict, audit off and active. Cases captured under zsh are already zsh output
 * (the regular replay checks them); the ones captured under bash are the new information, so those
 * are the ones run under zsh here. A construct that behaves differently in zsh (word-splitting
 * #391, globbing, `nomatch`, `$0` in a function, `set -u`) fails with the case that shows it.
 *
 * Across shells the only normalization is the wording of the shell's own diagnostics (`line 50: cat:
 * command not found` vs `:50: command not found: cat`) and hooks whose source carries an unrendered
 * `{{placeholder}}` command line (zsh rejects the file at parse time, bash at that line).
 */

interface CorpusCase {
  hook: string;
  engine: string;
  shell: string;
  input: string;
  expected: { off: { stderr: string } };
}
interface Replay {
  readCorpus: () => CorpusCase[];
  replayCorpus: (options: {
    corpus: CorpusCase[];
    shell: string;
    all?: boolean;
  }) => Promise<{ ok: boolean; cases: number; failure?: string }>;
}

const here = dirname(fileURLToPath(import.meta.url));
const replay = (await import(
  pathToFileURL(resolve(here, "..", "..", "..", "..", "scripts", "js", "hook-verdict-replay.mjs"))
    .href
)) as Replay;

const hasZsh = spawnSync("zsh", ["-c", "exit 0"]).status === 0;

/**
 * Real bash/zsh divergences found by the replay and NOT fixed here. `plan-gate.sh` reads `$0`
 * inside `plan_gate_no_verdict`, where zsh sets it to the function name, so the Codex copy loses
 * its hard block when navori is missing (zsh asks, exit 0; bash blocks, exit 2). The hook rule
 * (resolve-worktree.sh: "NEVER read `$0` inside a `navori_*` function") is already written; the
 * hook still has to follow it. Delete the entry when it does: the second test fails to say so.
 *
 * The same `$0` read is what every Codex case that reaches `plan_gate_no_verdict` in an asking
 * permission mode shows (navori missing, or a `plan` subcommand that fails): they are matched by
 * what bash printed, not by one input.
 *
 * `quality-gate-pre-commit.sh` is a corpus artifact, not a hook bug: the corpus runs the UNRENDERED
 * asset, so the gate command is the word `{{shq:qualityGate.fast}}`. Bash runs it as a command name
 * (a fixture defines one); zsh reads `{{…}}` as a brace expansion and fails to parse it. A rendered
 * gate has no braces, so this never happens in a repo.
 */
const KNOWN_DIVERGENCES = [
  {
    hook: "plan-gate.sh",
    engine: "codex" as string | undefined,
    reason: "`$0` read inside plan_gate_no_verdict: zsh sees the function name, codex_copy stays 0",
    matches: (c: CorpusCase): boolean =>
      c.input.includes("workplan: x") ||
      (/"permission_mode":"(default|acceptEdits|auto)"/.test(c.input) &&
        /navori is not installed|no working 'plan' subcommand/.test(c.expected.off.stderr)),
  },
  {
    hook: "quality-gate-pre-commit.sh",
    engine: undefined as string | undefined,
    reason: "the unrendered gate `{{shq:qualityGate.fast}}` is a brace expansion to zsh's eval",
    matches: (c: CorpusCase): boolean =>
      c.expected.off.stderr.includes("running quality-gate fast: {{shq:qualityGate.fast}}"),
  },
];

const isKnown = (c: CorpusCase): boolean =>
  KNOWN_DIVERGENCES.some(
    (k) => k.hook === c.hook && (k.engine === undefined || k.engine === c.engine) && k.matches(c),
  );

describe.runIf(hasZsh)("hooks under zsh", () => {
  const capturedUnderBash = replay.readCorpus().filter((c) => c.shell === "bash");

  // Covers: R16
  it("el corpus da el mismo veredicto bajo zsh", async () => {
    const corpus = capturedUnderBash.filter((c) => !isKnown(c));
    expect(corpus.length).toBeGreaterThan(0);
    const result = await replay.replayCorpus({ corpus, shell: "zsh", all: true });
    expect(result.failure).toBeUndefined();
    expect(result.ok).toBe(true);
  }, 300_000);

  // Covers: R16
  it("cada divergencia conocida sigue divergiendo (si el hook se arregla, quita la entrada)", async () => {
    const known = capturedUnderBash.filter(isKnown);
    expect(known.length).toBeGreaterThan(0);
    const result = await replay.replayCorpus({ corpus: known, shell: "zsh" });
    expect(result.ok, "the known zsh divergence is fixed: remove it from KNOWN_DIVERGENCES").toBe(
      false,
    );
  }, 120_000);
});
