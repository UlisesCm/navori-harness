import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getCoreRoot, getPluginAssetsRoot } from "../bundled-assets.ts";
import { buildClaudeSettings } from "../../engines/claude/build-settings.ts";
import type { NavoriConfig } from "../config.ts";

/**
 * Prose that describes a hook, cross-checked against the hook's own script.
 *
 * The defect this exists for: four assets stated that "a `SubagentStop` hook
 * verifies they landed", and `subagent-stop-handoff.sh` cannot do that — it
 * iterates `impl_*.md` / `review_*.md` globs, which by construction only ever
 * yield files that are already there, and it has no existence test at all. A
 * missing handoff is invisible to it. Same class as #502.2 (a false claim about
 * what a mechanism verifies), inside an asset an agent OBEYS: an agent that
 * believes a net exists stops doing the check itself, and a subagent that
 * verifies the claim finds the harness exaggerating — the authority erosion
 * #501 calls the worst second-order effect.
 *
 * WHAT THIS DOES NOT DO: it does not pin the current wording. Freezing the
 * sentence would catch a rewrite and miss the next false claim, which is the
 * failure mode being repeated. It checks NECESSARY CONDITIONS instead — a
 * capability a script provably lacks cannot be attributed to it:
 *
 *   - a hook that "blocks" must have a way to block: `exit 2` (evaluated before
 *     permission rules in PreToolUse) or a `decision: block` payload;
 *   - a hook that "verifies a file landed / exists" must test a path for
 *     existence somewhere. Walking a glob is not a verification: the shell
 *     hands it only what already exists.
 *
 * Being necessary and not sufficient is deliberate and is what keeps the check
 * honest: it can only fire when the script has NO mechanism for what the prose
 * claims, so a truthful sentence never trips it. Two consequences, both
 * accepted: a hook that blocks on the wrong condition still passes the block
 * rule, and rewording around the verb list (`makes sure`, `guards that`)
 * escapes it. Add the verb, don't weaken the condition.
 *
 * Scope is the CLAUSE that names the hook, never the whole sentence: reaching
 * past the clause means guessing at antecedents, and the sentences here name
 * three actors apiece (`reviewer` opens X, `commit-pr-pilot` opens Y, the hook
 * does Z). Under-reporting beats mis-reporting a neighbouring clause's verb.
 */

/** Hook scripts navori ships, by id (`subagent-stop-handoff`, …). */
const HOOKS_DIR = resolve(getCoreRoot(), "core-assets", "hooks");

/**
 * A shell comment is not behavior. The scripts document their own limits at
 * length ("it NEVER returns `decision: block`", "It does NOT verify the
 * reviewer's content receipt"), so reading capabilities off the raw text would
 * find every mechanism in the very comment that denies it. Full-line comments
 * only — stripping trailing `#` would corrupt strings that contain one.
 */
function executableBody(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

function hookScripts(): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(HOOKS_DIR).filter((f) => f.endsWith(".sh"))) {
    out.set(
      name.slice(0, -".sh".length),
      executableBody(readFileSync(join(HOOKS_DIR, name), "utf-8")),
    );
  }
  return out;
}

const SCRIPTS = hookScripts();

/**
 * Lifecycle event -> the hook ids registered for it, derived from the settings
 * builder rather than a hand-kept table: `buildClaudeSettings` IS what decides
 * which script runs on which event, so a rewiring moves this map with it. The
 * config turns on the two conditional hooks (quality gate, Stop reminder) so
 * every shipped hook is reachable by name.
 */
function eventToHookIds(): Map<string, string[]> {
  const config = {
    name: "test",
    engines: ["claude"],
    preset: "custom",
    version: "1.0.0",
    language: "es",
    branchBase: "main",
    commits: "conventional-es",
    qualityGate: { fast: "pnpm typecheck", full: "pnpm test" },
    hooks: { verifyOnStop: true },
  } as unknown as NavoriConfig;
  const hooks = buildClaudeSettings(config, []).hooks as Record<
    string,
    Array<{ hooks: Array<{ command: string }> }>
  >;
  const out = new Map<string, string[]>();
  for (const [event, matchers] of Object.entries(hooks ?? {})) {
    const ids = new Set<string>();
    for (const matcher of matchers) {
      for (const entry of matcher.hooks) {
        for (const id of SCRIPTS.keys()) if (entry.command.includes(`${id}.sh`)) ids.add(id);
      }
    }
    if (ids.size > 0) out.set(event, [...ids]);
  }
  return out;
}

const EVENT_HOOKS = eventToHookIds();

interface Capability {
  readonly id: string;
  /** Prose that asserts the capability. */
  readonly claimed: RegExp;
  /** The mechanism the script must contain for the claim to be possible. */
  readonly mechanism: RegExp;
  /** Named in the failure message, so the fix is obvious from the output. */
  readonly why: string;
}

const CAPABILITIES: readonly Capability[] = [
  {
    id: "blocks",
    claimed: /\b(blocks?|blocking|blocked|aborts?|rejects?|denies|prevents?)\b/i,
    mechanism:
      /(?:^|[\s;&|(])exit\s+2\b|"decision"\s*:\s*"block"|decision:\s*block|permissionDecision\S*\s*[:=]\s*\S*deny/,
    why: "a hook stops a turn or a tool call only by exiting 2 or emitting a `decision: block` payload; an advisory `systemMessage` never blocks anything",
  },
  {
    id: "detects a file that is missing",
    claimed:
      /\b(verif\w*|check\w*|ensur\w*|confirm\w*|guarantee\w*|catch\w*|detect\w*|sees?|notices?)\b[^.]{0,80}?\b(landed|lands|land|exists?|existence|present|missing|absent|was written|arrived|is there)\b/i,
    mechanism: /(?:\[\[?|test|!|&&|\|\|)\s+!?\s*-(?:f|e|s)\s/,
    why: "a hook can only notice an ABSENT file by testing a path for existence — iterating a glob yields only files that are already there",
  },
] as const;

/** A clause that says "no hook does X" is claiming the opposite: it must hold too. */
const NEGATION = /\b(never|not|no|none|nothing|neither|nor|cannot|can't|won't|n't)\b/i;

/**
 * Negation is read from what precedes the VERB, not from the whole clause. A
 * negative word after it belongs to something else: "the `guard-destructive`
 * hook hard-blocks the subset a static rule can't catch" is an affirmation, and
 * a clause-wide match read it as its own opposite.
 */
function isNegated(clause: string, capability: Capability): boolean {
  const at = clause.search(capability.claimed);
  return NEGATION.test(at < 0 ? clause : clause.slice(0, at));
}

/** The word that makes a clause a claim ABOUT a hook, not just prose near one. */
const HOOK_WORD = /\bhooks?\b/i;

interface Claim {
  readonly file: string;
  readonly line: number;
  readonly clause: string;
  /** Hook ids the clause resolves to; empty means "some hook", unnamed. */
  readonly hookIds: readonly string[];
}

interface AssetFile {
  readonly file: string;
  readonly text: string;
}

const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__", ".git"]);

function walkMarkdown(root: string, label: string): AssetFile[] {
  const out: AssetFile[] = [];
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(path, `${label}/${entry.name}`));
    else if (entry.name.endsWith(".md"))
      out.push({ file: `${label}/${entry.name}`, text: readFileSync(path, "utf-8") });
  }
  return out;
}

/**
 * Every prose asset in BOTH trees. The plugin tree is walked for the same
 * reason `hook-runtime-english` walks it: a rule that stops one directory short
 * of its own scope reads as coverage and is not.
 */
function proseAssets(): AssetFile[] {
  return [
    ...walkMarkdown(resolve(getCoreRoot(), "core-assets"), "core-assets"),
    ...walkMarkdown(getPluginAssetsRoot(), "plugins"),
  ];
}

/** Sentence-ish split; `.md`, `e.g.` and decimals keep their period (no space after). */
const SENTENCE_SPLIT = /(?<=[.!?])\s+/;
/** Clause split: commas, semicolons, colons, em/en dashes and parentheses. */
const CLAUSE_SPLIT = /[,;:()]|\s[—–]\s/;

/**
 * A clause that continues describing the subject of the one before it, so the
 * verb keeps its subject when the comma falls between them: "…is
 * `quality-gate-pre-commit`, which re-runs the fast gate and blocks if it
 * fails". Deliberately just the relative pronouns — anything looser starts
 * attaching a neighbouring actor's verb to the hook.
 */
const RELATIVE_CLAUSE = /^(which|that|who)\b/i;

/**
 * Which shipped hooks a clause names — directly by script id, or through the
 * lifecycle event it is registered for. The lookbehind keeps `Stop` from
 * matching inside `SubagentStop`; the `hook` word requirement on the EVENT path
 * keeps ordinary prose off the map ("Stop only for: BLOCKED", "Stop accepting
 * work before draining"), which a bare event name would otherwise pin to
 * `stop-verify-reminder.sh`. A script id needs no such guard: nothing else is
 * called `guard-destructive`.
 */
function resolveHooks(text: string): string[] {
  const ids = new Set<string>();
  for (const id of SCRIPTS.keys()) if (text.includes(id)) ids.add(id);
  if (HOOK_WORD.test(text)) {
    for (const [event, hookIds] of EVENT_HOOKS) {
      if (new RegExp(`(?<![A-Za-z])${event}(?![A-Za-z])`).test(text))
        for (const id of hookIds) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Every clause that talks about a hook, with the hooks it resolves to. Assets
 * keep one paragraph per line, so the line number is exact; a sentence wrapped
 * across lines would only ever be split into smaller clauses.
 */
function collectClaims(assets: readonly AssetFile[]): Claim[] {
  const claims: Claim[] = [];
  for (const { file, text } of assets) {
    text.split("\n").forEach((line, i) => {
      for (const sentence of line.split(SENTENCE_SPLIT)) {
        const sentenceHooks = resolveHooks(sentence);
        const parts = sentence.split(CLAUSE_SPLIT).map((part) => part.trim());
        parts.forEach((clause, index) => {
          const named = resolveHooks(clause);
          const isHookClause = HOOK_WORD.test(clause) || named.length > 0;
          if (!isHookClause) return;
          const next = parts[index + 1] ?? "";
          claims.push({
            file,
            line: i + 1,
            clause: RELATIVE_CLAUSE.test(next) ? `${clause}, ${next}` : clause,
            hookIds: named.length > 0 ? named : sentenceHooks,
          });
        });
      }
    });
  }
  return claims;
}

const CLAIMS = collectClaims(proseAssets());

function hasMechanism(hookId: string, capability: Capability): boolean {
  return capability.mechanism.test(SCRIPTS.get(hookId) ?? "");
}

/**
 * A claim is a violation when NO hook it could refer to has the mechanism the
 * clause attributes to it (or, for a negated clause, when one of them does have
 * it after the prose said none would). Unnamed clauses are judged against every
 * shipped hook: "a hook blocks them" cannot be pinned to a script, so the
 * charitable reading is the honest one — which is also why the assets name the
 * script wherever the claim carries weight.
 */
function violations(claims: readonly Claim[]): string[] {
  const out: string[] = [];
  for (const claim of claims) {
    const candidates = claim.hookIds.length > 0 ? claim.hookIds : [...SCRIPTS.keys()];
    for (const capability of CAPABILITIES) {
      if (!capability.claimed.test(claim.clause)) continue;
      const negated = isNegated(claim.clause, capability);
      const holders = candidates.filter((id) => hasMechanism(id, capability));
      if (!negated && holders.length === 0) {
        out.push(
          `${claim.file}:${claim.line} says a hook ${capability.id}, but ${candidates.join(", ")} ` +
            `has no such mechanism — ${capability.why}.\n    clause: "${claim.clause}"`,
        );
      }
      if (negated && holders.length > 0 && holders.length === candidates.length) {
        out.push(
          `${claim.file}:${claim.line} says a hook does NOT ${capability.id}, but ${holders.join(", ")} ` +
            `does — ${capability.why}.\n    clause: "${claim.clause}"`,
        );
      }
    }
  }
  return out;
}

describe("hook claims match what the hook scripts can do", () => {
  it("no asset attributes to a hook a capability its script lacks", () => {
    expect(violations(CLAIMS).join("\n"), "Fix the prose, or give the hook the mechanism.").toEqual(
      "",
    );
  });

  // Anti-vacuity for the extractor: an empty (or hook-blind) claim set would
  // make the case above pass on nothing at all, which is the shape of green
  // this whole batch keeps finding.
  it("finds the hook claims that are actually on disk", () => {
    const named = CLAIMS.filter((c) => c.hookIds.length > 0);
    const files = new Set(named.map((c) => c.file));
    expect([...files].sort()).toEqual(
      expect.arrayContaining([
        "core-assets/agents/implementer.md",
        "core-assets/agents/leader.md",
        "core-assets/agents/reviewer.md",
        "core-assets/managed/arranque-sesion.md",
        "core-assets/managed/operaciones-seguras.md",
        "core-assets/managed/orquestacion.md",
      ]),
    );
    expect(named.length).toBeGreaterThanOrEqual(6);
  });

  // A rule with no live claim is a rule nobody would notice going blind, so
  // each one has to be exercised by the assets as they ship — affirmed
  // ("the `guard-destructive` hook hard-blocks …") or denied ("that hook never
  // sees one that didn't land at all"), both are checked against the script.
  it.each(CAPABILITIES.map((c) => [c.id, c] as const))(
    'the "%s" rule is exercised by a claim on disk',
    (_id, capability) => {
      const claimed = CLAIMS.filter((c) => capability.claimed.test(c.clause));
      expect(claimed.map((c) => `${c.file}:${c.line}`)).not.toEqual([]);
    },
  );
});

describe("the capability reader discriminates between the real scripts", () => {
  const block = CAPABILITIES[0] as Capability;
  const absence = CAPABILITIES[1] as Capability;

  it.each([
    ["guard-destructive", true],
    ["quality-gate-pre-commit", true],
    ["subagent-stop-handoff", false],
    ["session-start-context", false],
  ])("%s can block: %s", (id, expected) => {
    expect(hasMechanism(id as string, block)).toBe(expected);
  });

  it.each([
    ["session-start-context", true],
    ["subagent-stop-handoff", false],
  ])("%s can test a path for existence: %s", (id, expected) => {
    expect(hasMechanism(id as string, absence)).toBe(expected);
  });

  it("reads capabilities from behavior, not from the comment that denies them", () => {
    const raw = readFileSync(join(HOOKS_DIR, "subagent-stop-handoff.sh"), "utf-8");
    // The header says `decision: block` while explaining that it never emits one.
    expect(block.mechanism.test(raw)).toBe(true);
    expect(hasMechanism("subagent-stop-handoff", block)).toBe(false);
  });
});

describe("the cross-check fires on the claims that shipped before the fix", () => {
  /**
   * Positive control on the real regression (review of `fix/bloque-assets`,
   * finding 4), not on a synthetic string: these are the exact clauses the four
   * assets carried. A rewrite of the fix that keeps the false attribution has
   * to fail here.
   */
  it.each([
    [
      "implementer.md",
      "the `reviewer` opens it to judge your diff, and a `SubagentStop` hook checks it landed.",
    ],
    [
      "reviewer.md",
      "the `commit-pr-pilot` reads the verdict and re-hashes the receipt before it commits, and a `SubagentStop` hook checks they landed.",
    ],
    [
      "leader.md",
      "the `commit-pr-pilot` opens the `reviewer`'s and its `receipt.txt`, and a `SubagentStop` hook verifies they landed.",
    ],
    ["a blocking claim", "the `SubagentStop` hook blocks the turn until the handoff is written."],
    [
      "an absence claim worded some other way",
      "the `subagent-stop-handoff` hook confirms every handoff exists before the leader reads it.",
    ],
  ])("flags %s", (_label, text) => {
    const found = violations(collectClaims([{ file: "regression.md", text }]));
    expect(found.length, `no violation reported for: ${text}`).toBeGreaterThan(0);
  });

  it.each([
    [
      "the fixed SubagentStop wording",
      "a `SubagentStop` hook flags one that lands empty or without its `Status:` line.",
    ],
    [
      "a true blocking claim",
      "the `quality-gate-pre-commit` hook re-runs the fast gate and blocks the commit if it fails.",
    ],
    [
      "a true advisory claim",
      "the `subagent-stop-handoff` hook is advisory and never blocks a turn.",
    ],
  ])("accepts %s", (_label, text) => {
    expect(violations(collectClaims([{ file: "ok.md", text }]))).toEqual([]);
  });
});
