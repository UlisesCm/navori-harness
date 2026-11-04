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
}
interface Replay {
  readCorpus: () => CorpusCase[];
  caseKey: (c: CorpusCase) => string;
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
 */
const KNOWN_DIVERGENCES = [
  {
    hook: "plan-gate.sh",
    engine: "codex",
    reason: "`$0` read inside plan_gate_no_verdict: zsh sees the function name, codex_copy stays 0",
    matches: (c: CorpusCase): boolean => c.input.includes("workplan: x"),
  },
];

const isKnown = (c: CorpusCase): boolean =>
  KNOWN_DIVERGENCES.some((k) => k.hook === c.hook && k.engine === c.engine && k.matches(c));

/**
 * Cases per test. The whole corpus (~3,000 cases × 2 audit modes) in one test took ~150 s idle
 * and crossed its single 300 s limit under load (#1485); a fixed-size chunk keeps the work per
 * test bounded, so the default testTimeout is only a hang detector.
 */
const CHUNK_SIZE = 125;

/** Splits `cases` into consecutive chunks of at most `size`. */
function chunk<T>(cases: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < cases.length; i += size) chunks.push(cases.slice(i, i + size));
  return chunks;
}

describe.runIf(hasZsh)("hooks under zsh", () => {
  const capturedUnderBash = replay.readCorpus().filter((c) => c.shell === "bash");
  const keyed = capturedUnderBash
    .filter((c) => !isKnown(c))
    .map((c) => ({ key: replay.caseKey(c), c }))
    // Stable order, so a chunk's membership (and its name) does not move between runs.
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const corpus = keyed.map((k) => k.c);
  const chunks = chunk(corpus, CHUNK_SIZE).map((cases, index) => ({
    name: `${index * CHUNK_SIZE + 1}-${index * CHUNK_SIZE + cases.length} (${[...new Set(cases.map((c) => c.hook))].join(", ")})`,
    cases,
  }));

  // Covers: R16
  it("los chunks cubren el corpus filtrado completo, cada caso una sola vez", () => {
    expect(corpus.length).toBeGreaterThan(0);
    const covered = chunks.flatMap((ch) => ch.cases);
    expect(covered).toHaveLength(corpus.length);
    const keys = covered.map((c) => replay.caseKey(c));
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(keys)).toEqual(new Set(keyed.map((k) => k.key)));
    expect(chunks.every((ch) => ch.cases.length <= CHUNK_SIZE)).toBe(true);
  });

  // Covers: R16
  it.each(chunks)("el corpus da el mismo veredicto bajo zsh: casos $name", async ({ cases }) => {
    const result = await replay.replayCorpus({ corpus: cases, shell: "zsh", all: true });
    expect(result.failure).toBeUndefined();
    expect(result.ok).toBe(true);
  });

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
