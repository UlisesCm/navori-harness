import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { getCoreRoot } from "../bundled-assets.ts";

/**
 * Coherence guard (#409): `.claude/progress/` is declared as a CLOSED set in two
 * canonical lists, and the harness kept producing artifacts outside it.
 *
 *   - `managed/orquestacion.md` — "That folder is ONLY for ephemeral agent
 *     handoffs (`audit_*`, `plan_*`, ...)"
 *   - `agents/leader.md` — the "Expected files:" inventory
 *
 * A namespace that no list declares (`solution_*` was the live case) is, for a
 * strict orchestrator, an out-of-contract file: ignored when synthesizing at
 * best, deleted as a "scratch file" at session closeout at worst — destroying
 * the very artifact the implementer is ORDERED to read.
 *
 * The punctual fix repairs one instance; this test is the mechanism: any future
 * skill or agent that invents a namespace breaks the suite until it registers it
 * in BOTH lists.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE EXTRACTION COVERS — and what it does not.
 *
 * The assets name their artifacts in more than one shape, so three forms are
 * recognized (see the regexes below):
 *   1. canonical full path — `.claude/progress/solution_<scope>.md`
 *   2. glob under the path — `.claude/progress/audit_deep_*.md`
 *   3. bare filename in backticks — `impl_<feature>.md`, `review_*.md`
 *   4. literal file under the path with no placeholder — `.claude/progress/receipt.txt`
 *
 * Deliberately NOT covered (a namespace mentioned ONLY this way slips through):
 *   - a bare filename with neither backticks nor the folder prefix, e.g. inside
 *     a fenced block: `done -> .claude/progress/audit_deep_<scope>.md (+ plan_<scope>.md)`
 *     in `agents/auditor.md` — the `plan_<scope>.md` there is invisible here.
 *     Harmless today (every live namespace also appears in a covered form), but
 *     it is a real hole, not an oversight.
 *   - extensions other than `.md` / `.txt` in the literal form.
 *   - artifacts described in prose with no filename ("the reviewer's receipt").
 *   - namespaces outside the folder's lowercase snake_case convention.
 *   - producers outside `skills/` and `agents/` (a future `managed/` block that
 *     invents an artifact would not be seen).
 * ---------------------------------------------------------------------------
 */

const CORE_ASSETS = resolve(getCoreRoot(), "core-assets");
const ORQUESTACION = "managed/orquestacion.md";
const LEADER = "agents/leader.md";
/** Asset directories that PRODUCE handoffs (the declaring side is parsed apart). */
const PRODUCER_DIRS = ["skills", "agents"] as const;

/**
 * Form 1+2 — full path with a placeholder or a glob.
 * The namespace capture is greedy across underscores on purpose:
 * `audit_ticket_<ID>.md` yields `audit_ticket`, not `audit`.
 */
const PATH_FORM = /\.claude\/progress\/([a-z][a-z0-9]*(?:_[a-z0-9]+)*)_(?:<[^>\n]+>|\*)\.md/g;
/** Form 3 — bare filename delimited by backticks (inline code). */
const BARE_FORM = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)*)_(?:<[^>`\n]+>|\*)\.md`/g;
/** Form 4 — literal file with no placeholder; the whole filename IS the namespace. */
const LITERAL_FORM = /\.claude\/progress\/([a-z][a-z0-9_]*\.(?:md|txt))\b/g;

const read = (rel: string): string => readFileSync(resolve(CORE_ASSETS, rel), "utf-8");

/** Every handoff namespace named in `text`, in any of the four recognized forms. */
function extractNamespaces(text: string): string[] {
  const found: string[] = [];
  for (const re of [PATH_FORM, BARE_FORM, LITERAL_FORM]) {
    for (const m of text.matchAll(re)) found.push(m[1]);
  }
  return found;
}

/** namespace -> the assets that name it (provenance for the failure message). */
function producedNamespaces(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const dir of PRODUCER_DIRS) {
    for (const file of readdirSync(resolve(CORE_ASSETS, dir))) {
      if (!file.endsWith(".md")) continue;
      const rel = `${dir}/${file}`;
      for (const ns of extractNamespaces(read(rel))) {
        const producers = out.get(ns) ?? new Set<string>();
        producers.add(rel);
        out.set(ns, producers);
      }
    }
  }
  return out;
}

/**
 * The `orquestacion.md` list: a parenthetical of backticked globs.
 * Throws if the anchor moved — a reworded asset must fail loudly, never turn
 * this test vacuous.
 */
function declaredInOrquestacion(): Set<string> {
  const m = read(ORQUESTACION).match(/ONLY for ephemeral agent handoffs \(([^)]+)\)/);
  if (!m) {
    throw new Error(
      `could not find the handoff list in ${ORQUESTACION} (anchor: "ONLY for ephemeral agent handoffs (...)"). ` +
        "If the wording changed, update this test's anchor — do not delete the list.",
    );
  }
  const out = new Set<string>();
  for (const [, token] of m[1].matchAll(/`([^`]+)`/g)) {
    const glob = token.match(/^([a-z][a-z0-9_]*)_\*$/);
    if (glob) out.add(glob[1]);
    else if (/^[a-z][a-z0-9_]*\.(?:md|txt)$/.test(token)) out.add(token);
  }
  return out;
}

/** The `leader.md` "Expected files:" bullet list, parsed with the same extractor. */
function declaredInLeader(): Set<string> {
  const text = read(LEADER);
  const start = text.indexOf("Expected files:");
  if (start === -1) {
    throw new Error(
      `could not find the "Expected files:" inventory in ${LEADER}. ` +
        "If the wording changed, update this test's anchor — do not delete the list.",
    );
  }
  const bullets: string[] = [];
  for (const line of text.slice(start).split("\n").slice(1)) {
    if (line.trim() === "") {
      if (bullets.length > 0) break;
      continue;
    }
    if (!line.startsWith("- ")) break;
    bullets.push(line);
  }
  return new Set(extractNamespaces(bullets.join("\n")));
}

/**
 * A declared namespace covers itself and its sub-namespaces: `audit_*` in
 * orquestacion.md covers the `audit_ticket_*` / `audit_deep_*` that the agents
 * actually write. A literal (`receipt.txt`) covers only itself.
 */
function isCovered(produced: string, declared: Set<string>): boolean {
  if (declared.has(produced)) return true;
  for (const d of declared) {
    if (produced.startsWith(`${d}_`)) return true;
  }
  return false;
}

const PRODUCERS = producedNamespaces();

/** Failure text that names the prefix, who produces it, and the line to add. */
function report(missing: string[], where: string, howTo: string): string {
  const detail = missing
    .map((ns) => `\`${ns}_*\` (produced by ${[...(PRODUCERS.get(ns) ?? [])].sort().join(", ")})`)
    .join("; ");
  return (
    `undeclared handoff namespace(s): ${detail}. ` +
    `${where} declares .claude/progress/ as "ONLY for" a closed set, so an artifact outside it ` +
    "is treated as a stray scratch file (ignored when synthesizing, or deleted at session closeout). " +
    `Fix in ${where}: ${howTo}`
  );
}

describe("handoff namespaces — producers vs. the canonical lists (#409)", () => {
  const orquestacion = declaredInOrquestacion();
  const leader = declaredInLeader();

  it("both canonical lists parse into a real inventory", () => {
    // Anti-vacuity: if a refactor silently emptied either list, every coherence
    // assertion below would pass by accident.
    for (const [where, declared] of [
      [ORQUESTACION, orquestacion],
      [LEADER, leader],
    ] as const) {
      expect(
        [...declared].sort(),
        `the handoff list in ${where} parsed as near-empty — the test would pass vacuously`,
      ).toEqual(expect.arrayContaining(["impl", "review", "receipt.txt"]));
    }
    expect(
      [...PRODUCERS.keys()].sort(),
      "no handoff namespace was extracted from skills/ + agents/ — the regexes stopped matching",
    ).toEqual(expect.arrayContaining(["impl", "review", "receipt.txt"]));
  });

  it("every namespace produced by a skill or agent is declared in orquestacion.md", () => {
    const missing = [...PRODUCERS.keys()].filter((ns) => !isCovered(ns, orquestacion)).sort();
    expect(
      missing,
      report(
        missing,
        ORQUESTACION,
        'add the glob to the "ONLY for ephemeral agent handoffs (...)" parenthetical.',
      ),
    ).toEqual([]);
  });

  it("every namespace produced by a skill or agent is declared in leader.md", () => {
    const missing = [...PRODUCERS.keys()].filter((ns) => !isCovered(ns, leader)).sort();
    expect(
      missing,
      report(
        missing,
        LEADER,
        'add a bullet `- `.claude/progress/<namespace>_<placeholder>.md` — <what writes it>` to the "Expected files:" list.',
      ),
    ).toEqual([]);
  });

  it("solution_* is in both lists — the instance that motivated the guard", () => {
    for (const [where, declared] of [
      [ORQUESTACION, orquestacion],
      [LEADER, leader],
    ] as const) {
      expect(isCovered("solution", declared), `solution_* missing from ${where}`).toBe(true);
      expect(
        isCovered("solution_review", declared),
        `solution_review_* missing from ${where}`,
      ).toBe(true);
    }
  });
});
