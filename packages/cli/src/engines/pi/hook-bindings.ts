import type { NavoriConfig } from "../../lib/config/config.ts";

/**
 * Spec 0048 D1/D2: the single table of the shared hook scripts Pi runs, one row per script.
 * `placeHook` copies exactly these scripts to `.pi/navori/hooks/<script>.sh` and the manifest
 * (`.pi/navori.json` v2 `hooks`) is derived from the same rows, so what is installed, what the
 * extension bridge runs and what the manifest declares cannot drift apart.
 *
 * Bridge contract (implemented in `bridge-source.ts`, documented in `docs/pi.md`):
 * - The extension sends a Claude-shaped payload (`hook_event_name`, `tool_name` `Bash|Edit|Write`,
 *   `tool_input`, `cwd`, `session_id`, `permission_mode`, plus `agent_id`/`agent_type` in children).
 *   The copy identifies itself as Pi by its path (`/.pi/navori/`), never by the payload.
 * - Scripts run under bash (never the project's `shellPath`), concurrently, each with its own timeout.
 * - Only a stdout JSON object (`hookSpecificOutput` or `systemMessage`) and the exit code carry a
 *   verdict; any other stdout is noise. Stderr is kept as head + tail for diagnostics.
 * - `enforced` fails closed (unknown JSON, exit other than 0/2, signal, timeout, missing bash,
 *   unreadable manifest block the tool); `advisory` and `lifecycle` failures are silent.
 *
 * Rows are added by the milestone that wires each guard (spec 0048 M3 and later), together with its
 * `PI_PARITY` row: a script is never listed here before Pi can honor its verdict end to end. The
 * `PI_PARITY` row of a script listed here is never `unsupported` (and the other way round).
 */

/** Pi events the bridge dispatches. */
export type PiBridgeEvent =
  | "tool_call"
  | "tool_result"
  | "agent_before_settle"
  | "session_shutdown";

/** Which Pi thread runs the script. */
export type PiBridgeScope = "parent" | "child" | "all";

/** `enforced` blocks (fail-closed), `advisory` warns (fail-open), `lifecycle` only runs on session events. */
export type PiBridgeClass = "enforced" | "advisory" | "lifecycle";

/** One row of {@link PI_HOOK_BINDINGS}. */
export interface PiHookBinding {
  /** Hook script id, without extension: the asset is `core-assets/hooks/<script>.sh`. */
  readonly script: string;
  readonly on: PiBridgeEvent;
  /** Pi tool names the row matches (`bash`, `edit`, `write`); absent = every tool of the event. */
  readonly tools?: readonly string[];
  readonly scope: PiBridgeScope;
  readonly class: PiBridgeClass;
  /** The script may answer `ask`; the bridge then serializes the user confirmation. */
  readonly interactive: boolean;
  /** Per-script deadline; a timeout is a block for `enforced` and silence otherwise. */
  readonly timeoutMs: number;
  /** Installed only when this returns true; always installed when absent. */
  readonly when?: (config: NavoriConfig) => boolean;
}

/** The scripts Pi runs through the extension bridge. */
export const PI_HOOK_BINDINGS: readonly PiHookBinding[] = [
  // Spec 0048 T4 (R2, R18): destructive commands, shared `deny` rules, the Pi control plane and
  // `pi --no-extensions`, for the parent and every child. It never asks (`ask` rules are T11).
  {
    script: "guard-destructive",
    on: "tool_call",
    tools: ["bash"],
    scope: "all",
    class: "enforced",
    interactive: false,
    timeoutMs: 15_000,
  },
  // Spec 0048 T12/R8: a child never backgrounds work (`cmd &`, nohup, setsid, disown). The script
  // keys on `agent_id`, which the bridge sends only in children, so the parent is never in scope.
  {
    script: "subagent-no-background",
    on: "tool_call",
    tools: ["bash"],
    scope: "child",
    class: "enforced",
    interactive: false,
    timeoutMs: 10_000,
  },
  // Spec 0048 T6 (R9): a managed block left with drift after bash, edit or write. Advisory: its
  // exit 2 + stderr becomes a notice appended to the tool result, never a block.
  {
    script: "managed-drift-watch",
    on: "tool_result",
    tools: ["bash", "edit", "write"],
    scope: "all",
    class: "advisory",
    interactive: false,
    timeoutMs: 10_000,
  },
  // Spec 0048 R10 (D8): parent session close, 15 s in total (reclaim 12 s, then the audit seal 3 s).
  {
    script: "worktree-reclaim",
    on: "session_shutdown",
    scope: "parent",
    class: "lifecycle",
    interactive: false,
    timeoutMs: 12_000,
  },
  {
    script: "audit-mode-close",
    on: "session_shutdown",
    scope: "parent",
    class: "lifecycle",
    interactive: false,
    timeoutMs: 3_000,
  },
  // Spec 0048 R11 (D8): advisory (its text is appended, never blocks); opt-in like Claude's Stop hook.
  {
    script: "stop-verify-reminder",
    on: "agent_before_settle",
    scope: "parent",
    class: "advisory",
    interactive: false,
    timeoutMs: 10_000,
    when: (config) => Boolean(config.hooks?.verifyOnStop),
  },
];

/** Destination of a script copy, relative to the project root, always with `/` separators. */
export function piHookPath(script: string): string {
  return `.pi/navori/hooks/${script}.sh`;
}

/** Rows installed for `config`, in table order. `bindings` is a parameter only so tests can inject rows. */
export function activePiHookBindings(
  config: NavoriConfig,
  bindings: readonly PiHookBinding[] = PI_HOOK_BINDINGS,
): readonly PiHookBinding[] {
  return bindings.filter((binding) => binding.when === undefined || binding.when(config));
}
