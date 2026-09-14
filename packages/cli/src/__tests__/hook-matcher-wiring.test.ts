import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildClaudeSettings } from "../engines/claude/build-settings.ts";
import { getCoreRoot } from "../lib/bundled-assets.ts";
import { listKnownPluginIds, loadPlugin } from "../lib/plugins.ts";
import type { LoadedPlugin } from "../lib/plugins.ts";
import type { NavoriConfig } from "../lib/config.ts";

/**
 * The CABLING invariant: every tool a hook's own `case` is written to accept
 * must be in the matcher the hook is REGISTERED with.
 *
 * This exists because of #767, and the shape of that defect is the whole
 * argument for this file. `routing-watch.sh` gained a `Bash)` branch in #722 A4
 * — with a comment stating that without it the threshold was "structurally
 * unreachable" in the dominant mode — but `build-settings.ts` never added
 * `Bash` to the matcher it registers the hook with. The host filters by matcher
 * BEFORE spawning the script, so the branch has shipped and never once
 * executed. The fix was inert from the commit that introduced it.
 *
 * #722's tests did not catch it because they feed the script directly on stdin:
 * that proves the half that never failed. The half that failed is the wiring,
 * and nothing was asserting it — `routing-watch.test.ts` came closest, and it
 * checks `matcher` against a HAND-WRITTEN list of four tool names, which is
 * precisely the artifact that drifts away from the script it claims to mirror.
 *
 * So the accepted set is DERIVED from the script (its `case "$tool"` branches),
 * never restated here. Add a tool to a hook's `case` and this suite fails until
 * the matcher delivers it. Same genre as `repo-config-gate.test.ts`, which
 * derives the quality gate's expectations from `ci.yml` instead of repeating
 * them: the artifact checked against its own declaration, not against a copy.
 *
 * SCOPE, and the second half of the class (#775). A script can claim its input
 * in two ways, and BOTH are checked here:
 *
 *   1. By TOOL, in a `case "$tool_name"` — `routing-watch.sh` is the only hook
 *      that does this, and it is where the defect was found.
 *   2. By COMMAND, in a `$TRIGGER_TOKENS` declaration — the gates
 *      (quality-gate, jscpd, semgrep) reclaim `git commit`/`push`/`gh pr
 *      create`, never a tool. Their wiring claim is "matcher `Bash` hands me
 *      commands", and `Bash` on `PreToolUse` is the only registration that
 *      does. That claim was held up by hand-written assertions scattered across
 *      suites, and for `check-semgrep` there were NONE: flipping its manifest
 *      matcher to `Edit` passed every one of the 30+ suites while the security
 *      scan never fired again.
 *
 * Sources, plural, for the same reason the accepted set is derived rather than
 * restated: core hooks come from `buildClaudeSettings`, plugin hooks from each
 * `plugin.json`. Those ARE the registrations — a copy of them here would be one
 * more artifact free to drift.
 */

/**
 * `qualityGate.fast` is set on purpose: the pre-commit gate is the one core
 * hook registered CONDITIONALLY, and a config that leaves it out would quietly
 * drop a gate hook from this file's scope — the kind of silent narrowing the
 * whole suite exists to catch.
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
} as unknown as NavoriConfig;

/**
 * Known wiring defects: a hook whose script accepts a tool its matcher does not
 * deliver, with the issue that tracks it. Every entry is a LIVE BUG, not an
 * exemption — its case below runs under `it.fails`, so it stays green while the
 * defect stands and turns RED the moment the matcher is fixed. That is the
 * point: whoever fixes the matcher cannot leave this map stale, because the
 * suite stops them.
 *
 * EMPTY IS THE GOAL STATE, and it is the state today. The one entry this map
 * ever held was `routing-watch.sh` — `case` accepting `Bash` since #722 A4
 * against a matcher that never gained it — and #775 connected the lane, so the
 * case below runs as a plain `it` and asserts the fix instead of the bug. The
 * mechanism stays because the next defect of this class should be recordable
 * without inverting an expectation, which is how a bug gets written down as if
 * it were the contract.
 */
const KNOWN_WIRING_DEFECTS = new Map<string, string>();

interface HookBucket {
  matcher?: string;
  hooks: Array<{ command?: string }>;
}

/** The two events whose matcher is a TOOL name; the rest match sources/reasons. */
const TOOL_MATCHED_EVENTS = ["PreToolUse", "PostToolUse"] as const;

/**
 * The tool names a hook script is written to act on, read off the script itself.
 *
 * Finds the variable the script fills from `payload_field tool_name`, then
 * collects the literal labels of every `case "$<var>" in` branch, dropping the
 * catch-all `*)` (which is the discard, not an accepted tool). A script that
 * never reads `tool_name` returns an empty set: it makes no claim about tools,
 * so its matcher cannot contradict it.
 */
function acceptedTools(script: string): Set<string> {
  const varName = /(\w+)=\$\(payload_field tool_name\)/.exec(script)?.[1];
  const tools = new Set<string>();
  if (!varName) return tools;

  // The two spellings that open the dispatch, BUILT as literals and compared as
  // strings — never compiled into a pattern. `varName` comes out of a `\w+`
  // capture, so it carries no metacharacter and could not inject one; but
  // `new RegExp(<interpolated>)` is what semgrep's
  // `detect-non-literal-regexp` flags, and it is right to flag the shape rather
  // than re-derive the provenance at every call site. A suppression comment
  // would buy the same green for the price of a standing exception, so the
  // pattern goes away instead: two literals and a whitespace-normalized compare
  // say the same thing with nothing to suppress.
  const caseOpeners = [`case "$${varName}" in`, `case "\${${varName}}" in`];
  // A branch header: labels made only of tool-name characters, `|` and spaces,
  // up to the first `)`. Anchored at line start so a `)` inside a branch body
  // cannot be mistaken for one.
  const branchHeader = /^[ \t]*([A-Za-z0-9_*?|\- \t]+?)\)/;
  let inCase = false;

  for (const line of script.split("\n")) {
    if (/^[ \t]*#/.test(line)) continue;
    if (!inCase) {
      // Collapsed runs of whitespace, so the compare keeps the tolerance the
      // pattern had (`case   "$tool"  in`) without being a pattern.
      if (caseOpeners.includes(line.trim().replace(/\s+/g, " "))) inCase = true;
      continue;
    }
    if (/^[ \t]*esac\b/.test(line)) {
      inCase = false;
      continue;
    }
    const labels = branchHeader.exec(line)?.[1];
    if (!labels) continue;
    for (const label of labels.split("|")) {
      const tool = label.trim();
      if (tool && tool !== "*") tools.add(tool);
    }
  }
  return tools;
}

/** The tools a Claude Code matcher delivers. No matcher = every tool. */
function matchedTools(matcher: string | undefined): Set<string> | null {
  if (!matcher) return null;
  return new Set(matcher.split("|").map((t) => t.trim()));
}

/**
 * The COMMANDS a hook script claims, read off its own `$TRIGGER_TOKENS`.
 *
 * A script that declares these is saying "the git operations I gate are named
 * by these literals" — which only means anything if the registration hands it
 * commands to look at. Returns null when the script makes no such claim.
 */
function claimedTriggers(script: string): string[] | null {
  const raw = /^TRIGGER_TOKENS='(.+)'$/m.exec(script)?.[1];
  return raw ? raw.split(" ").filter(Boolean) : null;
}

interface WiredHook {
  /** `core`, or `plugin:<id>` — the registration this hook was read from. */
  source: string;
  event: string;
  script: string;
  matcher?: string;
  accepts: Set<string>;
  triggers: string[] | null;
}

function describeScript(source: string, path: string, script: string) {
  const body = readFileSync(path, "utf-8");
  return { source, script, accepts: acceptedTools(body), triggers: claimedTriggers(body) };
}

/** Every core hook registered on a tool-matched event, paired with its script. */
function coreWiredHooks(): WiredHook[] {
  const hooksRoot = resolve(getCoreRoot(), "core-assets/hooks");
  const settings = buildClaudeSettings(MINIMAL_CONFIG, []).hooks as Record<
    string,
    HookBucket[] | undefined
  >;
  const wired: WiredHook[] = [];

  for (const event of TOOL_MATCHED_EVENTS) {
    for (const bucket of settings[event] ?? []) {
      for (const entry of bucket.hooks) {
        const name = /([\w-]+\.sh)/.exec(entry.command ?? "")?.[1];
        if (!name) continue;
        const path = resolve(hooksRoot, name);
        if (!existsSync(path)) continue;
        wired.push({ event, matcher: bucket.matcher, ...describeScript("core", path, name) });
      }
    }
  }
  return wired;
}

/**
 * Every plugin hook on a tool-matched event, paired with its script.
 *
 * The manifest is the source, exactly as `buildClaudeSettings` is the source
 * for core: a plugin's `hooks[]` is what the Claude adapter copies into
 * `settings.json`, so checking it here checks the registration itself. The
 * script is located by matching the `dest` filename the manifest declares
 * against the `command` the hook is registered with — a hook pointing at a
 * script its own manifest does not ship is itself a wiring defect, and the
 * anti-vacuity guard below is what refuses to let that pass as "nothing found".
 */
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
      if (!TOOL_MATCHED_EVENTS.includes(hook.event as (typeof TOOL_MATCHED_EVENTS)[number])) {
        continue;
      }
      const name = /([\w-]+\.sh)/.exec(hook.command)?.[1];
      if (!name) continue;
      const asset = plugin.scriptAssets.find((s) => s.dest === name);
      if (!asset || !existsSync(asset.src)) continue;
      wired.push({
        event: hook.event,
        matcher: hook.matcher,
        ...describeScript(`plugin:${id}`, asset.src, name),
      });
    }
  }
  return wired;
}

function wiredHooks(): WiredHook[] {
  return [...coreWiredHooks(), ...pluginWiredHooks()];
}

describe("hook wiring — matcher vs. what the script accepts (#767, #775)", () => {
  const hooks = wiredHooks();

  /**
   * The anti-vacuity guard. Everything below is derived by parsing shell and
   * manifests, and a parser that silently matches nothing turns this whole file
   * into a suite that passes by finding no work to do — which is the failure
   * mode of the defect it was written for. So: both sources must yield hooks,
   * and each claim shape must be represented by a script that really makes it.
   */
  it("encuentra hooks cableados y deriva sus claims del script", () => {
    expect(hooks.length).toBeGreaterThan(0);
    expect(hooks.map((h) => h.script)).toContain("routing-watch.sh");
    // Plugins are the half the earlier scope excluded; an empty plugin list
    // would make every plugin assertion below pass by finding nothing.
    expect(hooks.filter((h) => h.source.startsWith("plugin:")).length).toBeGreaterThan(0);
    expect(hooks.map((h) => h.script)).toContain("check-semgrep.sh");

    const discriminating = hooks.filter((h) => h.accepts.size > 0);
    expect(discriminating.length).toBeGreaterThan(0);
    // The parse is only trustworthy if it reads the branch this defect is about.
    const routing = hooks.find((h) => h.script === "routing-watch.sh");
    expect([...(routing?.accepts ?? [])].sort()).toEqual([
      "Agent",
      "Bash",
      "Edit",
      "NotebookEdit",
      "Task",
      "Write",
    ]);

    // The second claim shape, read off the scripts that declare it.
    const gates = hooks.filter((h) => h.triggers !== null);
    expect(gates.map((h) => h.script).sort()).toEqual([
      "check-jscpd.sh",
      "check-semgrep.sh",
      "pr-pilot-confirm.sh",
      "quality-gate-pre-commit.sh",
    ]);
    expect(hooks.find((h) => h.script === "check-semgrep.sh")?.triggers).toEqual([
      "commit",
      "push",
      "create",
    ]);
  });

  for (const hook of hooks.filter((h) => h.accepts.size > 0)) {
    const defect = KNOWN_WIRING_DEFECTS.get(hook.script);
    // `it.fails` is the marker for a defect that is REAL and still open: the
    // assertion below is the executable proof of #767, and inverting its
    // expectation would be writing down the bug as if it were the contract.
    const runs = defect ? it.fails : it;

    runs(
      `${hook.event}(${hook.source}/${hook.script}): el matcher entrega todo lo que el case acepta`,
      () => {
        const delivered = matchedTools(hook.matcher);
        if (!delivered) return; // no matcher: every tool reaches the script
        const unreachable = [...hook.accepts].filter((t) => !delivered.has(t));
        expect(
          unreachable,
          `${hook.script} acepta ${unreachable.join(", ")} pero el matcher "${hook.matcher}" no lo entrega${
            defect ? ` — ${defect}` : ""
          }`,
        ).toEqual([]);
      },
    );
  }
});

/**
 * The COMMAND half of the class (#775, audit M1).
 *
 * A gate hook never inspects a tool: it reads `tool_input.command` and asks
 * whether the shell is about to run `git commit`, `git push` or `gh pr create`.
 * That makes its registration a one-line claim — `PreToolUse` with a matcher
 * that delivers `Bash` — and nothing else in the script can contradict a wrong
 * one. `check-semgrep` had ZERO registration assertions anywhere in the suite
 * when this was written: its manifest matcher could have been changed to `Edit`
 * and every test in the repo would still have passed while the security scan
 * silently stopped running on every commit it exists to scan.
 *
 * Derived, not listed: the set comes from whichever scripts declare
 * `$TRIGGER_TOKENS`, so a new gate is covered the moment it declares one.
 */
describe("gate hooks — un claim por COMANDO exige matcher Bash en PreToolUse", () => {
  const gates = wiredHooks().filter((h) => h.triggers !== null);

  it.each(gates)(
    "$source/$script: registrado donde los comandos llegan",
    ({ source, script, event, matcher, triggers }) => {
      const delivered = matchedTools(matcher);
      expect(
        event,
        `${source}/${script} reclama los comandos ${triggers?.join(", ")} — solo PreToolUse llega antes de que corran`,
      ).toBe("PreToolUse");
      // No matcher would ALSO deliver Bash; the gates all set one, and the
      // assertion has to stay true for either shape rather than assume.
      expect(
        delivered === null || delivered.has("Bash"),
        `${source}/${script} reclama los comandos ${triggers?.join(", ")} pero su matcher "${matcher}" no entrega Bash — el gate nunca dispararía`,
      ).toBe(true);
    },
  );
});
