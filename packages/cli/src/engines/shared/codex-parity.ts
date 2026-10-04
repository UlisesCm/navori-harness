import { z } from "zod";
import { compareSemver } from "../../lib/primitives/semver.ts";

/**
 * Codex parity contract (spec 0041 D1/D2): one row per unit the Claude engine
 * distributes, saying whether Codex gives the SAME guarantee. It is a sibling of
 * `OVERLAP_ROWS` (joined to it by `kind:id`), so `native-overlap.ts` imports this
 * module and this module must never import `native-overlap.ts`,
 * `hook-registrations.ts` or `engine-capabilities.ts` as a value (ESM cycle).
 *
 * Why three states instead of a boolean: "Codex has it" hides two different
 * facts. `igual` and `equivalente` both keep the guarantee but differ in whether
 * the mechanism is the same hook (`igual`) or a different one the row must name
 * (`equivalente`); `limite-codex` is the honest answer when Codex cannot give it,
 * and it must carry the official source that proves the limit (R2).
 *
 * A row that depends on a live probe (V1-V10, spec 0041 design) starts as
 * `limite-codex` with its current official source and is promoted only by the
 * probe task that verifies it; this file never promotes on assumption.
 */

/**
 * Id of a dated live verification in {@link CODEX_VERIFICATIONS}: `V<n>` for a
 * T7 probe, `S<n>` for a T20 smoke. Each id is also a `## V<n>` / `## S<n>`
 * section of the research doc `codex-paridad-verificacion`.
 */
export type VerificationId = `V${number}` | `S${number}`;

/** Codex release every row of this lote was consulted against (`codex-cli`). */
const CODEX_VERSION = "0.160.0";
/** Date the official sources below were consulted. */
const CONSULTED_AT = "2026-10-02";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * Hosts whose pages may back a `limite-codex` claim (R2). GitHub is accepted
 * only for `github.com/openai/codex` at a release tag, checked in
 * {@link codexSourceIssue}: the host alone would let any repository pass.
 */
export const CODEX_SOURCE_HOSTS: ReadonlySet<string> = new Set([
  "learn.chatgpt.com",
  "developers.openai.com",
  "github.com",
]);

const SourceSchema = z.object({
  url: z.string().min(1),
  codexVersion: z.string().min(1),
  verifiedAt: z.string().min(1),
});

const VerificationIdSchema = z.custom<VerificationId>(
  (value) => typeof value === "string" && /^[VS]\d+$/.test(value),
  "verification id must look like V<n> or S<n>",
);

/**
 * Structural shape of a parity row. The semantic checks (official source,
 * enforcing needs a smoke) live in {@link codexParityIssues}, so that
 * `OverlapRowSchema` can report them labelled with the unit's `kind:id`.
 *
 * `enforcing` marks a row whose block/confirm claim rests on a live probe.
 * Rows pending their probe stay `enforcing: false`; the refine promotes the
 * flag only together with a verification that has `smoke: "pass"` (R25).
 */
export const CodexParitySchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("igual"),
    enforcing: z.boolean(),
    verification: VerificationIdSchema.optional(),
  }),
  z.object({
    state: z.literal("equivalente"),
    /** The different mechanism Codex uses; a row without it is not `equivalente`. */
    mechanism: z.string().min(1),
    /** What the Codex mechanism does differently, when anything. */
    difference: z.string().min(1).optional(),
    enforcing: z.boolean(),
    verification: VerificationIdSchema.optional(),
  }),
  z.object({
    state: z.literal("limite-codex"),
    source: SourceSchema,
    /** What Codex still gives (or what the harness does instead) around the limit. */
    containment: z.string().min(1).optional(),
  }),
]);

export type CodexParity = z.infer<typeof CodexParitySchema>;

/** A dated live probe of one Codex capability (filled in by the probe tasks). */
export interface CodexVerification {
  readonly capability: string;
  /** Official doc or source URL; same allowlist as a `limite-codex` source. */
  readonly url: string;
  /** Semver of the Codex binary that was probed. */
  readonly codexVersion: string;
  /** `YYYY-MM-DD`, never in the future. */
  readonly verifiedAt: string;
  readonly probe: "pass" | "fail";
  /** Spawn-related probes must cover both multi-agent versions (R9). */
  readonly multiAgent?: readonly ("v1" | "v2")[];
  /** Required when a referencing row is `enforcing` (R25). */
  readonly smoke?: "pass" | "fail";
}

/**
 * Hook scripts Codex never registers although their guarantee holds there
 * (`equivalente` rows, spec 0041 T12/T13): `bash-outcome-watch` is a lane inside
 * `routing-watch`, and `subagent-no-background` has no vector to block. Their
 * script is neither installed nor registered, so they stay unsupported surfaces;
 * `native-overlap.test.ts` pins this list against `CODEX_HOOK_REGISTRATIONS`.
 */
export const CODEX_HOOKS_WITHOUT_REGISTRATION: readonly string[] = [
  "bash-outcome-watch",
  "subagent-no-background",
];

/** `kind:id` key a unit is stored under in {@link CODEX_PARITY}. */
export function codexParityKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Why `url` cannot back a Codex claim for `codexVersion`, or `null` when it can.
 * Requires https on an allowlisted host; GitHub must be `openai/codex` at the
 * `rust-v<version>` tag matching `codexVersion`, so a source never drifts to
 * another release than the one the row says it verified.
 */
export function codexSourceIssue(url: string, codexVersion: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "needs a valid official Codex source URL";
  }
  if (parsed.protocol !== "https:" || !CODEX_SOURCE_HOSTS.has(parsed.hostname)) {
    return "needs an https official Codex source (learn.chatgpt.com, developers.openai.com or github.com/openai/codex)";
  }
  if (parsed.hostname === "github.com") {
    const tag = /^\/openai\/codex\/blob\/rust-v(\d+\.\d+\.\d+)\//.exec(parsed.pathname)?.[1];
    if (tag === undefined) {
      return "GitHub sources must be github.com/openai/codex/blob/rust-v<version>/…";
    }
    if (tag !== codexVersion) {
      return `GitHub source tag rust-v${tag} differs from codexVersion ${codexVersion}`;
    }
  }
  return null;
}

/**
 * Semantic problems of one parity row, as messages without the unit name (the
 * caller prefixes `kind:id`). Covers R2 (a `limite-codex` row needs an official
 * source, a Codex version and a non-future date) and R25 (an `enforcing` row
 * needs a verification whose smoke passed; a spawn-related verification lists
 * both multi-agent versions).
 */
export function codexParityIssues(
  parity: CodexParity,
  verifications: Readonly<Record<string, CodexVerification>> = CODEX_VERIFICATIONS,
): string[] {
  const issues: string[] = [];
  if (parity.state === "limite-codex") {
    const { url, codexVersion, verifiedAt } = parity.source;
    const urlIssue = codexSourceIssue(url, codexVersion);
    if (urlIssue !== null) issues.push(`limite-codex ${urlIssue}`);
    if (!SEMVER.test(codexVersion)) {
      issues.push("limite-codex needs the Codex version (x.y.z) it was verified against");
    }
    if (
      !ISO_DATE.test(verifiedAt) ||
      Number.isNaN(Date.parse(verifiedAt)) ||
      verifiedAt > new Date().toISOString().slice(0, 10)
    ) {
      issues.push("limite-codex needs a YYYY-MM-DD verification date that is not in the future");
    }
    return issues;
  }
  const verification =
    parity.verification === undefined ? undefined : verifications[parity.verification];
  if (parity.verification !== undefined && verification === undefined) {
    issues.push(`references unknown verification ${parity.verification}`);
  }
  if (parity.enforcing && verification?.smoke !== "pass") {
    issues.push("an enforcing row needs a verification with smoke 'pass'");
  }
  const versions = verification?.multiAgent;
  if (versions !== undefined && !(versions.includes("v1") && versions.includes("v2"))) {
    issues.push("a spawn-related verification must cover multi-agent v1 and v2");
  }
  return issues;
}

/**
 * Highest Codex version at which an `igual`/`equivalente` row was verified
 * (R4), or `0.0.0` when none was. A `limite-codex` row, a row without a
 * verification and a failed probe do not count: only a passing probe proves the
 * guarantee exists at that version. `hook-registrations.ts`'s `minCodexVersion`
 * (the one `doctor` and `render` read) is the max of this and the floor the
 * registered hook table needs.
 */
export function minCodexVersion(
  parity: Readonly<Record<string, CodexParity>> = CODEX_PARITY,
  verifications: Readonly<Record<string, CodexVerification>> = CODEX_VERIFICATIONS,
): string {
  let max = "0.0.0";
  for (const row of Object.values(parity)) {
    if (row.state === "limite-codex" || row.verification === undefined) continue;
    const verification = verifications[row.verification];
    if (verification === undefined || verification.probe !== "pass") continue;
    if ((compareSemver(verification.codexVersion, max) ?? 0) > 0) max = verification.codexVersion;
  }
  return max;
}

/**
 * Keys of `inventory` that `parity` has no row for (R3). A pure function so the
 * negative case ("a unit without a row fails, naming it") is testable without
 * mutating the real table.
 */
export function missingParityUnits(
  inventory: readonly string[],
  parity: Readonly<Record<string, CodexParity>> = CODEX_PARITY,
): string[] {
  return inventory.filter((key) => !(key in parity));
}

// -- row builders ------------------------------------------------------------

const igual = (): CodexParity => ({ state: "igual", enforcing: false });

const equivalente = (mechanism: string, difference?: string): CodexParity => ({
  state: "equivalente",
  mechanism,
  ...(difference === undefined ? {} : { difference }),
  enforcing: false,
});

/**
 * Attaches a live verification to an `igual`/`equivalente` row. `enforcing` is
 * set only when asked for, and {@link codexParityIssues} then requires the
 * verification's smoke to be `pass` (R25).
 */
const verified = (
  row: CodexParity,
  verification: VerificationId,
  enforcing: boolean,
): CodexParity => {
  if (row.state === "limite-codex") throw new Error("a limite-codex row has no verification");
  return { ...row, verification, enforcing };
};

const limite = (url: string, containment?: string): CodexParity => ({
  state: "limite-codex",
  source: { url, codexVersion: CODEX_VERSION, verifiedAt: CONSULTED_AT },
  ...(containment === undefined ? {} : { containment }),
});

const SRC = `https://github.com/openai/codex/blob/rust-v${CODEX_VERSION}/codex-rs`;
/** Official sources (design.md "Hechos de Codex usados", F1-F21). */
const SOURCES = {
  hooksDoc: "https://learn.chatgpt.com/docs/hooks",
  hooksSchema: `${SRC}/hooks/src/schema.rs`,
  execPolicy: `${SRC}/core/src/exec_policy.rs`,
  execPolicyReadme: `${SRC}/execpolicy/README.md`,
  toolContext: `${SRC}/core/src/tools/context.rs`,
  execCommand: `${SRC}/core/src/tools/handlers/unified_exec/exec_command.rs`,
  features: `${SRC}/features/src/lib.rs`,
  specPlan: `${SRC}/core/src/tools/spec_plan.rs`,
  spawnV2: `${SRC}/core/src/tools/handlers/multi_agents_v2/spawn.rs`,
} as const;

const PROBED_AT = "2026-10-03";

type Evidence = Pick<CodexVerification, "capability" | "url"> &
  Partial<Pick<CodexVerification, "probe" | "multiAgent" | "smoke">>;

/** A verification run on {@link CODEX_VERSION} on {@link PROBED_AT}; the probe passed unless said otherwise. */
const ran = ({ probe = "pass", ...rest }: Evidence): CodexVerification => ({
  codexVersion: CODEX_VERSION,
  verifiedAt: PROBED_AT,
  probe,
  ...rest,
});

/**
 * Dated live verifications, run on `codex-cli` 0.160.0: spec 0041 T7 probes
 * (`V<n>`) and T20 smokes (`S<n>`). The evidence of each id is the matching
 * `## V<n>` / `## S<n>` section of the research doc `codex-paridad-verificacion`;
 * `url` is the official source the verified row already cites. A row may be
 * `enforcing` only through a verification whose `smoke` is `pass`; the `V<n>`
 * probes carry no smoke (they shaped the design, no row's enforcement rests on
 * one alone). Rows without an entry here were not run and stay unpromoted.
 */
export const CODEX_VERIFICATIONS: Readonly<Record<string, CodexVerification>> = {
  V1: ran({
    capability:
      "prefix_rule prompt: asks in the main thread, runs with no prompt inside a spawned subagent",
    url: SOURCES.execPolicyReadme,
    probe: "fail",
  }),
  V2: ran({
    capability:
      "PreToolUse/PostToolUse(Bash) payload carries top-level agent_type and agent_id inside a subagent",
    url: SOURCES.hooksDoc,
  }),
  V3: ran({
    capability:
      "spawn_agent hook payload: v1 exposes agent_type and a readable message; v2 flattens the tool name to spawn_agent and encrypts the message",
    url: SOURCES.spawnV2,
    multiAgent: ["v1", "v2"],
  }),
  V4: ran({
    capability:
      "the rollout holds the current Bash call's item_completed record (with exit_code) when PostToolUse fires",
    url: SOURCES.hooksDoc,
  }),
  V5: ran({
    capability:
      "a subagent can spawn a grandchild under v2 (depth 2); under v1 it has no spawn tool",
    url: SOURCES.spawnV2,
    multiAgent: ["v1", "v2"],
  }),
  V6: ran({
    capability:
      "no run_in_background field and no Monitor tool exist in Codex; a shell `&` leaves no runtime marker",
    url: SOURCES.execCommand,
  }),
  V7: ran({
    capability: "the model id is a top-level field of the PreToolUse/PostToolUse payloads",
    url: SOURCES.hooksDoc,
  }),
  V10: ran({
    capability: "spawn_agent with an unknown agent_type (orchestrator) fails as unknown",
    url: SOURCES.spawnV2,
  }),
  S1: ran({
    capability: "role-guard denies a scout apply_patch outside its handoff and specs prefixes",
    url: SOURCES.hooksDoc,
    smoke: "pass",
  }),
  S2: ran({
    capability:
      "role-guard denies spawn_agent from a subagent under v2; under v1 the child has no spawn tool (V5)",
    url: SOURCES.spawnV2,
    multiAgent: ["v1", "v2"],
    smoke: "pass",
  }),
  S3: ran({
    capability:
      "plan-gate under v1, the v1 half of the S4 pair: denies a spawn without the opening line, allows `nivel-0:`",
    url: SOURCES.spawnV2,
    smoke: "pass",
  }),
  S4: ran({
    capability:
      "plan-gate under v1 (S3) and v2 (deny, allow through the dispatch file). The model-written dispatch (S4d) was rejected for its +00:00 offset: fixed in the same task and re-smoked live (S4f, PASS): the model wrote its own dispatch, the spawn was allowed and the dispatch consumed",
    url: SOURCES.spawnV2,
    multiAgent: ["v1", "v2"],
    smoke: "pass",
  }),
  S5: ran({
    capability:
      "the tgrep lane of guard-destructive blocks a recursive `grep -rn` through the shell when a tgrep index exists",
    url: SOURCES.hooksDoc,
    smoke: "pass",
  }),
  S7: ran({
    capability: "pr-publisher-confirm denies `gh pr create` in the main thread",
    url: SOURCES.hooksDoc,
    smoke: "pass",
  }),
  S8: ran({
    capability: "bash-outcome-watch advises after three consecutive failing Bash calls",
    url: SOURCES.hooksDoc,
    smoke: "pass",
  }),
  S9: ran({
    capability: "general-purpose-confirm denies a general-purpose spawn_agent",
    url: SOURCES.hooksDoc,
    smoke: "pass",
  }),
  S10: ran({
    capability:
      "master-plan-context SessionStart output reaches the session; indirect: the model offered to continue specs/_master/INDEX.md, the hook itself was not smoked",
    url: SOURCES.hooksDoc,
  }),
};

const igualUnits = (kind: string, ids: readonly string[]): Array<[string, CodexParity]> =>
  ids.map((id) => [codexParityKey(kind, id), igual()]);

// -- permission rules (D3, D4) ------------------------------------------------

/**
 * Generic classes of terminal permission rules every Claude `ask`/`deny` falls
 * under, plus the two asymmetries Codex adds. Ids are the `permission-rule`
 * unit ids `class:<id>`.
 */
export const PERMISSION_RULE_CLASS_IDS = [
  "bash-ask",
  "bash-deny",
  "allow-not-translated",
  "prompt-amendment",
] as const;

/**
 * Non-Bash `ask`/`deny` entries `buildCodexRules` cannot translate and reports as
 * `dropped` (R14): each needs its own row, never a silent drop. Ids are
 * `dropped:<pattern>`.
 */
export const DROPPED_PERMISSION_PATTERNS: readonly string[] = ["Agent(orchestrator)"];

/**
 * One group of Claude patterns that `translatePattern` narrows to a literal
 * prefix (R26, D4). Every pattern in `patterns` gets its own `permission-rule`
 * row (`narrowed:<pattern>`) carrying the family's `parity`; a narrowed pattern
 * outside every family fails the closure test, so a new glued-`*` pattern in
 * `settings-base.json` cannot ship unclassified.
 */
export interface NarrowedPatternFamily {
  readonly id: string;
  readonly decision: "prompt" | "forbidden";
  readonly patterns: readonly string[];
  readonly parity: CodexParity;
}

/** Every spelling of recursive `rm` the base deny-list enumerates (19 variants). */
const RM_RECURSIVE_VARIANTS: readonly string[] = (() => {
  const recursive = ["-r", "-R", "--recursive"];
  const force = ["-f", "--force"];
  return [
    "-rf",
    "-fr",
    "-Rf",
    "-fR",
    ...recursive,
    ...recursive.flatMap((r) => force.map((f) => `${r} ${f}`)),
    ...force.flatMap((f) => recursive.map((r) => `${f} ${r}`)),
  ];
})();

const RM_TARGETS = ["/*", "~/*", "$HOME/*"] as const;

/**
 * The narrowed-pattern families (R26). `equivalente` families point at the
 * registered `guard-destructive` hook and at the Codex-payload tests in
 * `lib/__tests__/guard-destructive.test.ts` that pin the variants the literal
 * prefix misses; `limite-codex` families have no hook covering the rest.
 */
export const NARROWED_PATTERN_FAMILIES: readonly NarrowedPatternFamily[] = [
  {
    id: "rm-recursive-root-home",
    decision: "forbidden",
    patterns: RM_RECURSIVE_VARIANTS.flatMap((variant) =>
      RM_TARGETS.map((target) => `Bash(rm ${variant} ${target})`),
    ),
    parity: equivalente(
      "guard-destructive rule 3 on the registered PreToolUse ^Bash$ hook",
      "the prefix rule matches only the literal '/', '~' or '$HOME' target; the hook blocks any root/home/system target with any flag order (guard-destructive.test.ts, Codex payload cases)",
    ),
  },
  {
    id: "rm-no-preserve-root",
    decision: "forbidden",
    patterns: [
      "Bash(rm --no-preserve-root*)",
      ...RM_RECURSIVE_VARIANTS.map((variant) => `Bash(rm ${variant} --no-preserve-root*)`),
    ],
    parity: equivalente(
      "guard-destructive rule 3b on the registered PreToolUse ^Bash$ hook",
      "the prefix rule matches only the exact flag order; the hook blocks --no-preserve-root with any interleaving (guard-destructive.test.ts, Codex payload cases)",
    ),
  },
  {
    id: "git-push-force",
    decision: "prompt",
    patterns: ["Bash(git push --force*)"],
    parity: limite(
      SOURCES.execPolicyReadme,
      "F9: a prefix_rule has no glob inside a token. The prefix covers --force, -f has its own rule and guard-destructive blocks a forced push to the base branch; --force-with-lease and --force-if-includes off the base branch are not covered. The prompt solo confirma en el hilo principal (sonda V1)",
    ),
  },
  {
    id: "git-destructive-prefix",
    decision: "prompt",
    patterns: [
      "Bash(git reset --hard*)",
      "Bash(git clean -f*)",
      "Bash(git clean -d*)",
      "Bash(git branch --delete*)",
      "Bash(git stash drop*)",
      "Bash(git stash clear*)",
    ],
    parity: limite(
      SOURCES.execPolicyReadme,
      "F9: the prefix covers the exact option; glued variants (-fd, -fx) are covered by nothing. The prompt solo confirma en el hilo principal (sonda V1)",
    ),
  },
  {
    id: "mkfs",
    decision: "forbidden",
    patterns: ["Bash(mkfs*)"],
    parity: limite(SOURCES.execPolicyReadme, "F9: mkfs.ext4 and similar spellings are not covered"),
  },
];

const permissionRuleEntries = (): Array<[string, CodexParity]> => [
  [
    codexParityKey("permission-rule", "class:bash-ask"),
    limite(
      SOURCES.execPolicy,
      "ask is translated to a prefix_rule prompt (F6); solo confirma en el hilo principal (sonda V1): inside a subagent the call runs with no prompt",
    ),
  ],
  [
    codexParityKey("permission-rule", "class:bash-deny"),
    equivalente(
      "prefix_rule decision forbidden in .codex/rules/navori.rules",
      "narrowed patterns have their own rows (narrowed:<pattern>)",
    ),
  ],
  [
    codexParityKey("permission-rule", "class:allow-not-translated"),
    limite(
      SOURCES.execPolicy,
      "F8: a Codex allow rule runs the command outside the sandbox, so Claude's allow-list is never translated. With danger-full-access and on-request Codex does not ask for commands without a rule (F6)",
    ),
  ],
  [
    codexParityKey("permission-rule", "class:prompt-amendment"),
    limite(
      SOURCES.execPolicy,
      "F7: approving a prompt rule can offer a persistent 'do not ask again' amendment, turning a confirmation into an allow; Claude ask has no such effect (probe V4)",
    ),
  ],
  ...DROPPED_PERMISSION_PATTERNS.map((pattern): [string, CodexParity] => [
    codexParityKey("permission-rule", `dropped:${pattern}`),
    limite(
      SOURCES.spawnV2,
      "Codex rules only govern terminal commands; Codex renders no orchestrator role to spawn (probe V10 pending)",
    ),
  ]),
  ...NARROWED_PATTERN_FAMILIES.flatMap(({ patterns, parity }) =>
    patterns.map((pattern): [string, CodexParity] => [
      codexParityKey("permission-rule", `narrowed:${pattern}`),
      parity,
    ]),
  ),
];

// -- the table ---------------------------------------------------------------

/**
 * One parity row per Claude-distributed unit, keyed `kind:id` (R1, D1). Rows are
 * listed explicitly, never defaulted: `native-overlap.test.ts` compares the keys
 * with the real inventory, so a unit added without a row (or a row left behind)
 * fails naming it (R3).
 */
export const CODEX_PARITY: Readonly<Record<string, CodexParity>> = Object.freeze(
  Object.fromEntries<CodexParity>([
    // Agents.
    ...igualUnits("agent", ["implementer", "scribe"]),
    [
      "agent:orchestrator",
      equivalente(
        "the main Codex thread embodies the role (AGENTS.md and .codex/orchestrator.md); no spawnable orchestrator agent is emitted",
      ),
    ],
    // Spec 0041 T8 (D5): `role-guard` on `apply_patch` replaces Claude's `tools:`
    // allowlist. Bash keeps Claude-equal containment (none by path). The T20
    // smoke (S1) exercised the hook on `scout` only, not these per-role rows, so
    // the flag stays off; the hook itself is enforcing (hook:role-guard).
    ...["reviewer", "scout", "auditor", "publisher", "architect"].map(
      (id): [string, CodexParity] => [
        `agent:${id}`,
        equivalente(
          "role-guard on PreToolUse apply_patch limits the role to the prefixes of RosterAgent.writes instead of a tools allowlist",
          "Bash writes are not contained by path, same as Claude; a `default` or unknown child gets only the handoff and temp paths",
        ),
      ],
    ),
    // Skills.
    ...igualUnits("skill", [
      "verify-before-done",
      "debug-failure",
      "review-diff",
      "security-invariants",
      "secure-by-design",
      "locate-code",
      "scoped-gate",
      "resolve-ticket",
      "solution-design",
      "spec-bootstrap",
      "dominio",
      "follow-up-prs",
      "quality-attributes",
      "author-skill",
      "plan-simple",
      "plan-advanced",
    ]),
    // Spec 0041 R20 (T15): both skills are emitted to `.agents/skills/` now. The
    // user confirmation is a chat question that ends the turn (D11); no T20
    // smoke exercised the skill, so the flag stays off.
    ...["master-plan", "context-intake"].map((id): [string, CodexParity] => [
      `skill:${id}`,
      equivalente(
        "Skill emitted to .agents/skills; confirmations are numbered chat options that end the turn",
        "no AskUserQuestion: request_user_input is behind an UnderDevelopment feature in Default mode (F14)",
      ),
    ]),
    // Hooks. Order matches CODEX_HOOK_REGISTRATIONS for the unregistered ones, so
    // `CODEX_HOOK_UNSUPPORTED_SURFACES` keeps its order.
    ...igualUnits("hook", [
      "guard-destructive",
      "comment-draft-confirm",
      "quality-gate-pre-commit",
      "session-start-context",
      "implementer-no-markdown",
      "managed-drift-watch",
      "routing-watch",
      "audit-mode-trigger",
      "audit-mode-close",
      "stop-verify-reminder",
    ]),
    [
      "hook:model-advisor",
      equivalente(
        "SessionStart with the codex-session-start mode",
        "Codex has no per-turn model-change event registered yet; the advice fires once per session",
      ),
    ],
    ["hook:subagent-stop-handoff", equivalente("SubagentStop instead of PostToolUse(Agent|Task)")],
    [
      "hook:worktree-reclaim",
      equivalente(
        "SessionStart(startup) of the next session instead of SessionEnd",
        "Codex caps SessionEnd at 3s, too tight for git worktree cleanup",
      ),
    ],
    [
      "hook:plan-gate",
      verified(
        equivalente(
          "PreToolUse(spawn_agent$) gates only implementer, role from tool_input.agent_type; with an encrypted message (probe V3) the opening line is read from the orchestrator's dispatch_<feature>.json (spec 0041 R9)",
          "the dispatch file has a 10 min TTL and exactly one fresh file may exist. The hook shells out to the globally installed `navori` CLI, so the v2 dispatch path needs a navori release that contains it (S4 ran with a PATH shim to the branch build); smoked live under v1 and v2 (S3, S4)",
        ),
        "S4",
        true,
      ),
    ],
    [
      "hook:bash-outcome-watch",
      verified(
        equivalente(
          "bash-outcome lane inside routing-watch on PostToolUse(Bash): the exit code is read from the rollout item_completed record whose item.id is the tool_use_id (probe V4, spec 0041 R11), reusing the bash-outcome partial",
          "reads only exit_code from the bounded rollout tail and stays silent when the record is missing; smoked live (S8)",
        ),
        "S8",
        true,
      ),
    ],
    [
      "hook:pr-publisher-confirm",
      verified(
        equivalente(
          "deny-as-confirmation: the Codex copy of the hook denies `gh pr create` instead of asking, also inside the publisher subagent where a prompt rule is silent (probe V1, spec 0041 R10)",
          "Codex hooks cannot emit `ask`, so the user runs the command themselves after reviewing it; smoked live in the main thread (S7), the subagent path rests on hooks firing there (V2)",
        ),
        "S7",
        true,
      ),
    ],
    [
      "hook:subagent-no-background",
      equivalente(
        "the vector does not exist in Codex (probe V6b, spec 0041 R12): no run_in_background field and no Monitor tool, so there is nothing to block; shell `&` is prose-only on both engines. Reference: " +
          SOURCES.execCommand,
        "no hook is registered or installed in Codex; the shell `&` stays a prose rule, as in Claude",
      ),
    ],
    [
      "hook:master-accept-confirm",
      equivalente(
        "deny-as-confirmation: the Codex copy of the hook denies instead of asking (the comment-draft-confirm pattern, spec 0041 D11)",
        "Codex hooks cannot emit `ask`, so the user runs the command themselves after reviewing it",
      ),
    ],
    [
      "hook:general-purpose-confirm",
      verified(
        equivalente(
          "deny-as-confirmation on PreToolUse(spawn_agent$) when agent_type is general-purpose (spec 0041 R10)",
          "Codex hooks cannot emit `ask`; the denial points at the scout; smoked live (S9)",
        ),
        "S9",
        true,
      ),
    ],
    [
      "hook:role-guard",
      verified(
        equivalente(
          "Codex-only PreToolUse hook: apply_patch is contained per role by RosterAgent.writes, and spawn_agent from a subagent is denied (spec 0041 D5/D13)",
          "Claude restricts roles with `tools:`, so the hook is not rendered there; smoked live (S1 apply_patch, S2 spawn)",
        ),
        "S1",
        true,
      ),
    ],
    [
      "hook:engram-write-guard",
      equivalente(
        "Codex-only PreToolUse(mcp__engram__ | mcp__plugin_engram_engram__): a subagent may call only the engram tools Claude grants its role in `tools:` (auditor reads + mem_save; implementer/reviewer/scout reads; architect/publisher/scribe none); the main thread is never blocked",
        "Claude restricts with `tools:`, so the hook is not rendered there. A `default` or unknown child gets only mem_search and mem_get_observation (deliberate hardening, Claude's general-purpose inherits all). Registered after plan-gate to keep every published trust index: toggling `harness.planTiers` or `harness.masterPlan` shifts this row's index and needs one re-approval in /hooks; until approved it does not run. Not smoked on its own, so not enforcing",
      ),
    ],
    [
      "hook:master-plan-context",
      verified(
        equivalente(
          "SessionStart hook registered when harness.masterPlan is on; its stdout reaches the session as context (spec 0041 R21)",
          "advisory context, not a permission boundary. Not enforcing: the evidence is indirect (S10), the model offered to continue the master plan but the hook was not smoked on its own",
        ),
        "S10",
        false,
      ),
    ],
    // Managed blocks: prose contracts, no host dependency.
    ...igualUnits("managed-block", [
      "arranque-sesion",
      "cierre-sesion",
      "code-discovery-routing",
      "codex-cross-review",
      "formato-respuesta",
      "idioma-rol",
      "intake-tickets",
      "operaciones-seguras",
      "orquestacion",
      "plan-maestro",
      "planificacion",
      "sdd",
      "tipado-fuerte",
    ]),
    // Bundled plugins; the script-level gaps live on their plugin-script rows.
    ...igualUnits("plugin", ["acli", "codegraph", "engram", "gh", "jscpd", "semgrep", "tgrep"]),
    ...igualUnits("plugin-script", ["jscpd/check-jscpd.sh", "semgrep/check-semgrep.sh"]),
    [
      "plugin-script:tgrep/guard-search-routing.sh",
      verified(
        equivalente(
          "the tgrep hookExtension is injected into the Codex guard-destructive copy and sources this script from .codex/scripts (spec 0041 R29)",
          "smoked live (S5): a recursive `grep -rn` through the shell is blocked when a tgrep index exists; without an index the lane fails open by design (exit 43)",
        ),
        "S5",
        true,
      ),
    ],
    // Flows.
    ...igualUnits("flow", ["native-task-list", "native-workflows"]),
    [
      "flow:master-plan-vs-plan-mode",
      limite(
        SOURCES.features,
        "master-plan is not rendered for Codex yet (see skill:master-plan); the user question it needs is behind an UnderDevelopment feature (F14)",
      ),
    ],
    [
      "flow:nested-agent-dispatch",
      verified(
        equivalente(
          "the orchestrator runs scout before and scribe after; role-guard denies spawn_agent from any subagent (spec 0041 D13), which keeps depth 1 under V1 and V2 (F17)",
          "the deny fires on PreToolUse of the spawn tool, so it holds only where that hook payload carries the caller's agent_type (V2); smoked live under v2 (S2), under v1 the child has no spawn tool (V5)",
        ),
        "S2",
        true,
      ),
    ],
    // Permission rules.
    ...permissionRuleEntries(),
  ]),
);
