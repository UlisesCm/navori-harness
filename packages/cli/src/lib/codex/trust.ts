import { createHash } from "node:crypto";
import type { ResolvedCodexHook } from "../../engines/codex/hook-registrations.ts";

/**
 * Codex TOML event name → the `snake_case` `event_name` Codex's own hash
 * algorithm hashes (`hooks/src/engine/discovery.rs`). A table, not a regex:
 * Codex's event names don't follow one mechanical rule (`SubagentStop` →
 * `subagent_stop` looks regular, but the algorithm is Codex's, not ours to
 * derive — pinning the literal mapping is what the golden-hash test in
 * spec 0035 T1 (Lote A) actually protects).
 */
const EVENT_SNAKE_CASE: Readonly<Record<string, string>> = {
  PreToolUse: "pre_tool_use",
  PostToolUse: "post_tool_use",
  SessionStart: "session_start",
  SessionEnd: "session_end",
  UserPromptSubmit: "user_prompt_submit",
  Stop: "stop",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  Interrupt: "interrupt",
  PermissionRequest: "permission_request",
};

/** Recursively sort object keys and produce compact JSON — the exact
 *  canonicalization Codex's `config/src/fingerprint.rs` hashes. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Reimplements Codex's `trusted_hash` algorithm (spec 0035 D9;
 * `hooks/src/engine/discovery.rs` + `config/src/fingerprint.rs`):
 * `"sha256:" + sha256` of the compact, sorted-keys JSON of
 * `{event_name, matcher?, hooks:[{type:"command", command, timeout,
 * async:false, statusMessage?}]}`. `hook` is the ALREADY-INTERPOLATED
 * registration (the exact `command` string `.codex/config.toml` writes),
 * not the table row — the hash covers what Codex actually reads, hookBase
 * and all.
 *
 * A test pins this against the 4 real hashes Codex 0.157 wrote for this
 * repo's `.codex/config.toml` (spec 0035 T1); if Codex ever changes its
 * algorithm, that golden test is the tripwire (D10's failure mode).
 */
export function codexHookHash(hook: ResolvedCodexHook, command: string): string {
  const eventName = EVENT_SNAKE_CASE[hook.event];
  if (!eventName) {
    throw new Error(`codexHookHash: unknown Codex event "${hook.event}"`);
  }
  const registration: Record<string, unknown> = {
    event_name: eventName,
    hooks: [
      {
        type: "command",
        command,
        timeout: hook.timeout,
        async: false,
        ...(hook.statusMessage !== undefined ? { statusMessage: hook.statusMessage } : {}),
      },
    ],
    ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
  };
  const digest = createHash("sha256").update(canonicalJson(registration)).digest("hex");
  return `sha256:${digest}`;
}
