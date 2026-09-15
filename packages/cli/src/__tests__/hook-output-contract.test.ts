import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildClaudeSettings } from "../engines/claude/build-settings.ts";
import { getCoreRoot } from "../lib/bundled-assets.ts";
import { listKnownPluginIds, loadPlugin } from "../lib/plugins.ts";
import type { LoadedPlugin } from "../lib/plugins.ts";
import type { NavoriConfig } from "../lib/config.ts";

/**
 * The OUTPUT-CONTRACT invariant: every JSON field a hook prints to stdout has to
 * be one the event it is registered on actually delivers.
 *
 * This exists because of #774, and the defect is the argument for the file. Four
 * hooks were emitting into channels their event discards:
 *
 *   - `precompact-session-summary.sh` returned
 *     `hookSpecificOutput.additionalContext` under `PreCompact`, an event that
 *     appears nowhere in the host's "where the reminder appears" list. The only
 *     purpose of the hook never arrived once, and its audit line said `inject`.
 *   - `stop-verify-reminder.sh` and `subagent-stop-handoff.sh` asked the MODEL
 *     for an action through `systemMessage`, documented as a warning "shown to
 *     the user" — the reader who could act on it never heard it.
 *   - `worktree-reclaim.sh` reported on `SessionEnd`, whose JSON output fields
 *     the host discards outright.
 *
 * Every one of those shipped green: the behavioural suites feed each script on
 * stdin and assert the JSON it prints, which proves the half that never failed.
 * The half that failed is whether the host delivers that JSON for that event,
 * and nothing asserted it.
 *
 * DERIVED, NOT RESTATED — the same rule `hook-matcher-wiring.test.ts` sets for
 * the input side. The fields are read off the scripts (their own object
 * literals) and the event is read off the registration (`buildClaudeSettings`
 * and each `plugin.json`). The one thing that CANNOT be derived is the host's
 * contract, so the table below carries it — with the verbatim citation per row,
 * which is what makes it auditable instead of a second copy free to drift.
 *
 * The table is FAIL-CLOSED on purpose: a field with no row here is a violation.
 * Adding a channel means adding its citation, which is exactly the review this
 * class of bug needed and did not get.
 */

const HOOKS_ROOT = resolve(getCoreRoot(), "core-assets/hooks");
const PARTIALS_ROOT = resolve(HOOKS_ROOT, "_partials");

/**
 * `qualityGate.fast` and `hooks.verifyOnStop` are both set on purpose: they are
 * the two core hooks registered CONDITIONALLY, and `stop-verify-reminder` is
 * one of the two this issue fixed. A config that left it out would drop it from
 * this file's scope without a word.
 */
const MINIMAL_CONFIG = {
  name: "test",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "pnpm lint" },
  hooks: { verifyOnStop: true },
} as unknown as NavoriConfig;

/* ────────────────────────────────────────────────────────────────────────────
 * The contract, verbatim from `code.claude.com/docs/en/hooks`.
 * ──────────────────────────────────────────────────────────────────────────── */

const CITE = {
  universal:
    '"Universal fields like `continue` are listed in the table below. Every event accepts them, but some events discard them or deliver `systemMessage` somewhere other than the transcript. Each event\'s section says so."',
  systemMessage: '"`systemMessage` — Warning message shown to the user."',
  hookEventName:
    '"`hookSpecificOutput` is a nested object for events that need richer control. It requires a `hookEventName` field set to the event name."',
  additionalContextEvents:
    '"Where the reminder appears depends on the event: SessionStart and SubagentStart … UserPromptSubmit and UserPromptExpansion … PreToolUse, PostToolUse, PostToolUseFailure, and PostToolBatch … Stop and SubagentStop … PostModelSwitch." (PreCompact and SessionEnd are absent from that list.)',
  topLevelDecision:
    '"UserPromptSubmit, UserPromptExpansion, PostToolUse, PostToolUseFailure, PostToolBatch, Stop, SubagentStop, ConfigChange, PreCompact → Top-level `decision` → `decision: \\"block\\"`, `reason`."',
  stopAdditionalContext:
    '"Stop and SubagentStop also accept `hookSpecificOutput.additionalContext` for non-error feedback that continues the conversation."',
  preToolUse:
    '"PreToolUse → `hookSpecificOutput` → `permissionDecision` (allow/deny/ask/defer), `permissionDecisionReason`."',
  sessionStart:
    '"SessionStart, SubagentStart, PostModelSwitch → Context only → `hookSpecificOutput.additionalContext` adds context for Claude. SessionStart also accepts `initialUserMessage`, `watchPaths`, `sessionTitle`, and `reloadSkills`. No blocking or decision control."',
  rewrite:
    "\"`PreToolUse`: `updatedInput` directly under `hookSpecificOutput` replaces a tool's arguments before it runs. … `PostToolUse`: `updatedToolOutput` replaces the tool's result.\"",
  preCompactDiscards:
    '"Claude Code discards a PreCompact hook\'s `systemMessage` and `continue` fields."',
  sessionEndDiscards:
    '"SessionEnd hooks have no decision control. They can\'t block session termination but can perform cleanup tasks. Claude Code discards their JSON output fields, such as `systemMessage`."',
} as const;

/** field name → the citation that licenses it. */
type FieldTable = Readonly<Record<string, string>>;

interface EventContract {
  /** Fields the host reads directly off the emitted object. */
  topLevel: FieldTable;
  /** Fields the host reads inside `hookSpecificOutput`. */
  hookSpecificOutput: FieldTable;
}

/** Accepted by every event, minus whatever an event's own section discards. */
const UNIVERSAL: FieldTable = {
  continue: CITE.universal,
  stopReason: CITE.universal,
  suppressOutput: CITE.universal,
  terminalSequence: CITE.universal,
  systemMessage: CITE.systemMessage,
};

const DECISION: FieldTable = {
  decision: CITE.topLevelDecision,
  reason: CITE.topLevelDecision,
};

const EVENT_NAME: FieldTable = { hookEventName: CITE.hookEventName };

const CONTRACT: Readonly<Record<string, EventContract>> = {
  SessionStart: {
    topLevel: UNIVERSAL,
    hookSpecificOutput: {
      ...EVENT_NAME,
      additionalContext: CITE.sessionStart,
      initialUserMessage: CITE.sessionStart,
      watchPaths: CITE.sessionStart,
      sessionTitle: CITE.sessionStart,
      reloadSkills: CITE.sessionStart,
    },
  },
  UserPromptSubmit: {
    topLevel: { ...UNIVERSAL, ...DECISION },
    hookSpecificOutput: { ...EVENT_NAME, additionalContext: CITE.additionalContextEvents },
  },
  PreToolUse: {
    topLevel: UNIVERSAL,
    hookSpecificOutput: {
      ...EVENT_NAME,
      permissionDecision: CITE.preToolUse,
      permissionDecisionReason: CITE.preToolUse,
      additionalContext: CITE.additionalContextEvents,
      updatedInput: CITE.rewrite,
    },
  },
  PostToolUse: {
    topLevel: { ...UNIVERSAL, ...DECISION },
    hookSpecificOutput: {
      ...EVENT_NAME,
      additionalContext: CITE.additionalContextEvents,
      updatedToolOutput: CITE.rewrite,
    },
  },
  Stop: {
    topLevel: { ...UNIVERSAL, ...DECISION },
    hookSpecificOutput: { ...EVENT_NAME, additionalContext: CITE.stopAdditionalContext },
  },
  SubagentStop: {
    topLevel: { ...UNIVERSAL, ...DECISION },
    hookSpecificOutput: { ...EVENT_NAME, additionalContext: CITE.stopAdditionalContext },
  },
  /**
   * PreCompact keeps `decision`/`reason` and NOTHING else. The two universal
   * fields the doc names as discarded are gone by citation; the rest are gone
   * by the fail-closed rule, because nothing in the doc licenses them for THIS
   * event and a table that guesses is the artifact this file refuses to be.
   * `additionalContext` is absent for the reason the whole issue exists.
   */
  PreCompact: {
    topLevel: DECISION,
    hookSpecificOutput: {},
  },
  /** No channel at all: everything a SessionEnd hook prints as JSON is dropped. */
  SessionEnd: {
    topLevel: {},
    hookSpecificOutput: {},
  },
};

/** The doc line that explains an empty contract, for the failure message. */
const WHY_EMPTY: Readonly<Record<string, string>> = {
  PreCompact: CITE.preCompactDiscards,
  SessionEnd: CITE.sessionEndDiscards,
};

/* ────────────────────────────────────────────────────────────────────────────
 * Reading what a script emits, off the script.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The script with comment-only lines dropped: prose about `systemMessage` is
 *  not an emission, and this file's own subject matter makes that a real risk. */
function codeOf(script: string): string {
  return script
    .split("\n")
    .map((line) => (/^[ \t]*#/.test(line) ? "" : line))
    .join("\n");
}

/** The slice from the `{` at `open` through its matching `}`, inclusive. */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`literal JSON sin cerrar en ${open}: ${src.slice(open, open + 90)}`);
}

/**
 * A stdout/append redirection to a file, ignoring `2>`, `&>` and `>&`.
 *
 * This is what separates SPEAKING TO THE HOST from writing the audit log: the
 * recorders build the same kind of object literal and send it to `$log_file`,
 * so a parser that ignored the destination would report their `tsMs`/`verdict`
 * as contract violations and this suite would be unusable from day one.
 */
const FILE_REDIRECT = /(?:^|[^0-9&<>])>>?[^&]/;

/** One object literal a hook prints to stdout, with where each field sat. */
interface Emitted {
  literal: string;
  topLevel: string[];
  hookSpecific: string[];
  /** The event the literal names inside `hookSpecificOutput`, when it has one. */
  eventName?: string;
}

/**
 * Every object literal the script writes to STDOUT.
 *
 * Two producers cover every emission in the tree, because there are only two
 * ways a shell hook builds JSON here: `node -e '…JSON.stringify({…})…'` (the
 * host's own runtime, best escaping) and a single-quoted literal handed to
 * `jq -n` or `printf`. Both are found by their opening brace, never by the
 * command name, so a new emitter is covered the day it is written.
 */
function emittedLiterals(script: string): Emitted[] {
  const code = codeOf(script);
  const opens: number[] = [];

  for (const m of code.matchAll(/JSON\.stringify\(\s*\{/g)) {
    opens.push(m.index + m[0].length - 1);
  }
  for (const m of code.matchAll(/'\{/g)) {
    opens.push(m.index + 1);
  }

  const out: Emitted[] = [];
  for (const open of opens.sort((a, b) => a - b)) {
    const literal = balanced(code, open);
    const lineEnd = code.indexOf("\n", open + literal.length);
    const tail = code.slice(open + literal.length, lineEnd === -1 ? undefined : lineEnd);
    if (FILE_REDIRECT.test(tail)) continue; // goes to a file, not to the host
    out.push(fieldsOf(literal));
  }
  return out;
}

/** Split a literal into its top-level fields and its `hookSpecificOutput` ones. */
function fieldsOf(literal: string): Emitted {
  const at = literal.indexOf("hookSpecificOutput");
  let outer = literal;
  let hookSpecific: string[] = [];
  let eventName: string | undefined;

  if (at !== -1) {
    const open = literal.indexOf("{", at);
    if (open === -1) throw new Error(`hookSpecificOutput sin objeto: ${literal}`);
    const inner = balanced(literal, open);
    hookSpecific = keysOf(inner);
    eventName = /hookEventName"?\s*:\s*"([A-Za-z]+)"/.exec(inner)?.[1];
    outer = literal.slice(0, open) + literal.slice(open + inner.length);
  }

  // Any brace left over is a container this parser does not understand, and
  // silently ignoring it is how a checker starts passing by seeing nothing.
  if (outer.slice(1, -1).includes("{")) {
    throw new Error(`objeto anidado no reconocido en: ${literal}`);
  }

  return {
    literal,
    topLevel: keysOf(outer).filter((k) => k !== "hookSpecificOutput"),
    hookSpecific,
    eventName,
  };
}

/** The keys of a flat object literal, quoted or bare. */
function keysOf(region: string): string[] {
  const keys: string[] = [];
  for (const m of region.matchAll(/(?:^|[{,])\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*:/g)) {
    const key = m[1];
    if (key) keys.push(key);
  }
  return keys;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The check itself.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Human-readable violations of `event`'s contract, empty when the emission is legal. */
function violations(event: string, emitted: Emitted): string[] {
  const contract = CONTRACT[event];
  if (!contract) return [`evento "${event}" sin fila en la tabla de contrato`];

  const why = WHY_EMPTY[event] ? ` — ${WHY_EMPTY[event]}` : "";
  const out: string[] = [];
  for (const field of emitted.topLevel) {
    if (!(field in contract.topLevel)) out.push(`${event} no entrega "${field}"${why}`);
  }
  for (const field of emitted.hookSpecific) {
    if (!(field in contract.hookSpecificOutput)) {
      out.push(`${event} no entrega "hookSpecificOutput.${field}"${why}`);
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The registrations: which event each script is actually wired to.
 * ──────────────────────────────────────────────────────────────────────────── */

interface HookBucket {
  matcher?: string;
  hooks: Array<{ command?: string }>;
}

interface WiredHook {
  /** `core`, or `plugin:<id>` — the registration this hook was read from. */
  source: string;
  event: string;
  script: string;
  emissions: Emitted[];
}

function coreWiredHooks(): WiredHook[] {
  const settings = buildClaudeSettings(MINIMAL_CONFIG, []).hooks as Record<
    string,
    HookBucket[] | undefined
  >;
  const wired: WiredHook[] = [];

  for (const [event, buckets] of Object.entries(settings)) {
    for (const bucket of buckets ?? []) {
      for (const entry of bucket.hooks) {
        const name = /([\w-]+\.sh)/.exec(entry.command ?? "")?.[1];
        if (!name) continue;
        const path = resolve(HOOKS_ROOT, name);
        if (!existsSync(path)) continue;
        wired.push({
          source: "core",
          event,
          script: name,
          emissions: emittedLiterals(readFileSync(path, "utf-8")),
        });
      }
    }
  }
  return wired;
}

function pluginWiredHooks(): WiredHook[] {
  const wired: WiredHook[] = [];

  for (const id of listKnownPluginIds()) {
    let plugin: LoadedPlugin;
    try {
      plugin = loadPlugin(id);
    } catch {
      continue; // not bundled in this build; `plugins.test.ts` owns that check
    }
    for (const hook of plugin.manifest.hooks ?? []) {
      const name = /([\w-]+\.sh)/.exec(hook.command)?.[1];
      if (!name) continue;
      const asset = plugin.scriptAssets.find((s) => s.dest === name);
      if (!asset || !existsSync(asset.src)) continue;
      wired.push({
        source: `plugin:${id}`,
        event: hook.event,
        script: name,
        emissions: emittedLiterals(readFileSync(asset.src, "utf-8")),
      });
    }
  }
  return wired;
}

function wiredHooks(): WiredHook[] {
  return [...coreWiredHooks(), ...pluginWiredHooks()];
}

describe("contrato JSON de salida — por evento, con cita (#774)", () => {
  const hooks = wiredHooks();
  const emitting = hooks.filter((h) => h.emissions.length > 0);

  /**
   * The anti-vacuity guard. Everything below is derived by parsing shell, and a
   * parser that matches nothing turns the file into a suite that passes because
   * it found no work to do — which IS the defect it was written for.
   */
  it("encuentra emisiones reales y las atribuye a su evento registrado", () => {
    expect(hooks.length).toBeGreaterThan(0);
    expect(hooks.filter((h) => h.source.startsWith("plugin:")).length).toBeGreaterThan(0);

    // The hooks that speak to the host today, one per channel shape in the tree.
    expect(emitting.map((h) => h.script).sort()).toEqual(
      expect.arrayContaining([
        "pr-pilot-confirm.sh",
        "routing-watch.sh",
        "session-start-context.sh",
        "stop-verify-reminder.sh",
        "subagent-stop-handoff.sh",
      ]),
    );
    // …covering more than one event, so a single-event parse can't look healthy.
    expect(new Set(emitting.map((h) => h.event)).size).toBeGreaterThanOrEqual(4);

    // A script whose CODE names an output field has to yield an emission. This
    // is the check that catches a producer pattern the parser stopped matching.
    const named = hooks.filter((h) =>
      /hookSpecificOutput|systemMessage/.test(
        codeOf(
          readFileSync(
            h.source === "core"
              ? resolve(HOOKS_ROOT, h.script)
              : (loadPlugin(h.source.slice("plugin:".length)).scriptAssets.find(
                  (s) => s.dest === h.script,
                )?.src ?? ""),
            "utf-8",
          ),
        ),
      ),
    );
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((h) => h.emissions.length === 0)).toEqual([]);
  });

  for (const hook of emitting) {
    it(`${hook.event}(${hook.source}/${hook.script}): solo emite campos que ese evento entrega`, () => {
      for (const emitted of hook.emissions) {
        expect(violations(hook.event, emitted), `${hook.script} emite ${emitted.literal}`).toEqual(
          [],
        );
      }
    });

    it(`${hook.event}(${hook.source}/${hook.script}): el hookEventName nombra el evento registrado`, () => {
      for (const emitted of hook.emissions) {
        if (emitted.eventName === undefined) continue;
        expect(
          emitted.eventName,
          `${hook.script} está registrado en ${hook.event} y se anuncia como ${emitted.eventName}`,
        ).toBe(hook.event);
      }
    });
  }

  /**
   * SessionEnd stated rather than left to the loop above: its contract is
   * EMPTY, so "no violations" and "the parser found nothing" read identically.
   * This pins the shape #774 landed on — the sweep reports through a file the
   * next SessionStart reads, never through JSON the host drops.
   */
  it("los hooks de SessionEnd no emiten JSON, porque el host lo descarta", () => {
    const sessionEnd = hooks.filter((h) => h.event === "SessionEnd");
    expect(sessionEnd.map((h) => h.script).sort()).toEqual([
      "audit-mode-close.sh",
      "worktree-reclaim.sh",
    ]);
    for (const hook of sessionEnd) {
      expect(hook.emissions, `${hook.script} — ${CITE.sessionEndDiscards}`).toEqual([]);
    }
  });

  /**
   * The partials are inlined into every hook at render time, so a `_partials`
   * file that started speaking to the host would emit from inside a body this
   * suite reads unexpanded. They don't, and the cheapest durable proof is that
   * none of the host's output vocabulary appears in their code at all: they
   * only ever write to the audit log.
   */
  it("los partials no hablan con el host, solo escriben al log", () => {
    const partials = readdirSync(PARTIALS_ROOT).filter((f) => f.endsWith(".sh"));
    expect(partials.length).toBeGreaterThan(0);
    const offenders = partials.filter((f) =>
      /hookSpecificOutput|systemMessage|permissionDecision|"decision"/.test(
        codeOf(readFileSync(resolve(PARTIALS_ROOT, f), "utf-8")),
      ),
    );
    expect(offenders).toEqual([]);
  });
});

/**
 * The checker's own teeth. Every case below is a channel the host does NOT
 * deliver, written the way somebody would plausibly write it — and the suite is
 * only worth running if it rejects them.
 */
describe("el checker rechaza los canales que el evento descarta", () => {
  const cases: Array<[string, string, string]> = [
    // [event, literal, the substring the failure must name]
    [
      "PreCompact",
      '{hookSpecificOutput:{hookEventName:"PreCompact",additionalContext:process.env.CTX}}',
      "hookSpecificOutput.additionalContext",
    ],
    ["PreCompact", "{systemMessage:$m}", "systemMessage"],
    ["PreCompact", "{continue:false,stopReason:$m}", "continue"],
    [
      "SessionEnd",
      '{hookSpecificOutput:{hookEventName:"SessionEnd",additionalContext:$m}}',
      "hookSpecificOutput.additionalContext",
    ],
    ["SessionEnd", "{systemMessage:$m}", "systemMessage"],
    [
      "SessionStart",
      '{hookSpecificOutput:{hookEventName:"SessionStart",permissionDecision:"ask"}}',
      "hookSpecificOutput.permissionDecision",
    ],
  ];

  it.each(cases)("%s rechaza %s", (event, literal, expected) => {
    const found = violations(event, fieldsOf(literal));
    expect(found.join(" | ")).toContain(expected);
  });

  // The mirror image: the emissions the fix introduced must PASS, or the table
  // is just a wall and the suite proves nothing about the channels that work.
  it.each([
    [
      "Stop",
      '{systemMessage:process.env.MSG,hookSpecificOutput:{hookEventName:"Stop",additionalContext:process.env.MSG}}',
    ],
    ["PostToolUse", '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$m}}'],
    ["SessionStart", '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'],
    [
      "PreToolUse",
      '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$reason}}',
    ],
  ])("%s acepta la emisión vigente", (event, literal) => {
    expect(violations(event, fieldsOf(literal))).toEqual([]);
  });

  // The parser is half the check, so its own failure modes are asserted too: an
  // unknown nested container must THROW rather than be quietly skipped.
  it("no ignora en silencio un contenedor que no entiende", () => {
    expect(() => fieldsOf('{decision:{behavior:"allow"}}')).toThrow(/no reconocido/);
  });
});
