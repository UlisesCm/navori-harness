import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ACTIVATION_TRIGGERS,
  type MinedSession,
  classifySearchCommand,
  flattenActivation,
  flattenSearchRouting,
  mineActivation,
  mineSearchRouting,
  shlexSplit,
} from "../signals.ts";

/**
 * Parity of the TypeScript ports with the Python miners they replace (R67).
 *
 * `scripts/py/mine-search-routing.py` and `scripts/py/mine-activation.py` were
 * run over THIS fixture tree (the first was deleted afterwards), and the figures below
 * are what they printed. The tree is plain data between the FIXTURE markers so
 * it can be re-materialized and measured with any other implementation.
 *
 * The fixture has no real command, path or repo: names are `alpha`/`beta` and
 * every command is a synthetic probe for one classification rule.
 */

// FIXTURE-BEGIN
interface FixtureFile {
  path: string;
  lines: string[];
}
interface FixtureSession {
  repo: string;
  id: string;
  cwd: string;
  hasTranscript: boolean;
}

const j = (o: unknown): string => JSON.stringify(o);
const userText = (text: string): string => j({ type: "user", message: { content: text } });
const say = (text: string): string =>
  j({ type: "assistant", message: { content: [{ type: "text", text }] } });
const use = (id: string, name: string, input: Record<string, unknown>): string =>
  j({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const bash = (id: string, command: string): string => use(id, "Bash", { command });
const result = (id: string, content: unknown, isError: boolean): string =>
  j({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }] },
  });

const SESSIONS: FixtureSession[] = [
  { repo: "alpha", id: "sess-search-main", cwd: "/fx/alpha", hasTranscript: true },
  { repo: "alpha", id: "sess-quiet", cwd: "/fx/alpha", hasTranscript: true },
  { repo: "alpha", id: "sess-rotated", cwd: "/fx/alpha", hasTranscript: false },
  { repo: "alpha", id: "sess-activation-a", cwd: "/fx/alpha", hasTranscript: true },
  { repo: "beta", id: "sess-activation-b", cwd: "/fx/beta", hasTranscript: true },
  { repo: "beta", id: "sess-search-beta", cwd: "/fx/beta", hasTranscript: true },
];

const PROJECTS = ".claude/projects";
const AUDITS = ".navori/audits";

const FIXTURE: FixtureFile[] = [
  // ── search routing, main thread of one session ──────────────────────────────
  {
    path: `${PROJECTS}/-fx-alpha/sess-search-main.jsonl`,
    lines: [
      use("g1", "Grep", { pattern: "foo" }),
      use("c1", "mcp__codegraph__codegraph_explore", { query: "how does foo work" }),
      bash("b1", "bash scripts/tgrep-search.sh foo"),
      bash("b2", "tgrep search foo src/"),
      bash("b3", "tgrep status"),
      bash("b4", 'grep -rn "foo" src/'),
      bash("b5", "rg foo"),
      bash("b6", "grep -n foo package.json"),
      bash("b7", "cat x | grep foo"),
      bash("b8", "git grep -n foo"),
      bash("b9", "git -C other grep bar"),
      bash("b10", "git status"),
      bash("b11", "ls src | xargs grep foo"),
      bash("b12", "find . -name '*.ts' -exec grep -l y {} +"),
      bash("b13", "ls && grep -rn a src/ && grep -rn b lib/"),
      bash("b14", "grep -n 'unclosed pattern file.ts"),
      bash("b15", "grep -n x file.yaml 2>/dev/null"),
      bash("b16", "grep -rn 'a' \\\n  src/"),
      bash("b17", "grep -n x file.ts > out.txt"),
      bash("b18", "egrep -n x"),
      bash("b19", "grep -n x docs/guide"),
      bash("blocked", "grep -rn blockedpat src/"),
      result("blocked", "BLOCKED by guard-search-routing: use the wrapper", true),
      // An error that is not the guard, and the guard's text without is_error:
      // neither is a block.
      bash("e1", "grep -rn other src/"),
      result("e1", "command failed", true),
      bash("e2", "grep -rn quoted src/"),
      result("e2", "the file says BLOCKED by guard-x", false),
      "{not json",
      j({
        isSidechain: true,
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "sc1", name: "Bash", input: { command: "grep -rn side src/" } },
          ],
        },
      }),
    ],
  },
  {
    path: `${PROJECTS}/-fx-alpha/sess-search-main/subagents/agent-1.jsonl`,
    lines: [
      bash("s1", "grep -rn insub src/"),
      use("s2", "mcp__codegraph__codegraph_explore", { query: "q" }),
      j({
        isSidechain: true,
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "s3", name: "Grep", input: { pattern: "z" } }],
        },
      }),
      "not json either",
    ],
  },
  {
    path: `${PROJECTS}/-fx-alpha/sess-search-main/subagents/agent-2.jsonl`,
    lines: [bash("t1", "tgrep search insub2")],
  },
  {
    path: `${PROJECTS}/-fx-alpha/sess-quiet.jsonl`,
    lines: [bash("q1", "bun lint"), bash("q2", "ls -la")],
  },
  {
    path: `${PROJECTS}/-fx-beta/sess-search-beta.jsonl`,
    lines: [
      bash("x1", "rg -n pattern ."),
      bash("x2", "grep -r x ."),
      bash("x3", "cat f | rg x | grep y"),
      use("x4", "Grep", { pattern: "w" }),
      bash("x5", "git --no-pager grep q"),
    ],
  },

  // ── activation: one scenario per trigger and per quirk ──────────────────────
  {
    path: `${PROJECTS}/-fx-alpha/sess-activation-a.jsonl`,
    lines: [
      // O1 opportunity, not taken: two source files edited on the main thread.
      userText("implementa la feature"),
      use("a1", "Edit", { file_path: "/fx/alpha/src/a.ts" }),
      use("a2", "Edit", { file_path: "/fx/alpha/src/b.ts" }),
      // Files that do not count: outside the repo, node_modules, a lone test.
      userText("limpia"),
      use("a3", "Write", { file_path: "/tmp/scratch.ts" }),
      use("a4", "Write", { file_path: "/fx/alpha/node_modules/x/index.js" }),
      use("a5", "Edit", { file_path: "/fx/alpha/src/a.test.ts" }),
      use("a6", "Edit", { file_path: "/fx/alpha/src/c.test.ts" }),
      // O1 taken through the sidechain: delegating implies the opportunity.
      userText("sigue con el implementer"),
      use("a7", "Agent", { subagent_type: "implementer", prompt: "workplan: x" }),
      // O2: closing claim with no verification, then one with the skill.
      userText("arregla el bug"),
      use("a8", "Edit", { file_path: "/fx/alpha/src/a.ts" }),
      say("todo en verde, listo"),
      userText("otra vez"),
      use("a9", "Edit", { file_path: "/fx/alpha/src/a.ts" }),
      use("a10", "Skill", { skill: "verify-before-done" }),
      say("hecho"),
      // `\b` after a checkmark needs a word character next to it: "ya ✅" does
      // NOT claim completion and "✅listo" does.
      userText("una mas"),
      use("a11", "Edit", { file_path: "/fx/alpha/src/a.ts" }),
      say("ya ✅"),
      userText("y otra"),
      use("a12", "Edit", { file_path: "/fx/alpha/src/a.ts" }),
      say("✅listo"),
      // O3: a failure that needs diagnosing, a hook block and a denial that do not.
      userText("corre el typecheck"),
      bash("d1", "bun typecheck"),
      result("d1", "error TS2322: type mismatch", true),
      userText("intenta de nuevo"),
      bash("d2", "rm -rf foo"),
      result("d2", "PreToolUse:Bash hook error: BLOCKED", true),
      bash("d3", "bun lint"),
      result("d3", "the user doesn't want to proceed", true),
      // O4: a PR opened, once taken through the retired id of the publisher.
      userText("abre el pr"),
      bash("p1", "git status && gh pr create --title x"),
      userText("abre otro pr"),
      bash("p2", "gh pr create --title y"),
      use("p3", "Agent", { subagent_type: "commit-pr-pilot", prompt: "x" }),
      // O5: source edited and committed in one turn.
      userText("commitea"),
      use("r1", "Edit", { file_path: "/fx/alpha/src/a.ts" }),
      bash("r2", "git commit -m x"),
      // O6: the same command failing twice.
      userText("prueba el build"),
      bash("l1", "cd /fx/alpha && bun run build --watch"),
      result("l1", "boom", true),
      bash("l2", "bun run build --watch"),
      result("l2", "boom", true),
      bash("l3", "ls"),
      result("l3", "x", true),
      bash("l4", "ls"),
      result("l4", "x", true),
      // Invocations: one the user named, one they did not.
      userText("usa el skill debug-error por favor"),
      use("i1", "Skill", { skill: "debug-error" }),
      use("i2", "Skill", { skill: "locate-code" }),
      // A sidechain record on the main thread is ignored.
      j({
        isSidechain: true,
        type: "user",
        message: { content: "ruido de sidechain" },
      }),
    ],
  },
  {
    path: `${PROJECTS}/-fx-beta/sess-activation-b.jsonl`,
    lines: [
      userText("construye algo"),
      use("z1", "Edit", { file_path: "/fx/beta/lib/x.py" }),
      use("z2", "Edit", { file_path: "/fx/beta/lib/y.py" }),
      use("z3", "Agent", { subagent_type: "reviewer", prompt: "r" }),
      userText("revisa"),
      use("z4", "Agent", { subagent_type: "architect", prompt: "diseña" }),
      userText("usa a reviewer"),
      use("z5", "Agent", { subagent_type: "reviewer", prompt: "r" }),
    ],
  },
];
// FIXTURE-END

/** Materializes the fixture and its audit logs under `root`. */
function materialize(root: string): void {
  const write = (rel: string, lines: string[]): void => {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");
  };
  for (const f of FIXTURE) write(f.path, f.lines);
  for (const s of SESSIONS) {
    write(`${AUDITS}/${s.repo}/session-${s.id}.log`, [
      j({ ts: "2026-09-20T10:00:00.000Z", event: "start", cwd: s.cwd, sessionId: s.id }),
    ]);
  }
}

function minedFor(root: string, repo?: string): MinedSession[] {
  return SESSIONS.filter((s) => repo === undefined || s.repo === repo).map((s) => ({
    sessionId: s.id,
    cwd: s.cwd,
    transcript: s.hasTranscript ? join(root, PROJECTS, `-fx-${s.repo}`, `${s.id}.jsonl`) : null,
  }));
}

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "navori-parity-"));
  materialize(root);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Figures printed by `mine-search-routing.py` (`scan()`, Python 3.9) over the
// fixture, per repo. Subagent transcripts are included, and `git --no-pager
// grep` is NOT counted as `git-grep`: the script reads `--no-pager` as taking
// the next token as its value. The port keeps that, because a figure that moves
// with the instrument cannot be compared against the script's baseline.
const PINNED_ROUTING_ALPHA = {
  wrapper: 1,
  nativo: 2,
  shell: 10,
  filtro: 1,
  extraccion: 4,
  "git-grep": 2,
  indirecta: 2,
  "tgrep-v2": 2,
  "codegraph-v2": 2,
  bloqueado: 1,
  malformado: 2,
  no_disponible: 1,
};
const PINNED_ROUTING_BETA = {
  nativo: 1,
  shell: 2,
  filtro: 2,
};

// Figures printed by `mine-activation.py`'s `analyze()` over the fixture, summed
// over the sessions: [opportunities, hits] per trigger, keyed by the port's id
// (the script's label for `pr-review` is "pr → review-diff/pilot").
const PINNED_ACTIVATION: Record<string, [number, number]> = {
  implementer: [4, 1],
  "verify-before-done": [3, 1],
  "debug-error": [3, 1],
  "pr-review": [2, 1],
  reviewer: [3, 2],
  "loop-back-debug": [1, 0],
};
const PINNED_AUTO: Record<string, number> = {
  architect: 1,
  "debug-failure": 1,
  "locate-code": 1,
  publisher: 1,
  reviewer: 1,
  "verify-before-done": 1,
};
const PINNED_ASKED: Record<string, number> = { implementer: 1, reviewer: 1 };

describe("search routing: parity with mine-search-routing.py", () => {
  // Covers: R67
  it("reproduces the script's counts for each repo", () => {
    const alpha = mineSearchRouting(minedFor(root, "alpha"));
    const beta = mineSearchRouting(minedFor(root, "beta"));
    expect(alpha).toEqual(PINNED_ROUTING_ALPHA);
    expect(beta).toEqual(PINNED_ROUTING_BETA);
  });

  // Covers: R67
  it("publishes the quotients with the script's denominators", () => {
    const m = flattenSearchRouting(mineSearchRouting(minedFor(root)));
    const c = (k: string): number => (PINNED_ROUTING_ALPHA as Record<string, number>)[k] ?? 0;
    const b = (k: string): number => (PINNED_ROUTING_BETA as Record<string, number>)[k] ?? 0;
    const good = c("wrapper") + c("nativo") + b("wrapper") + b("nativo");
    const scored = good + c("shell") + b("shell");
    expect(m["search.good.pct"]).toBe(Math.round((1000 * good) / scored) / 10);
    // Filters and extractions stay out of the quotient.
    expect(m["search.filtro"]).toBe(c("filtro") + b("filtro"));
    const v2 = c("tgrep-v2") + c("codegraph-v2");
    const escape =
      c("nativo") + c("shell") + c("git-grep") + b("nativo") + b("shell") + b("git-grep");
    expect(m["search.v2.pct"]).toBe(Math.round((1000 * v2) / (v2 + escape)) / 10);
  });
});

describe("search routing: classification rules", () => {
  // Covers: R67
  it("counts per segment and keeps a pipe from being a search", () => {
    expect(classifySearchCommand("ls && grep -rn a src/ && grep -rn b lib/")).toEqual({ shell: 2 });
    expect(classifySearchCommand("cat x | grep foo")).toEqual({ filtro: 1 });
    expect(classifySearchCommand("cat x | head && grep foo file.ts")).toEqual({ extraccion: 1 });
  });

  // Covers: R67
  it("does not read a redirection as a directory target", () => {
    expect(classifySearchCommand("grep -n x file.yaml 2>/dev/null")).toEqual({ extraccion: 1 });
    expect(classifySearchCommand("grep -n x file.ts > out.txt")).toEqual({ extraccion: 1 });
  });

  // Covers: R67
  it("falls back to a whitespace split on unbalanced quotes instead of dropping the segment", () => {
    expect(classifySearchCommand("grep -n 'unclosed pattern file.ts")).toEqual({ extraccion: 1 });
  });

  // Covers: R67
  it("splits like Python's shlex", () => {
    expect(shlexSplit(`a "b c" 'd e' f\\ g h"i j"k`)).toEqual(["a", "b c", "d e", "f g", "hi jk"]);
    expect(shlexSplit(`"a\\"b" "c\\d"`)).toEqual(['a"b', "c\\d"]);
    expect(() => shlexSplit("a 'b")).toThrow();
    expect(() => shlexSplit("a \\")).toThrow();
  });
});

describe("activation: parity with mine-activation.py", () => {
  // Covers: R67
  it("reproduces the script's opportunities and hits per trigger", () => {
    const stats = mineActivation(minedFor(root));
    for (const { id } of ACTIVATION_TRIGGERS) {
      const [opp, hit] = PINNED_ACTIVATION[id] ?? [-1, -1];
      expect([stats.opp[id] ?? 0, stats.hit[id] ?? 0], id).toEqual([opp, hit]);
    }
    expect(stats.auto).toEqual(PINNED_AUTO);
    expect(stats.asked).toEqual(PINNED_ASKED);
  });

  // Covers: R67
  it("counts a session whose transcript rotated as unavailable, not as zero", () => {
    const stats = mineActivation(minedFor(root, "alpha"));
    expect(stats.unavailable).toBe(1);
    expect(flattenActivation(stats)["activation.sessions.unavailable"]).toBe(1);
  });
});
