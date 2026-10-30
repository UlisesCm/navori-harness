import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Spec 0059 D35, R54 — before a session hook enters `shadow`, the committed verdict corpus holds at
 * least one case per verdict class and per mode argument, in each engine that registers it. This is
 * the check: a cell below that the corpus lacks fails, with the hook, engine and mode it names.
 *
 * A class is what the hook's output says, not only its exit status: a model advice and a silent
 * `Stop` are both exit 0 but different verdicts. The classes the corpus cannot produce are
 * declared at the end instead of being silently absent.
 */

const here = dirname(fileURLToPath(import.meta.url));
const replay = (await import(
  pathToFileURL(resolve(here, "..", "..", "..", "..", "scripts", "js", "hook-verdict-replay.mjs"))
    .href
)) as {
  readCorpus: () => Case[];
};

interface Case {
  hook: string;
  engine: string;
  args?: string[];
  expected: { off: { status: number; stdout: string; stderr: string } };
}

/** How a case's output reads. */
type Class = "silent" | "advice" | "note" | "allow" | "block";

interface Cell {
  hook: string;
  engine: "claude" | "codex" | "pi";
  /** The hook's own arguments; `[]` is the registration with none. */
  mode: string[];
  verdict: Class;
  /** Text the output of that verdict carries, when the class alone does not say which. */
  says?: RegExp;
}

const MODE = {
  claudeStart: ["claude-session-start"],
  claudeSwitch: ["claude-post-model-switch"],
  claudeStop: ["claude-stop"],
  codexStart: ["codex-session-start"],
};

const CELLS: Cell[] = [
  // model-advisor: every mode that runs natively, advising and silent, and the modes it never guesses.
  { hook: "model-advisor.sh", engine: "claude", mode: MODE.claudeStart, verdict: "silent" },
  { hook: "model-advisor.sh", engine: "claude", mode: MODE.claudeSwitch, verdict: "silent" },
  { hook: "model-advisor.sh", engine: "claude", mode: MODE.claudeStop, verdict: "silent" },
  {
    hook: "model-advisor.sh",
    engine: "claude",
    mode: MODE.claudeStop,
    verdict: "advice",
    says: /Modelo recomendado/,
  },
  { hook: "model-advisor.sh", engine: "codex", mode: MODE.codexStart, verdict: "silent" },
  {
    hook: "model-advisor.sh",
    engine: "codex",
    mode: MODE.codexStart,
    verdict: "advice",
    says: /gpt-6-astra/,
  },
  { hook: "model-advisor.sh", engine: "claude", mode: ["nonsense"], verdict: "silent" },
  { hook: "model-advisor.sh", engine: "claude", mode: [], verdict: "silent" },
  // plan-gate: Claude dispatches, allowed and blocked for each reason the gate gives.
  { hook: "plan-gate.sh", engine: "claude", mode: [], verdict: "allow" },
  {
    hook: "plan-gate.sh",
    engine: "claude",
    mode: [],
    verdict: "block",
    says: /does not open with/,
  },
  { hook: "plan-gate.sh", engine: "claude", mode: [], verdict: "block", says: /no workplan at/ },
  {
    hook: "plan-gate.sh",
    engine: "claude",
    mode: [],
    verdict: "block",
    says: /not installed or not on PATH/,
  },
  // subagent-stop-handoff: Codex SubagentStop, with nothing to report and with a handoff problem,
  // and the child capture start, which only observes.
  { hook: "subagent-stop-handoff.sh", engine: "codex", mode: ["codex"], verdict: "silent" },
  {
    hook: "subagent-stop-handoff.sh",
    engine: "codex",
    mode: ["codex"],
    verdict: "note",
    says: /handoff\(s\) de subagente incompletos/,
  },
  {
    hook: "subagent-stop-handoff.sh",
    engine: "codex",
    mode: ["codex", "capture-start"],
    verdict: "silent",
  },
  // quality-gate-pre-commit: Codex and Pi, a commit or push the gate stops, and what it lets by.
  ...(["codex", "pi"] as const).flatMap((engine): Cell[] => [
    {
      hook: "quality-gate-pre-commit.sh",
      engine,
      mode: [],
      verdict: "block",
      says: /quality-gate NOT run/,
    },
    {
      hook: "quality-gate-pre-commit.sh",
      engine,
      mode: [],
      verdict: "block",
      says: /no command could be read/,
    },
    { hook: "quality-gate-pre-commit.sh", engine, mode: [], verdict: "allow" },
  ]),
];

/** Whether `c` is a case of `cell`'s class. */
function isClass(c: Case, cell: Cell): boolean {
  const { status, stdout, stderr } = c.expected.off;
  const text = `${stdout}${stderr}`;
  switch (cell.verdict) {
    case "silent":
    case "allow":
      return status === 0 && text === "";
    case "advice":
    case "note":
      return status === 0 && cell.says !== undefined && cell.says.test(stdout);
    case "block":
      return status === 2 && (cell.says === undefined || cell.says.test(text));
  }
}

const label = (cell: Cell): string =>
  `${cell.hook} ${cell.engine} [${cell.mode.join(" ")}] ${cell.verdict}${cell.says ? ` ${cell.says}` : ""}`;

describe("session hook verdict corpus (R54)", () => {
  const corpus = replay.readCorpus();

  // Covers: R54
  it("cada hook de sesión cubre cada clase de veredicto y modo por engine", () => {
    const missing = CELLS.filter(
      (cell) =>
        !corpus.some(
          (c) =>
            c.hook === cell.hook &&
            c.engine === cell.engine &&
            JSON.stringify(c.args ?? []) === JSON.stringify(cell.mode) &&
            isClass(c, cell),
        ),
    );
    expect(missing.map(label)).toEqual([]);
  });

  // Covers: R54
  it("el corpus de model-advisor tiene sus cuatro modos nativos con argumentos reales", () => {
    const cases = corpus.filter((c) => c.hook === "model-advisor.sh");
    const modes = new Set(cases.map((c) => (c.args ?? []).join(" ")));
    for (const mode of [
      "claude-session-start",
      "claude-post-model-switch",
      "claude-stop",
      "codex-session-start",
    ]) {
      expect(modes.has(mode), mode).toBe(true);
    }
    // The advice itself is part of the corpus: a message the Rust port must reproduce byte for byte.
    expect(
      cases.some((c) => c.expected.off.stdout.startsWith('{"systemMessage":"### Modelo')),
    ).toBe(true);
  });

  // Covers: R54
  it("las clases que el corpus no puede producir están declaradas, no ausentes", () => {
    // `quality-gate-pre-commit` with a cached green gate or a red one needs a rendered
    // `qualityGate.fast` and executable tool stubs; the replay runs the unrendered asset, so every
    // commit stops at "gate NOT run". Those two classes are exercised by the subprocess differential
    // tests of the native hook (0059 T7), not here.
    const gate = corpus.filter(
      (c) => c.hook === "quality-gate-pre-commit.sh" && c.engine !== "claude",
    );
    expect(
      gate.some((c) => /gate (is red|passed|failed)|cached green/.test(c.expected.off.stderr)),
    ).toBe(false);
  });
});
