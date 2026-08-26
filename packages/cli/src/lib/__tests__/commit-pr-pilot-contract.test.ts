import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The prose contract of `commit-pr-pilot.md` — the agent that decides whether a
 * diff reaches `{{prTarget}}` reviewed or not. These assets are instructions an
 * agent OBEYS, so an ambiguous or missing sentence is a defect exactly like a
 * missing branch in code, and the only executable check available is over the
 * text itself.
 *
 * Three issues, all found by a blind audit and none of them visible to the
 * existing suite (which covered the shell snippets and the settings, never the
 * flow's prose):
 *
 *  - **#499** — no asset in the whole harness ordered `git push`. The pilot went
 *    from `git commit` straight to `gh pr create`, which on a branch with no
 *    upstream opens an interactive prompt the agent cannot answer: the turn
 *    hangs and no URL is produced. The same agent then CHECKED that the branch
 *    was pushed (`must NOT say [ahead N]`) to decide whether a worktree was safe
 *    to remove — a precondition it never received the order to satisfy.
 *  - **#502.1** — "no PR if a review says `CHANGES_REQUESTED`" used a broad
 *    `review_*.md` glob while, 18 lines below, the same file declared that glob
 *    invalid for `APPROVED`. With 15 old reviews in `.claude/progress/`, the lax
 *    rule was the one applied to what BLOCKS and the strict one to what allows.
 *  - **#502.2** — the gate paragraph annotated `{{qualityGate.full}}` as
 *    "(lint + tests)" and `{{qualityGate.fast}}` as "(typecheck)". Those labels
 *    were hand-written around the placeholders, so they described a hypothetical
 *    default project; in this repo the values are the other way round and the
 *    sentence told the agent that a pure `oxlint` run covered typecheck.
 *  - **#502.3** — the R1 waiver (the single definition of "may this ship without
 *    a reviewer?") carried two criteria in one sentence, "1–3 files" and "2+
 *    non-trivial files", and never defined "non-trivial". A 2-file diff
 *    satisfied both at once.
 *  - **#502.3 (round 2)** — the definition landed but was not yet operable, in
 *    two ways. It was COUNTED over `git diff --name-only origin/…...HEAD`:
 *    three-dot, which sees only committed changes, while the pilot's trigger is
 *    by construction an uncommitted tree — the listing read empty, the count
 *    read zero, and "at most one" granted the waiver on every diff. And the
 *    definition never said how a TEST file counts, so the same 2-file bugfix
 *    (source + its test) came out 1 or 2 depending on the reader.
 *  - **#507.5** — `{{branchBase}}` and `{{prTarget}}` interpolated on the same
 *    line. They resolve to the same branch in almost every repo, so the render
 *    shipped "`main` is the fork point; `main` is the target", "cannot be main
 *    or main", and a `git rev-list --count origin/main..origin/main` guarded by
 *    "only if `main` ≠ `main`" — a command that returns 0 by construction under
 *    a condition that is never true.
 *
 * WHAT IT READS — `packages/core/core-assets`, the SOURCE templates, not
 * `getCoreRoot()`. That helper resolves to `dist/assets/core` once the CLI has
 * been built, and that copy is refreshed by the build: reading it would let a
 * stale `dist/` answer these questions about yesterday's bytes. The rendered
 * mirror is covered elsewhere (`asset-command-permissions.test.ts`).
 */

const HERE = resolve(fileURLToPath(import.meta.url), "..");
// packages/cli/src/lib/__tests__ → repo root is five levels up.
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");
const CORE_ASSETS = join(REPO_ROOT, "packages", "core", "core-assets");
const PLUGINS = join(REPO_ROOT, "packages", "plugins");
const PILOT = join(CORE_ASSETS, "agents", "commit-pr-pilot.md");

const pilot = readFileSync(PILOT, "utf-8");

/**
 * The slice of the pilot that starts at `marker` and ends at the next match of
 * `until`. Fails loudly when the marker is gone: a region that silently comes
 * back empty turns every check below into a test that cannot fail.
 */
function region(marker: string, until: RegExp): string {
  const at = pilot.indexOf(marker);
  expect(at, `anchor "${marker}" is gone from commit-pr-pilot.md`).toBeGreaterThan(-1);
  const rest = pilot.slice(at);
  const end = rest.slice(marker.length).search(until);
  return end < 0 ? rest : rest.slice(0, marker.length + end);
}

// Everything the pilot does BEFORE `## Commit flow` — i.e. while the tree is
// still uncommitted. `/^## /m` does not match the `### ` sub-headings inside it.
const PRE_FLIGHT = region("## Mandatory pre-flight", /^## /m);
const PR_FLOW = region("## PR flow", /^## /m);
const WORKTREE = region("## Worktree left behind", /^## /m);
const R1_WAIVER = region("**R1 exception (no reviewer):**", /^#{3} /m);

describe("commit-pr-pilot — the PR flow publishes the branch (#499)", () => {
  // ---- anti-false-green ---------------------------------------------------
  it("reads the flow it claims to read", () => {
    expect(PR_FLOW.length, "the PR flow section came back empty").toBeGreaterThan(500);
    expect(PR_FLOW, "the anchor no longer covers the `gh` call").toContain("gh pr create");
    expect(WORKTREE).toContain("[ahead N]");
  });

  // ---- the contract -------------------------------------------------------
  it("orders the push explicitly, as a step of its own", () => {
    expect(
      PR_FLOW,
      "no `git push` in the PR flow: `gh pr create` would prompt for where to push the branch and the turn hangs with no URL (#499)",
    ).toMatch(/^\s*git push -u origin HEAD$/m);
  });

  it("pushes BEFORE firing `gh pr create` — a PR shows what the remote has", () => {
    // Against the INVOCATION (the fenced `gh pr create \` line), not the first
    // prose mention of it: step 4 names the command while explaining why the
    // push has to precede it.
    const invocation = PR_FLOW.search(/^\s*gh pr create \\$/m);
    expect(
      invocation,
      "the `gh pr create` invocation is no longer a fenced command",
    ).toBeGreaterThan(-1);
    const push = PR_FLOW.indexOf("git push -u origin HEAD");
    expect(push, "the push is not in the PR flow at all").toBeGreaterThan(-1);
    expect(push).toBeLessThan(invocation);
  });

  it("numbers the push as step 4, which the worktree verdict cites", () => {
    // The two halves of #499's irony: the verdict reads `[ahead N]`, which is
    // true by construction until the push happens. Keeping the cross-reference
    // exact is the point — a renumbering that breaks it must fail here.
    expect(PR_FLOW).toMatch(/^4\. \*\*Publish the branch\*\*/m);
    expect(
      WORKTREE,
      "the worktree verdict must say it runs after the push step, or it reports NOT safe on every cycle",
    ).toContain("step 4");
  });
});

describe("commit-pr-pilot — one review, chosen by name (#502.1)", () => {
  /** Every mention of the broad glob, with its line number. */
  const globLines = pilot
    .split("\n")
    .map((line, i) => ({ line, at: i + 1 }))
    .filter(({ line }) => line.includes("review_*"));

  it("still talks about reviews by feature — the anchor is alive", () => {
    const named = pilot.match(/review_<feature>\.md/g) ?? [];
    expect(named.length, "the agent no longer names the per-feature review").toBeGreaterThanOrEqual(
      3,
    );
    expect(globLines.length, "the broad glob is no longer discussed at all").toBeGreaterThan(0);
  });

  it("mentions the broad glob only to forbid it", () => {
    const prescribing = globLines
      .filter(({ line }) => !line.includes("not valid"))
      .map(({ line, at }) => `  :${at}  ${line.trim()}`);
    expect(
      prescribing,
      [
        "",
        "  These lines use the broad `review_*` glob as a RULE.",
        "  With 15 review files in .claude/progress/, a CHANGES_REQUESTED from",
        "  someone else's closed cycle would abort this feature's PR — while the",
        "  same file declares the glob invalid for APPROVED (#502.1).",
        "  Name the file instead: `.claude/progress/review_<feature>.md`.",
        "",
        prescribing.join("\n"),
        "",
      ].join("\n"),
    ).toEqual([]);
  });
});

/**
 * A hand-written annotation stuck to a `{{qualityGate.*}}` placeholder: a
 * parenthesis right before or right after it whose text names a gate step. That
 * is the root cause of #502.2 — the placeholder's VALUE comes from the project's
 * config, so any description written next to it is a guess about a project the
 * template will never see.
 *
 * Deliberately narrow: a parenthesis that does NOT name a step is ordinary prose
 * ("(green over the shipping diff)") and stays legal. The boundary is declared,
 * not accidental — a proximity rule instead of an adjacency one flagged
 * legitimate lines that offer a preset's own gate as an alternative.
 */
const GATE_PLACEHOLDER = /\{\{\s*qualityGate\.(?:full|fast)\s*\}\}/g;
const GATE_STEP =
  /\b(lint|typecheck|type-check|tests?|build|format|tsc|oxlint|biome|vitest|jest)\b/i;

function handWrittenLabels(line: string): string[] {
  const labels: string[] = [];
  GATE_PLACEHOLDER.lastIndex = 0;
  let hit: RegExpExecArray | null = GATE_PLACEHOLDER.exec(line);
  while (hit !== null) {
    const after = line.slice(hit.index + hit[0].length).match(/^`?\s*\(([^()]*)\)/);
    const before = line.slice(0, hit.index).match(/\(([^()]*)\)\s*`?\s*$/);
    for (const group of [before, after]) {
      const text = group?.[1];
      if (text !== undefined && GATE_STEP.test(text)) labels.push(text);
    }
    hit = GATE_PLACEHOLDER.exec(line);
  }
  return labels;
}

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) markdownFiles(abs, out);
    else if (entry.endsWith(".md")) out.push(abs);
  }
  return out;
}

describe("templates never hand-write what the quality gate runs (#502.2)", () => {
  const files = [...markdownFiles(CORE_ASSETS), ...markdownFiles(PLUGINS)];

  // ---- anti-false-green ---------------------------------------------------
  it("scans the templates and finds the placeholders it judges", () => {
    expect(files.length, "the template walk found almost nothing").toBeGreaterThan(50);
    const withPlaceholder = files.filter((f) => {
      GATE_PLACEHOLDER.lastIndex = 0;
      return GATE_PLACEHOLDER.test(readFileSync(f, "utf-8"));
    });
    expect(
      withPlaceholder.length,
      "no template cites the gate — the scan is broken",
    ).toBeGreaterThan(20);
  });

  it("detects the exact sentence that shipped", () => {
    // The line as it stood before the fix. If the detector stops flagging it,
    // the verdict below is worthless.
    expect(
      handWrittenLabels(
        "The PR gate is `{{qualityGate.full}}` (lint + tests) — **not** just `{{qualityGate.fast}}` (typecheck).",
      ),
    ).toEqual(["lint + tests", "typecheck"]);
    // …and ordinary prose in a parenthesis is NOT a label.
    expect(
      handWrittenLabels("The pilot gates the PR on `{{qualityGate.full}}` (green over the diff)."),
    ).toEqual([]);
  });

  // ---- the cross-check ----------------------------------------------------
  it("no template annotates a gate placeholder with the steps it supposedly runs", () => {
    const violations: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf-8")
        .split("\n")
        .forEach((line, i) => {
          for (const label of handWrittenLabels(line)) {
            violations.push(`  ${file.slice(REPO_ROOT.length + 1)}:${i + 1}  "(${label})"`);
          }
        });
    }
    expect(
      violations,
      [
        "",
        "  A label written by hand next to a {{qualityGate.*}} placeholder.",
        "  What each gate runs comes from the project's navori.config.json, so the",
        "  annotation is only true for whichever project the author had in mind:",
        "  this repo's `fast` is `pnpm lint` and it shipped annotated `(typecheck)`,",
        "  telling the agent a pure lint run covered typechecking (#502.2).",
        "  Delete the parenthesis — do not swap which one says which.",
        "",
        violations.join("\n"),
        "",
      ].join("\n"),
    ).toEqual([]);
  });
});

/**
 * A three-dot listing of the PR target, i.e. `origin/{{prTarget}}...`. Matched
 * on the ref expression, never on the prose: the pre-flight now WARNS about
 * `...HEAD` in two paragraphs, and a rule that banned the four characters
 * anywhere would forbid the asset from explaining its own trap.
 */
const THREE_DOT_TARGET = /origin\/\{\{\s*prTarget\s*\}\}\.\.\./;

describe("commit-pr-pilot — the pre-flight measures the tree it was triggered by", () => {
  // ---- anti-false-green ---------------------------------------------------
  it("reads the pre-flight, and it carries the set definition", () => {
    expect(PRE_FLIGHT.length, "the pre-flight section came back empty").toBeGreaterThan(1000);
    expect(PRE_FLIGHT, "the anchor no longer covers the receipt check").toContain("receipt.txt");
    expect(PRE_FLIGHT, "the anchor no longer covers the R1 waiver").toContain("R1 exception");
  });

  it("the three-dot detector matches the ref expression, not the prose", () => {
    // The line as it shipped: the count that gates the waiver.
    expect(
      THREE_DOT_TARGET.test(
        "Count the non-trivial files in `git diff --name-only origin/{{prTarget}}...HEAD`:",
      ),
    ).toBe(true);
    // The two-dot form that replaced it, and the prose that warns about the trap.
    expect(THREE_DOT_TARGET.test('git diff --name-only "origin/{{prTarget}}"')).toBe(false);
    expect(THREE_DOT_TARGET.test("Two dots, plus the untracked files — NEVER `...HEAD`.")).toBe(
      false,
    );
  });

  // ---- the contract -------------------------------------------------------
  it("takes no listing from `...HEAD` before the commit exists", () => {
    const offenders = PRE_FLIGHT.split("\n")
      .map((line, i) => ({ line: line.trim(), at: i }))
      .filter(({ line }) => THREE_DOT_TARGET.test(line))
      .map(({ line }) => `  ${line}`);
    expect(
      offenders,
      [
        "",
        "  A three-dot listing inside the pre-flight, which runs BEFORE the commit.",
        "  `origin/<target>...HEAD` shows only what is already committed, and the",
        "  pilot's trigger IS the uncommitted tree (it owns that commit). So the",
        "  listing comes back empty: the receipt coverage check finds no gap and",
        "  the R1 waiver's count reads zero — 'at most one' is then true for every",
        "  diff and the waiver is granted always. It fails towards shipping",
        "  unreviewed. Use two-dot + `git ls-files --others`, the set the reviewer",
        "  signed. (`## PR flow` runs after the commit and keeps three-dot.)",
        "",
        offenders.join("\n"),
        "",
      ].join("\n"),
    ).toEqual([]);
  });

  it("defines that set ONCE and has both consumers read the same name", () => {
    // Two spellings of one set is how :63 and :109 drifted apart in the first
    // place: the receipt check was two-dot + untracked, the waiver was
    // three-dot, and neither sentence knew about the other.
    const definitions = [...PRE_FLIGHT.matchAll(/ls-files --others --exclude-standard/g)];
    expect(
      definitions.length,
      "the shipping-diff listing is spelled out more than once in the pre-flight — name it once and reference it, or the two copies drift",
    ).toBe(1);
    expect(PRE_FLIGHT, "the set has no name to reference").toContain("shipping diff");
  });

  it("the waiver counts that named set instead of rolling its own listing", () => {
    expect(
      R1_WAIVER,
      "the waiver must point at the shipping diff defined in the pre-flight, not describe a listing of its own",
    ).toContain("shipping diff");
    expect(
      R1_WAIVER.includes("--name-only"),
      "the waiver spells out a listing command again — that is the duplication that drifted",
    ).toBe(false);
  });
});

/**
 * #507.5. `branchBase` (the fork point) and `prTarget` (the PR's target) are two
 * config keys whose values coincide in almost every repo — `prTarget` even falls
 * back to `branchBase` when unset. So a template line that interpolates BOTH
 * renders a sentence comparing a literal with itself: "`main` is the fork point;
 * `main` is the target", "cannot be main or main", "only if `main` ≠ `main`".
 * The reader is an agent, and prose that degenerates that way is either ignored
 * or obeyed literally; the worst case shipped a `git rev-list --count
 * origin/main..origin/main` under a condition that is never true.
 *
 * The rule is per LINE, because that is the unit a reader sees rendered. Naming
 * one of the two and describing the other in prose ("the branch this one was
 * forked from") always works, and where the two values genuinely have to meet —
 * the commit-drag check — the comparison belongs to the shell at runtime, on
 * lines of its own, not to an assertion made at render time.
 *
 * Markdown only: in a `.sh` hook these land in separate variable assignments and
 * the comparison is real code, never a rendered sentence.
 */
const BRANCH_BASE_PLACEHOLDER = /\{\{\s*(?:shq:)?\s*branchBase\s*\}\}/;
const PR_TARGET_PLACEHOLDER = /\{\{\s*(?:shq:)?\s*prTarget\s*\}\}/;

function rendersBothBranches(line: string): boolean {
  return BRANCH_BASE_PLACEHOLDER.test(line) && PR_TARGET_PLACEHOLDER.test(line);
}

describe("no template line renders the fork point and the PR target together (#507.5)", () => {
  const files = [...markdownFiles(CORE_ASSETS), ...markdownFiles(PLUGINS)];

  // ---- anti-false-green ---------------------------------------------------
  it("flags the lines that shipped and clears the ones that replaced them", () => {
    expect(
      rendersBothBranches(
        "- You are on `{{branchBase}}` or `{{prTarget}}` or another protected branch → abort.",
      ),
    ).toBe(true);
    expect(
      rendersBothBranches("`git rev-list --count origin/{{prTarget}}..origin/{{branchBase}}`"),
    ).toBe(true);
    // One placeholder per line is the whole point — both of these are legal.
    expect(rendersBothBranches("base={{branchBase}}   # the fork point")).toBe(false);
    expect(rendersBothBranches('if [ "$base" != "{{prTarget}}" ]; then')).toBe(false);
    expect(rendersBothBranches("base={{shq:branchBase}} and nothing else")).toBe(false);
  });

  it("scans templates that actually use these placeholders", () => {
    const users = files.filter((f) => {
      const body = readFileSync(f, "utf-8");
      return BRANCH_BASE_PLACEHOLDER.test(body) || PR_TARGET_PLACEHOLDER.test(body);
    });
    expect(users.length, "no template cites either branch — the scan is broken").toBeGreaterThan(3);
  });

  // ---- the contract -------------------------------------------------------
  it("never puts both on one line", () => {
    const violations: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf-8")
        .split("\n")
        .forEach((line, i) => {
          if (rendersBothBranches(line)) {
            violations.push(`  ${file.slice(REPO_ROOT.length + 1)}:${i + 1}  ${line.trim()}`);
          }
        });
    }
    expect(
      violations,
      [
        "",
        "  A line that interpolates the fork point AND the PR target.",
        "  prTarget falls back to branchBase, so in almost every repo both render",
        "  the SAME literal and the sentence degenerates: `main` is the fork",
        "  point and `main` is the target, `# cannot be main or main`, and",
        "  `only if main ≠ main` guarding `origin/main..origin/main` (#507.5).",
        "  Name one and describe the other in prose; where the two values must",
        "  really be compared, let the shell do it at runtime, on its own lines.",
        "",
        violations.join("\n"),
        "",
      ].join("\n"),
    ).toEqual([]);
  });
});

describe("commit-pr-pilot — `non-trivial` is defined where it decides (#502.3)", () => {
  /** What a non-trivial file is NOT: the definition-by-contrast vocabulary. */
  const EXCLUSIONS = ["config", "fixture", "lockfile", "copy", "docs", "generated", "scaffolding"];

  // ---- anti-false-green ---------------------------------------------------
  it("reads the waiver that uses the term", () => {
    expect(R1_WAIVER.length, "the R1 exception region came back empty").toBeGreaterThan(600);
    expect(R1_WAIVER).toContain("waiver");
    expect(R1_WAIVER, "the term is not even used here any more").toContain("non-trivial");
  });

  // ---- the contract -------------------------------------------------------
  it("marks the term as defined here, not borrowed from elsewhere", () => {
    // `CLAUDE.md` points AT this paragraph ("as defined once by the
    // commit-pr-pilot's R1 exception"), so if the definiendum is not here it
    // exists nowhere.
    expect(
      R1_WAIVER,
      "`non-trivial` decides whether a diff ships unreviewed and no asset defines it (#502.3)",
    ).toMatch(/\*\*non-trivial\*\*/);
  });

  it("defines it by contrast — names what does not count", () => {
    const named = EXCLUSIONS.filter((word) => R1_WAIVER.includes(word));
    expect(
      named.length,
      `a definition needs its counter-examples; the waiver names only: ${named.join(", ") || "none"}`,
    ).toBeGreaterThanOrEqual(3);
  });

  /**
   * The two forks the definition left open, each phrased as the question a
   * reader has to answer before it can count anything. Both were measured on
   * real commits of this repo: `9ae6eee` (source + its test) and `18f945e`
   * (three sources whose hardcoded literal became an import) came out with a
   * different number depending on which way the reader leaned — and both of
   * them are the 2-file shape, i.e. exactly where the count decides something.
   */
  const OPEN_QUESTIONS: ReadonlyArray<{ question: string; answered: RegExp }> = [
    {
      question:
        "does a test file count? (this repo asks for a test with every fix, so if it does, every bugfix counts two and the waiver is dead)",
      answered: /\btests?\b/i,
    },
    {
      question:
        "is replacing a hardcoded literal with an import mechanical, or a behavior change? ('an import path' as a bare example reads both ways)",
      answered: /where a value comes from/i,
    },
  ];

  it("answers the questions a reader must settle before counting", () => {
    const unanswered = OPEN_QUESTIONS.filter((q) => !q.answered.test(R1_WAIVER)).map(
      (q) => `  - ${q.question}`,
    );
    expect(
      unanswered,
      [
        "",
        "  The waiver leaves a classification question open. Two agents reading",
        "  the same diff then get different counts, and the count is what decides",
        "  whether a change ships unreviewed — which is #502.3 again, with more",
        "  words. Answer it in the definition, not in the reader's head:",
        "",
        unanswered.join("\n"),
        "",
      ].join("\n"),
    ).toEqual([]);
  });

  it("shows the count worked through, not just stated", () => {
    // A rule this repo's own history bifurcates on needs the 2-file case
    // resolved out loud; the abstract clause is what produced two readings.
    expect(
      R1_WAIVER,
      "the waiver states the criterion but never applies it to a concrete diff — the source+test shape is the one that decides",
    ).toMatch(/worked example/i);
  });

  it("leaves ONE operative criterion — no bare file count competing with it", () => {
    // "1–3 files" and "4+ files" are the two shapes that made a 2-file diff
    // satisfy R1 and R2 at the same time. A count qualified as "non-trivial" is
    // the criterion itself and stays legal.
    const bare = [...R1_WAIVER.matchAll(/(?:\d+\s*[–-]\s*\d+|\d+\s*\+)\s+files?\b/g)].map(
      (m) => m[0],
    );
    expect(
      bare,
      `a second, unqualified file-count threshold is back in the waiver: ${bare.join(", ")}. Two criteria in one sentence is what #502.3 was.`,
    ).toEqual([]);
  });
});
