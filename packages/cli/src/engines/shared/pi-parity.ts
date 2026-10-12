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

const seatbelt = (mechanism: string, boundary: string, evidence: string): PiDirectParity => ({
  state: "enforced",
  seatbelt: true,
  mechanism,
  boundary,
  bypass: PI_SEATBELT_BYPASSES,
  evidence,
});

const viaControl = (control: ControlId, boundary?: string): PiControlParity => ({
  control,
  ...(boundary === undefined ? {} : { boundary }),
});

/** Why the audit-mode trigger has no Pi counterpart: the bridge does not map it. */
const NO_BRIDGE =
  "the extension bridge runs other Navori hook scripts but has no handler that opens an audit-mode log; Pi's audit capture is the one of spec 0047 R12";

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
      seatbelt(
        "the extension's tool_call handler runs the Pi copy of the script (`.pi/navori/hooks/master-accept-confirm.sh`) under bash for the parent and every child; its `ask` needs the operator's confirmation in the interactive parent (the native dialog), and is refused without UI or on denial. A child is refused and the exact command is relayed to the parent (PI_HOOK_BINDINGS). The extension additionally asks for any command that carries `--approved-by`",
        "covers `navori master part|delivery-baseline|delivery-queue|delivery-criterion … --approved-by`, `master close`, `delivery-review|decision|publication|revoke` and `delivery-slice --refresh`; indirect shell forms (`sh -c`, a script on disk) bypass it. The confirmation is a seatbelt, not a sandbox",
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
      seatbelt(
        "the extension's tool_call handler runs the Pi copy of the script (`.pi/navori/hooks/guard-destructive.sh`) under bash for the parent and every child; exit 2 blocks the call before it runs (PI_HOOK_BINDINGS)",
        "textual policy over the command string: the destructive rules of the shared script, the shared `deny` permission rules, writes to the Pi control plane (`.pi/navori/**`, `.pi/extensions/**`, `.pi/settings.json`, `.pi/navori.json`) and `pi --no-extensions`. The shared `ask` rules answer `ask` (their own row)",
        "pi-extension:tool_call",
      ),
    ),
    h(
      "subagent-no-background",
      seatbelt(
        "the extension's tool_call handler runs the Pi copy of the script for children only (`agent_id` is sent only there); it blocks `cmd &`, nohup, setsid and disown",
        "textual policy over the command string, children only: the parent may background work",
        "pi-extension:tool_call",
      ),
    ),
    h(
      "managed-drift-watch",
      advisory(
        "the extension's tool_result handler runs the Pi copy of the script after bash, edit and write; its exit 2 and stderr become a bounded notice appended to the tool result (own stamp, `.pi/navori` hook copies among its roots)",
        "never blocks, and only sees blocks with a hash marker (AGENTS.md, skills, hook copies); the extension, manifest and role files have no per-block hash and are protected by the guard and the edit/write lane instead. A drift it cannot evaluate is silent",
        "pi-extension:tool_result",
      ),
    ),
    h(
      "worktree-reclaim",
      advisory(
        "the extension's session_shutdown handler (parent only, reason quit or new) runs the shared script under the bridge, 12 s, only when `.claude/worktrees` exists",
        "same bar as Claude (clean, pushed, merged PR) plus: a worktree with ignored files under `.navori/state/` is kept. Pi creates no worktrees; a SIGKILL fires no event and the next close sweeps. Failures are silent",
        "pi-extension:session_shutdown",
      ),
    ),
    h(
      "audit-mode-trigger",
      unsupported(
        NO_BRIDGE,
        "Pi never opens an audit-mode log through this hook (out of scope of spec 0048, design non-goal)",
      ),
    ),
    h(
      "audit-mode-close",
      advisory(
        "the extension's session_shutdown handler (parent only, reason quit or new) runs the shared script after the reclaim, 3 s, with a SessionEnd payload",
        "seals only a log that already exists: Pi never opens an audit-mode log (`audit-mode-trigger` is unsupported), so it is a no-op until one is started. Failures are silent",
        "pi-extension:session_shutdown",
      ),
    ),
    h(
      "comment-draft-confirm",
      seatbelt(
        "the extension's tool_call handler runs the Pi copy of the script for the parent and every child: a comment, review, issue, GraphQL/REST comment write or `acli` comment asks for confirmation showing the draft, bound to the sha256 of the body file (re-checked right before the call is allowed; a changed body is refused). Without UI or on denial it is refused; a child is refused and the exact command is relayed to the parent",
        "a body that is inline or unreadable is shown only as the command; stdin (`-F -`) bodies and a path built by the shell (`$VAR`, `$(…)`) are not shown. A window remains between the check and the exec. Indirect shell forms bypass it",
        "pi-extension:tool_call",
      ),
    ),
    h(
      "pr-publisher-confirm",
      seatbelt(
        "the extension's tool_call handler runs the Pi copy of the script for the parent and every child: a `gh pr create` always asks (the subagent allow of the Claude copy does not apply), showing the body, bound to the sha256 of its body file. Without UI or on denial it is refused; a child (the publisher) is refused and the exact command is relayed to the parent",
        "installed only when the publisher role is enabled; a body that is inline or unreadable is shown only as the command. Indirect shell forms bypass it",
        "pi-extension:tool_call",
      ),
    ),
    h(
      "quality-gate-pre-commit",
      seatbelt(
        "the extension's tool_call handler runs the Pi copy of the script (enforced, parent and children, 600 s) before `git commit` AND `git push`: it runs `qualityGate.fast`, and a red gate, a gate that cannot run or a missing runner blocks (a missing runner asks only where an operator can answer)",
        "only with `qualityGate.fast` configured (no row otherwise, as in Claude and Codex); the result holds for the working tree at that moment. Indirect shell forms (`sh -c`, a script on disk) bypass it; a hook outside the agent (the user's own terminal) is not seen",
        "pi-extension:tool_call",
      ),
    ),
    h(
      "stop-verify-reminder",
      advisory(
        "the extension's agent_before_settle handler (parent only, with hooks.verifyOnStop) appends the script's Spanish reminder as a visible custom_message entry when tracked files are uncommitted",
        "never blocks and never sets `continue`, so no extra model request; one reminder per agent run; a failure shows nothing",
        "pi-extension:agent_before_settle",
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
  return [
    p(
      "class:bash-ask",
      seatbelt(
        "the Pi copy of guard-destructive.sh embeds the shared `ask` rules next to the `deny` ones (same translation as Codex's rules file) and answers `ask` for a segment that starts with a rule's tokens, after every block rule let it through. The extension asks the operator in the interactive parent (one confirmation); without UI or on denial it is refused, and a child is refused and the command relayed to the parent",
        "token prefixes: a pattern with an inner wildcard is dropped and a `*` glued to the last token is narrowed to the exact token (`git clean -f*` asks for `git clean -f`, not `-fd`); a block rule wins over a question",
        "pi-extension:tool_call",
      ),
    ),
    p(
      "class:bash-deny",
      seatbelt(
        "the Pi copy of guard-destructive.sh embeds the shared `deny` rules, translated with the same function as Codex's rules file (translateShellPattern), and blocks a segment that starts with a rule's tokens",
        "token prefixes: a pattern with an inner wildcard or a non-Bash entry is dropped (its own row); a `*` glued to the last token is narrowed to the exact token",
        "pi-extension:tool_call",
      ),
    ),
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
    ...NARROWED_PATTERN_FAMILIES.flatMap(({ id, decision, patterns }) =>
      patterns.map((pattern) =>
        p(
          `narrowed:${pattern}`,
          decision === "forbidden"
            ? seatbelt(
                "the same token-prefix deny rule as Codex, evaluated by the Pi copy of guard-destructive.sh",
                `family ${id}: the prefix matches only the literal target; the numbered rules of the same script (root/home/system rm, --no-preserve-root, mkfs variants) block the other spellings`,
                "pi-extension:tool_call",
              )
            : seatbelt(
                "the same token-prefix ask rule as Codex's prompt rule, evaluated by the Pi copy of guard-destructive.sh: the operator confirms in the parent, a child is refused and relayed",
                `family ${id}: the prefix matches only the literal target (a glued trailing * is narrowed to the exact token)`,
                "pi-extension:tool_call",
              ),
        ),
      ),
    ),
  ];
};

/** Where a plugin's prose and skills reach Pi from (spec 0048 D13, R12). */
const PLUGIN_PROJECTION = "render:plugin-projection";

/** The shared context file: Pi writes it only when neither Codex nor agents-md owns it. */
const CONTEXT_BOUNDARY =
  "Pi writes the AGENTS file (with includePluginBlocks) only when neither Codex nor agents-md owns it; then that owner's output stands. The block is prose: Pi reads it, nothing enforces it";

const pluginEntries = (): Array<[string, PiParity]> => {
  /** A skill extending another skill: a sub-block of Pi's `.agents/skills/<id>/SKILL.md` copy. */
  const skillOnSkill = (plugin: string, id: string, target: string): [string, PiParity] => [
    piParityKey("plugin-skill", `${plugin}/${id}`),
    advisory(
      `sub-block of .agents/skills/${target}/SKILL.md, written by Pi only when Codex is not active`,
      "with Codex active, Codex writes that skill and its sub-block; Pi never duplicates it. The text is guidance, nothing enforces it",
      PLUGIN_PROJECTION,
    ),
  ];
  /** A skill extending the orchestrator: a sub-block of the context file Pi embodies it through. */
  const skillOnOrchestrator = (plugin: string, id: string): [string, PiParity] => [
    piParityKey("plugin-skill", `${plugin}/${id}`),
    advisory(
      "sub-block of the AGENTS file, the main thread's durable guide",
      CONTEXT_BOUNDARY,
      PLUGIN_PROJECTION,
    ),
  ];
  /** A skill extending a child role of an MCP plugin: Pi children run `--no-mcp`, so it is not injected. */
  const skillOnMcpRole = (plugin: string, id: string, role: string): [string, PiParity] => [
    piParityKey("plugin-skill", `${plugin}/${id}`),
    unsupported(
      "none",
      `${plugin} declares an MCP server and Pi children run with --no-mcp, so the ${role} prose is not injected; render names the role (mcpRoleDiagnostics)`,
    ),
  ];
  /** A skill extending the publisher role: prose appended to the role file Pi renders. */
  const skillOnPublisher = (plugin: string, id: string): [string, PiParity] => [
    piParityKey("plugin-skill", `${plugin}/${id}`),
    advisory(
      "prose appended to .pi/agents/publisher.md, the role file Pi renders while the publisher role is enabled",
      "guidance only, nothing enforces it; with the publisher role disabled no role file exists and the prose is not rendered",
      PLUGIN_PROJECTION,
    ),
  ];
  const managed = (plugin: string, id: string): [string, PiParity] => [
    piParityKey("plugin-managed", `${plugin}/${id}`),
    advisory("block of the AGENTS file (includePluginBlocks)", CONTEXT_BOUNDARY, PLUGIN_PROJECTION),
  ];
  const settings = (plugin: string): [string, PiParity] => [
    piParityKey("plugin-settings", plugin),
    notApplicable(
      "only `allow` rules: Pi has no permission system and does not translate allow, as Codex",
    ),
  ];
  /** A plugin script a bridge row runs: Pi's own executable copy under `.pi/navori/scripts`. */
  const runScript = (plugin: string, dest: string): [string, PiParity] => [
    piParityKey("plugin-script", `${plugin}/${dest}`),
    {
      state: "enforced",
      seatbelt: true,
      mechanism: `.pi/navori/scripts/${dest}, run by the extension bridge on tool_call(bash)`,
      boundary:
        "a textual check of the command the model writes, not a sandbox; Pi has no permission system of its own",
      bypass: PI_SEATBELT_BYPASSES,
      evidence: "pi-extension:tool_call",
    },
  ];
  const hook = (plugin: string, ordinal: number): [string, PiParity] => [
    piParityKey("plugin-hook", `${plugin}/${ordinal}`),
    {
      state: "enforced",
      seatbelt: true,
      mechanism:
        "binding of the Pi manifest (PreToolUse/Bash, translated like Codex) run by the extension bridge",
      boundary:
        "enforced only while the extension is loaded; same textual-seatbelt limits as the shared guard",
      bypass: PI_SEATBELT_BYPASSES,
      evidence: "pi-extension:tool_call",
    },
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
    skillOnPublisher("acli", "acli-comment-channel-publisher"),
    managed("codegraph", "codegraph-search-v2"),
    mcp("codegraph"),
    settings("codegraph"),
    skillOnOrchestrator("codegraph", "codegraph-access-v2-orchestrator"),
    ...["implementer", "reviewer", "auditor", "architect"].map((role) =>
      skillOnMcpRole("codegraph", `codegraph-access-v2-${role}`, role),
    ),
    mcp("engram"),
    settings("engram"),
    skillOnOrchestrator("engram", "engram-orchestrator-extension"),
    ...["implementer", "reviewer", "auditor"].map((role) =>
      skillOnMcpRole("engram", `engram-${role}-extension`, role),
    ),
    settings("gh"),
    skillOnPublisher("gh", "gh-comment-channel-publisher"),
    settings("jscpd"),
    runScript("jscpd", "check-jscpd.sh"),
    hook("jscpd", 0),
    skillOnSkill("jscpd", "jscpd-review-extension", "review-diff"),
    settings("semgrep"),
    runScript("semgrep", "check-semgrep.sh"),
    hook("semgrep", 0),
    skillOnSkill("semgrep", "semgrep-review-extension", "security-invariants"),
    managed("tgrep", "tgrep-search-v2"),
    settings("tgrep"),
    [
      piParityKey("plugin-script", "tgrep/guard-search-routing.sh"),
      seatbelt(
        "installed under .pi/navori/scripts beside the Pi copy of guard-destructive, which sources it from the tgrep lane; the bridge runs that copy on every bash call",
        "content search (grep/rg) only; fails open when tgrep is missing, its server is not running or no index exists",
        "pi-extension:tool_call",
      ),
    ],
    [
      piParityKey("plugin-hook-extension", "tgrep/tgrep-search-lane"),
      seatbelt(
        "the lane sub-block rides inside .pi/navori/hooks/guard-destructive.sh; the bridge runs it and its exit 2 blocks the bash call with the `tgrep search` remedy",
        "textual seatbelt over grep/rg segments; fails open (audited as fail-open) while the index is unavailable",
        "pi-extension:tool_call",
      ),
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

/** Stable markers delimiting the generated parity block inside `docs/pi.md` (spec 0048 R1, R17). */
export const PI_PARITY_DOC_START = "<!-- pi-parity:start -->";
export const PI_PARITY_DOC_END = "<!-- pi-parity:end -->";

/**
 * Renders the parity inventory as the Markdown block `docs/pi.md` carries between
 * {@link PI_PARITY_DOC_START} and {@link PI_PARITY_DOC_END} (markers included): one row per unit with its
 * state, its class (a seatbelt row names the shared bypass classes) and its boundary. Mirrors
 * `renderOverlapDoc`; `first-class-e2e.test.ts` fails when the committed doc differs from this output.
 */
export function renderPiParityDoc(
  parity: Readonly<Record<string, PiParity>>,
  resolveControl: (id: ControlId) => PiParityState,
): string {
  const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
  const rows = Object.entries(parity)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, row]) => {
      const state = piParityState(row, resolveControl);
      if (isControlRow(row)) {
        return `| \`${key}\` | ${state} | control \`${row.control}\` | ${cell(row.boundary ?? "—")} |`;
      }
      const kind = row.seatbelt === true ? "seatbelt (bypass classes above)" : "—";
      return `| \`${key}\` | ${state} | ${kind} | ${cell(row.boundary)} |`;
    });
  return [
    PI_PARITY_DOC_START,
    "<!-- Generated from `PI_PARITY` (`packages/cli/src/engines/shared/pi-parity.ts`). Do not edit by hand: `first-class-e2e.test.ts` pins it. -->",
    "",
    "Bypass classes of every seatbelt row (a seatbelt is a textual check, not a sandbox):",
    "",
    ...PI_SEATBELT_BYPASSES.map((bypass) => `- ${cell(bypass)}`),
    "",
    "| Unit | State | Class | Boundary |",
    "|---|---|---|---|",
    ...rows,
    PI_PARITY_DOC_END,
  ].join("\n");
}
