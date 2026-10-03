import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { codexHome } from "./home.ts";
import {
  codexHookCommand,
  type ResolvedCodexHook,
} from "../../engines/codex/hook-registrations.ts";

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

/**
 * The `[hooks.state."<key>"]` key Codex writes to `~/.codex/config.toml`
 * (spec 0035 D9; `hooks/src/engine/discovery.rs`): the absolute path of the
 * PROJECT's `.codex/config.toml`, the snake_case event, the group index
 * (position of this `[[hooks.<Event>]]` block among the OTHERS of that same
 * event, in render order) and the handler index (position within THIS
 * block's `.hooks[]` — always 0 for navori, which never emits more than one
 * handler per block). Verified against this repo's own real
 * `~/.codex/config.toml` entries (see the workplan/encargo) before writing
 * this function.
 */
export function codexHookKey(
  configTomlPath: string,
  event: string,
  groupIndex: number,
  handlerIndex: number,
): string {
  const eventName = EVENT_SNAKE_CASE[event];
  if (!eventName) {
    throw new Error(`codexHookKey: unknown Codex event "${event}"`);
  }
  return `${configTomlPath}:${eventName}:${groupIndex}:${handlerIndex}`;
}

export type CodexHookTrustStatus = "Trusted" | "Modified" | "Untrusted";

/** One hook's approval state, plus what it takes to fix a non-`Trusted` one. */
export interface CodexHookTrustEntry {
  readonly script: string;
  readonly event: string;
  readonly matcher?: string;
  readonly key: string;
  readonly expectedHash: string;
  readonly status: CodexHookTrustStatus;
}

/** D10 — the trust state of one project's `.codex/config.toml` against
 *  `~/.codex/config.toml`, computed read-only. */
export interface CodexTrustState {
  readonly configTomlPath: string;
  readonly projectRoot: string;
  /** `[projects."<projectRoot>"] trust_level = "trusted"` — Codex loads
   *  NOTHING from the project (not even AGENTS.md) while this is false. */
  readonly projectTrusted: boolean;
  readonly hooks: readonly CodexHookTrustEntry[];
}

interface ParsedCodexHomeConfig {
  projects?: Record<string, { trust_level?: string }>;
  hooks?: { state?: Record<string, { trusted_hash?: string }> };
}

/** Reads and parses `~/.codex/config.toml`. Unparseable is treated exactly
 *  like absent (D10): guessing trust from broken TOML would be worse than
 *  reporting everything `Untrusted`. */
function readCodexHomeConfig(path: string): ParsedCodexHomeConfig | null {
  if (!existsSync(path)) return null;
  try {
    return parseToml(readFileSync(path, "utf-8")) as ParsedCodexHomeConfig;
  } catch {
    return null;
  }
}

/** Default location of Codex's machine-global trust store. */
export function defaultCodexHomeConfigPath(): string {
  return join(codexHome(), "config.toml");
}

/** Fail closed when the project TOML no longer contains the proposed positional hooks. */
export function projectCodexHooksMatch(
  configTomlPath: string,
  hooks: readonly ResolvedCodexHook[],
  wsSubpath = "",
): boolean {
  if (!existsSync(configTomlPath)) return false;
  try {
    const parsed: unknown = parseToml(readFileSync(configTomlPath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || !("hooks" in parsed)) return false;
    const groups = parsed.hooks;
    if (typeof groups !== "object" || groups === null) return false;
    const actual: Array<{
      event: string;
      matcher?: string;
      command: string;
      timeout: number;
      statusMessage?: string;
    }> = [];
    for (const [event, entries] of Object.entries(groups)) {
      if (!Array.isArray(entries)) return false;
      for (const entry of entries) {
        if (
          typeof entry !== "object" ||
          entry === null ||
          !Array.isArray(entry.hooks) ||
          entry.hooks.length !== 1
        )
          return false;
        const handler: unknown = entry.hooks[0];
        if (
          typeof handler !== "object" ||
          handler === null ||
          !("command" in handler) ||
          !("timeout" in handler)
        )
          return false;
        if (
          !("type" in handler) ||
          handler.type !== "command" ||
          typeof handler.command !== "string" ||
          typeof handler.timeout !== "number"
        )
          return false;
        actual.push({
          event,
          matcher: typeof entry.matcher === "string" ? entry.matcher : undefined,
          command: handler.command,
          timeout: handler.timeout,
          statusMessage:
            "statusMessage" in handler && typeof handler.statusMessage === "string"
              ? handler.statusMessage
              : undefined,
        });
      }
    }
    const expected = [...new Set(hooks.map((hook) => hook.event))].flatMap((event) =>
      hooks
        .filter((hook) => hook.event === event)
        .map((hook) => ({
          event: hook.event,
          matcher: hook.matcher,
          command: codexHookCommand(hook, wsSubpath),
          timeout: hook.timeout,
          statusMessage: hook.statusMessage,
        })),
    );
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

/**
 * D10 — compares what `resolveCodexHooks` would register against
 * `~/.codex/config.toml`, hashing exactly like Codex does (`codexHookHash`).
 * Read-only: never writes, never spawns Codex, so `doctor` and the render
 * next-step hint stay fast and work without Codex installed. `hooks` MUST be
 * `resolveCodexHooks(config)`'s output for the SAME render (this function
 * does not resolve it itself, to keep it dependency-free and easy to test).
 */
export function readCodexTrustState(
  projectRoot: string,
  configTomlPath: string,
  hooks: readonly ResolvedCodexHook[],
  options: { codexHomeConfigPath?: string; wsSubpath?: string } = {},
): CodexTrustState {
  const homeConfigPath = options.codexHomeConfigPath ?? defaultCodexHomeConfigPath();
  const parsed = readCodexHomeConfig(homeConfigPath);
  const projectTrusted = parsed?.projects?.[projectRoot]?.trust_level === "trusted";
  const groupIndexByEvent = new Map<string, number>();
  const hookEntries: CodexHookTrustEntry[] = hooks.map((hook) => {
    const groupIndex = groupIndexByEvent.get(hook.event) ?? 0;
    groupIndexByEvent.set(hook.event, groupIndex + 1);
    const key = codexHookKey(configTomlPath, hook.event, groupIndex, 0);
    const expectedHash = codexHookHash(hook, codexHookCommand(hook, options.wsSubpath));
    const storedHash = parsed?.hooks?.state?.[key]?.trusted_hash;
    const status: CodexHookTrustStatus =
      storedHash === undefined ? "Untrusted" : storedHash === expectedHash ? "Trusted" : "Modified";
    return {
      script: hook.script,
      event: hook.event,
      matcher: hook.matcher,
      key,
      expectedHash,
      status,
    };
  });
  return { configTomlPath, projectRoot, projectTrusted, hooks: hookEntries };
}

/** Whether `line` assigns `field` (`  field = ...`) — a plain string check
 *  (no `RegExp` built from a variable — semgrep's non-literal-regexp rule) so
 *  the field name never has to be escaped in the first place. */
function isFieldAssignment(line: string, field: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith(field)) return false;
  return /^\s*=/.test(trimmed.slice(field.length));
}

/** TOML basic-string quoting for a table header/key. Matches the `tomlString`
 *  helper `build-config-toml.ts` already uses for the same purpose. */
function tomlQuote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Bounded edit of ONE `field = value` line inside `[header]` (D9): if the
 * table already exists, only its `field` line changes — every other byte,
 * table and comment in the file survives untouched. If it doesn't, the table
 * is appended at the end. Never reserializes the file; `planTrustEdit`'s
 * caller validates the RESULT with `isValidToml` and must abort without
 * writing if that fails.
 */
function setTableField(
  text: string,
  header: string,
  field: string,
  value: string,
): { text: string; changed: boolean } {
  const headerLine = `[${header}]`;
  const lines = text.split("\n");
  const headerIdx = lines.findIndex((l) => l.trim() === headerLine);
  const fieldLine = `${field} = ${tomlQuote(value)}`;
  if (headerIdx === -1) {
    const out = [...lines];
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    out.push("", headerLine, fieldLine);
    return { text: `${out.join("\n")}\n`, changed: true };
  }
  let end = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  let fieldIdx = -1;
  for (let i = headerIdx + 1; i < end; i++) {
    if (isFieldAssignment(lines[i] ?? "", field)) {
      fieldIdx = i;
      break;
    }
  }
  if (fieldIdx !== -1) {
    if (lines[fieldIdx] === fieldLine) return { text, changed: false };
    lines[fieldIdx] = fieldLine;
  } else {
    lines.splice(headerIdx + 1, 0, fieldLine);
  }
  return { text: lines.join("\n"), changed: true };
}

export interface TrustEditPlan {
  readonly text: string;
  /** False when `state` was already fully approved — the caller must not
   *  write or back up (D9's idempotent exit). */
  readonly changed: boolean;
}

/**
 * The full new content of `~/.codex/config.toml` after approving `state`'s
 * project (if needed) and every hook not already `Trusted`. Pure text edit —
 * `isValidToml` on the result is the caller's gate before writing.
 */
export function planTrustEdit(rawText: string, state: CodexTrustState): TrustEditPlan {
  let text = rawText;
  let changed = false;
  if (!state.projectTrusted) {
    const r = setTableField(
      text,
      `projects.${tomlQuote(state.projectRoot)}`,
      "trust_level",
      "trusted",
    );
    text = r.text;
    changed = changed || r.changed;
  }
  for (const hook of state.hooks) {
    if (hook.status === "Trusted") continue;
    const r = setTableField(
      text,
      `hooks.state.${tomlQuote(hook.key)}`,
      "trusted_hash",
      hook.expectedHash,
    );
    text = r.text;
    changed = changed || r.changed;
  }
  return { text, changed };
}

/** True when `text` parses as valid TOML — the gate `planTrustEdit`'s result
 *  must pass before anything is written to `~/.codex/config.toml` (D9). */
export function isValidToml(text: string): boolean {
  try {
    parseToml(text);
    return true;
  } catch {
    return false;
  }
}
