import type { ControlId } from "./engine-capabilities.ts";
import { DROPPED_PERMISSION_PATTERNS, NARROWED_PATTERN_FAMILIES } from "./codex-parity.ts";

/**
 * Pi parity inventory (spec 0048 R1, D11): one row per unit Navori emits for
 * another engine, saying what Pi gives TODAY for it. Sibling of
 * `codex-parity.ts` and joined to `OVERLAP_ROWS` by `kind:id`, so
 * `native-overlap.ts` imports this module and this module must never import
 * `native-overlap.ts` or `engine-capabilities.ts` as a value (ESM cycle; the
 * `ControlId` import is type-only).
 *
 * The table declares the truth at EVERY commit, not the end state: a unit a
 * later milestone will deliver stays `unsupported` (with the reason) until the
 * milestone that implements it flips the row together with its code and tests.
 * This file never promotes a row on intent.
 *
 * States: `enforced` blocks or requires something Pi cannot skip by itself;
 * `advisory` informs without blocking, or covers only part of the shape;
 * `unsupported` is a gap with its reason; `n/a` means the unit does not apply to
 * Pi and the row says why. A textual-policy row that blocks is `enforced` with
 * `seatbelt: true` and MUST list the bypass classes (F11): it is a seatbelt, not
 * a sandbox, and Pi has no permission system of its own.
 *
 * A row either points at an existing {@link ControlId} (`{ control }`, the state
 * is the control's declaration) or declares itself. A non-`unsupported`,
 * non-`n/a` direct row carries `evidence`, `pi-extension:<event>` while the
 * extension is the only mechanism (the inventory test checks the event exists in
 * the extension source); `unsupported` and `n/a` rows carry none.
 */

export type PiParityState = "enforced" | "advisory" | "unsupported" | "n/a";

/** A row that declares itself (the state is not borrowed from a control). */
export interface PiDirectParity {
  readonly state: PiParityState;
  /** Textual-policy enforcement: a seatbelt, never a sandbox. Requires {@link bypass}. */
  readonly seatbelt?: boolean;
  /** The Pi mechanism, or why none applies. */
  readonly mechanism: string;
  /** What the row does NOT guarantee, or the gap's reason. */
  readonly boundary: string;
  /** Bypass classes the row does not see; mandatory on `seatbelt` rows. */
  readonly bypass?: readonly string[];
  /** What proves a non-`unsupported` state, e.g. `pi-extension:tool_call`. */
  readonly evidence?: string;
}

/** A row whose result an existing control already declares for Pi. */
export interface PiControlParity {
  readonly control: ControlId;
  /** Extra note on why the control stands for the unit. */
  readonly boundary?: string;
}

export type PiParity = PiDirectParity | PiControlParity;

/** The bypass classes of every textual-policy seatbelt row (D11, F11). */
export const PI_SEATBELT_BYPASSES: readonly string[] = [
  "sh -c / eval / xargs / obfuscated command",
  "a script written to disk and then executed",
  "pi --no-extensions outside the covered form",
  "write-capable MCP tools of the parent (mcp__github__*)",
  "third-party extensions that mutate the tool input after the Navori handler",
];

/** `kind:id` key a unit is stored under in {@link PI_PARITY}. */
export function piParityKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

/** Whether `row` borrows its state from a control. */
export function isControlRow(row: PiParity): row is PiControlParity {
  return "control" in row;
}

/**
 * The state a row declares: its own, or the one the control declares for Pi
 * (`resolveControl`). A function parameter keeps this module free of a value
 * import of `engine-capabilities.ts`.
 */
export function piParityState(
  row: PiParity,
  resolveControl: (id: ControlId) => PiParityState,
): PiParityState {
  return isControlRow(row) ? resolveControl(row.control) : row.state;
}

/**
 * Why `row` is malformed, as readable issues (empty when valid). Pure so the
 * negative cases are testable without mutating the real table.
 */
export function piParityIssues(row: PiParity): string[] {
  if (isControlRow(row)) return [];
  const issues: string[] = [];
  if (row.seatbelt === true) {
    if (row.state !== "enforced") issues.push("a seatbelt row must be enforced");
    if (row.bypass === undefined || row.bypass.length === 0) {
      issues.push("a seatbelt row needs its bypass list");
    }
  }
  const proves = row.state === "enforced" || row.state === "advisory";
  if (proves && (row.evidence === undefined || row.evidence.length === 0)) {
    issues.push(`a ${row.state} row needs evidence`);
  }
  if (!proves && row.evidence !== undefined) {
    issues.push(`a ${row.state} row must not carry evidence`);
  }
  if (row.mechanism.length === 0 || row.boundary.length === 0) {
    issues.push("a row needs a mechanism and a boundary");
  }
  return issues;
}

/**
 * Keys of `inventory` that `parity` has no row for (R1). Pure, so the negative
 * case ("a unit without a row fails, naming it") needs no mutation of the table.
 */
export function missingPiParityUnits(
  inventory: readonly string[],
  parity: Readonly<Record<string, PiParity>> = PI_PARITY,
): string[] {
  return inventory.filter((key) => !(key in parity));
}

/**
 * The subset of a plugin manifest that yields parity units. Structural on
 * purpose: the real `PluginManifest` satisfies it and a synthetic one in a test
 * needs no schema parse.
 */
export interface PiParityManifest {
  readonly id: string;
  readonly skills?: readonly { readonly id: string }[];
  readonly hooks?: readonly unknown[];
  readonly scripts?: readonly { readonly dest: string }[];
  readonly hookExtensions?: readonly { readonly id: string }[];
  readonly managed?: readonly { readonly id: string }[];
  readonly mcpServer?: unknown;
  readonly settingsFragment?: unknown;
  readonly prompts?: readonly { readonly key: string }[];
}

/**
 * Every parity unit key one plugin manifest contributes (D11): `skills[]`,
 * `hooks[]` by ordinal, `scripts[]`, `hookExtensions[]`, `managed[]`,
 * `mcpServer`, `settingsFragment` and `prompts[]`. `plugin-script` ids match the
 * `OVERLAP_ROWS` ones (`<plugin>/<dest>`).
 */
export function pluginParityUnits(manifest: PiParityManifest): string[] {
  const { id } = manifest;
  return [
    ...(manifest.skills ?? []).map((s) => piParityKey("plugin-skill", `${id}/${s.id}`)),
    ...(manifest.hooks ?? []).map((_, i) => piParityKey("plugin-hook", `${id}/${i}`)),
    ...(manifest.scripts ?? []).map((s) => piParityKey("plugin-script", `${id}/${s.dest}`)),
    ...(manifest.hookExtensions ?? []).map((h) =>
      piParityKey("plugin-hook-extension", `${id}/${h.id}`),
    ),
    ...(manifest.managed ?? []).map((m) => piParityKey("plugin-managed", `${id}/${m.id}`)),
    ...(manifest.mcpServer === undefined ? [] : [piParityKey("plugin-mcp-server", id)]),
    ...(manifest.settingsFragment === undefined ? [] : [piParityKey("plugin-settings", id)]),
    ...(manifest.prompts ?? []).map((p) => piParityKey("plugin-prompt", `${id}/${p.key}`)),
  ];
}

// -- row builders ------------------------------------------------------------

const unsupported = (mechanism: string, boundary: string): PiDirectParity => ({
  state: "unsupported",
  mechanism,
  boundary,
});

const notApplicable = (reason: string): PiDirectParity => ({
  state: "n/a",
  mechanism: "does not apply to Pi",
  boundary: reason,
});

const advisory = (mechanism: string, boundary: string, evidence: string): PiDirectParity => ({
  state: "advisory",
  mechanism,
  boundary,
  evidence,
});

const viaControl = (control: ControlId, boundary?: string): PiControlParity => ({
  control,
  ...(boundary === undefined ? {} : { boundary }),
});

/** Why a hook script has no Pi counterpart yet (M1 truth; later milestones flip the row). */
const NO_BRIDGE =
  "Pi runs no Navori hook scripts yet: the project extension has no hook bridge (spec 0048 E1 M2) and no handler for this event";

const hookEntries = (): Array<[string, PiParity]> => {
  const h = (id: string, row: PiParity): [string, PiParity] => [piParityKey("hook", id), row];
  return [
    h("plan-gate", viaControl("plan-gate")),
    h("master-plan-context", viaControl("master-plan")),
    h("implementer-no-markdown", viaControl("markdown-ownership")),
    h("bash-outcome-watch", viaControl("repeat-failure-advice")),
    h("general-purpose-confirm", viaControl("general-purpose-confirm")),
    h("subagent-stop-handoff", viaControl("handoff-shape")),
    h(
      "session-start-context",
      advisory(
        "the extension's session_start handler injects the live session context",
        "context only, not a boundary; the injection is skipped on any error",
        "pi-extension:session_start",
      ),
    ),
    h(
      "master-accept-confirm",
      advisory(
        "the extension's tool_call handler asks the operator to confirm a bash command that carries `--approved-by`, and blocks it without UI or on denial",
        "covers only the `--approved-by` forms: `navori master close` and the delivery-review/decision/publication/revoke forms are not asked about; indirect shell forms bypass it. The full command set is spec 0048 E1 M6",
        "pi-extension:tool_call",
      ),
    ),
    h(
      "routing-watch",
      unsupported(
        "none today. Evaluated against Pi 1.1.0 (spec 0048 D11): the signal exists in `tool_result` (edit/write path, `navori_subagent` call), but the script keys on Claude tool names. Probe: with 4 distinct files, tool_name `Edit` makes it emit its additionalContext note and the Pi name `edit` emits nothing",
        "Becomes `advisory` only once the bridge maps Pi tool names and payload fields to the script's contract and turns its additionalContext into an appended result block (spec 0048 E1 M2/E3); never blocks",
      ),
    ),
    h(
      "model-advisor",
      unsupported(
        "none: the script reads the Claude model-change contract (host-contracts.ts)",
        "In Pi the model is chosen with `/model` and passed to children (spec 0047 R17); there is no per-turn model-change payload to advise on",
      ),
    ),
    h(
      "guard-destructive",
      unsupported(
        NO_BRIDGE,
        "No destructive-command or deny-rule guard runs in Pi bash today (spec 0048 R2, M3)",
      ),
    ),
    h(
      "subagent-no-background",
      unsupported(
        NO_BRIDGE,
        "A child can launch `cmd &`, nohup, setsid or disown unblocked today (spec 0048 R8, M7)",
      ),
    ),
    h(
      "managed-drift-watch",
      unsupported(
        NO_BRIDGE,
        "No drift warning is appended to Pi tool results today (spec 0048 R9, M3)",
      ),
    ),
    h(
      "worktree-reclaim",
      unsupported(
        NO_BRIDGE,
        "The extension has no session-end handler, so no worktree is reclaimed on Pi close (spec 0048 R10, M9)",
      ),
    ),
    h(
      "audit-mode-trigger",
      unsupported(NO_BRIDGE, "Pi never opens an audit-mode log (spec 0048 R10, M9)"),
    ),
    h(
      "audit-mode-close",
      unsupported(NO_BRIDGE, "Pi never seals an audit-mode log (spec 0048 R10, M9)"),
    ),
    h(
      "comment-draft-confirm",
      unsupported(
        NO_BRIDGE,
        "Publishing a comment or review from Pi bash asks for no confirmation today (spec 0048 R5, M6)",
      ),
    ),
    h(
      "pr-publisher-confirm",
      unsupported(
        NO_BRIDGE,
        "`gh pr create` and similar publishing commands ask for no confirmation in Pi today (spec 0048 R5, M6)",
      ),
    ),
    h(
      "quality-gate-pre-commit",
      unsupported(
        NO_BRIDGE,
        "`git commit` and `git push` run no quality gate in Pi today (spec 0048 R4, M6)",
      ),
    ),
    h(
      "stop-verify-reminder",
      unsupported(
        NO_BRIDGE,
        "No end-of-turn verification reminder is appended in Pi (spec 0048 R11, M9)",
      ),
    ),
    h(
      "role-guard",
      notApplicable(
        "Codex-only: Claude and Pi restrict roles by their tool allowlist, not a hook (HOOK_ENGINES)",
      ),
    ),
    h(
      "engram-write-guard",
      notApplicable(
        "Codex-only: Pi children run with `--no-mcp`, so there are no engram grants to guard (child-mcp-grants is deferred)",
      ),
    ),
  ];
};

const permissionRuleEntries = (): Array<[string, PiParity]> => {
  const p = (id: string, row: PiParity): [string, PiParity] => [
    piParityKey("permission-rule", id),
    row,
  ];
  const NO_PERMISSIONS =
    "Pi 1.1.0 has no permission system (security.md); the shared rules are enforced by nothing in Pi today (spec 0048 R2/R18, M3/M6)";
  return [
    p("class:bash-ask", unsupported("none", NO_PERMISSIONS)),
    p("class:bash-deny", unsupported("none", NO_PERMISSIONS)),
    p(
      "class:allow-not-translated",
      notApplicable(
        "Pi has no permission system, so there is no allow list to translate (same as Codex)",
      ),
    ),
    p(
      "class:prompt-amendment",
      notApplicable("Codex-only persistent 'do not ask again' amendment; Pi has no prompt rules"),
    ),
    ...DROPPED_PERMISSION_PATTERNS.map((pattern) =>
      p(
        `dropped:${pattern}`,
        notApplicable(
          "Pi's roster has no orchestrator role to dispatch, so there is nothing to forbid",
        ),
      ),
    ),
    ...NARROWED_PATTERN_FAMILIES.flatMap(({ id, patterns }) =>
      patterns.map((pattern) =>
        p(`narrowed:${pattern}`, unsupported("none", `${NO_PERMISSIONS}; family ${id}`)),
      ),
    ),
  ];
};

/** Why a plugin unit does not reach Pi today. */
const NO_PLUGINS =
  "renderPiEngine builds the adapter context with `plugins: []` (spec 0048 R12/R13, M10)";

const pluginEntries = (): Array<[string, PiParity]> => {
  const skill = (plugin: string, id: string, target: string): [string, PiParity] => [
    piParityKey("plugin-skill", `${plugin}/${id}`),
    unsupported(
      "none",
      `${NO_PLUGINS}; the skill injected into ${target} is not emitted by Pi (when Codex is also active, it writes .agents/skills itself)`,
    ),
  ];
  const managed = (plugin: string, id: string): [string, PiParity] => [
    piParityKey("plugin-managed", `${plugin}/${id}`),
    unsupported(
      "none",
      `${NO_PLUGINS}; Pi owns no AGENTS.md, so the block reaches Pi only through the Codex or agents-md owner of that file`,
    ),
  ];
  const settings = (plugin: string): [string, PiParity] => [
    piParityKey("plugin-settings", plugin),
    notApplicable(
      "only `allow` rules: Pi has no permission system and does not translate allow, as Codex",
    ),
  ];
  const script = (plugin: string, dest: string): [string, PiParity] => [
    piParityKey("plugin-script", `${plugin}/${dest}`),
    unsupported("none", `${NO_PLUGINS}; no .pi/navori/scripts copy exists`),
  ];
  const hook = (plugin: string, ordinal: number): [string, PiParity] => [
    piParityKey("plugin-hook", `${plugin}/${ordinal}`),
    unsupported("none", `${NO_PLUGINS}; ${NO_BRIDGE}`),
  ];
  const mcp = (plugin: string): [string, PiParity] => [
    piParityKey("plugin-mcp-server", plugin),
    advisory(
      "render warns when the plugin's MCP server is missing or disabled in Pi's native MCP config, with the `pi mcp add` action",
      "configured is not connected: --no-mcp, -builtin:mcp and extensions replacing the native MCP are not detected; only server names and `enabled` are read. Navori never writes Pi MCP config",
      "render:mcp-diagnosis",
    ),
  ];
  return [
    managed("acli", "acli-protocol"),
    settings("acli"),
    skill("acli", "acli-comment-channel-publisher", "publisher.md"),
    managed("codegraph", "codegraph-search-v2"),
    mcp("codegraph"),
    settings("codegraph"),
    ...["orchestrator", "implementer", "reviewer", "auditor", "architect"].map((role) =>
      skill("codegraph", `codegraph-access-v2-${role}`, `${role}.md`),
    ),
    mcp("engram"),
    settings("engram"),
    ...["orchestrator", "implementer", "reviewer", "auditor"].map((role) =>
      skill("engram", `engram-${role}-extension`, `${role}.md`),
    ),
    settings("gh"),
    skill("gh", "gh-comment-channel-publisher", "publisher.md"),
    settings("jscpd"),
    script("jscpd", "check-jscpd.sh"),
    hook("jscpd", 0),
    skill("jscpd", "jscpd-review-extension", "the review-diff skill"),
    settings("semgrep"),
    script("semgrep", "check-semgrep.sh"),
    hook("semgrep", 0),
    skill("semgrep", "semgrep-review-extension", "the security-invariants skill"),
    managed("tgrep", "tgrep-search-v2"),
    settings("tgrep"),
    script("tgrep", "guard-search-routing.sh"),
    [
      piParityKey("plugin-hook-extension", "tgrep/tgrep-search-lane"),
      unsupported("none", `${NO_PLUGINS}; its target guard-destructive has no Pi copy to extend`),
    ],
  ];
};

/**
 * One parity row per unit, keyed `kind:id` (R1). Listed explicitly, never
 * defaulted: `pi-parity.test.ts` compares the keys with the real inventory, so a
 * unit added without a row (or a row left behind) fails naming it.
 */
export const PI_PARITY: Readonly<Record<string, PiParity>> = Object.freeze(
  Object.fromEntries<PiParity>([...hookEntries(), ...permissionRuleEntries(), ...pluginEntries()]),
);
