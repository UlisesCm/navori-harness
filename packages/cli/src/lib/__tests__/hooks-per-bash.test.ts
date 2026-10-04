import { describe, expect, it } from "vitest";
import { buildClaudeSettings } from "../../engines/claude/build-settings.ts";
import { mergeCoexistSettings } from "../../engines/claude/coexist-settings.ts";
import { resolveCodexHooks } from "../../engines/codex/hook-registrations.ts";
import { loadPlugin } from "../config/plugins.ts";
import { NavoriConfigSchema, type NavoriConfig } from "../config/schema.ts";

/**
 * R28 (spec 0039) — no change may add a hook to the path of an ordinary Bash
 * call. Every Bash call pays one process per hook that matches it, so the number
 * is a cost the user feels and the harness must not grow silently.
 *
 * The counts are COMPUTED from the rendered configuration, never restated: each
 * registration's `matcher` is tested against the tool name `Bash` and its `if`
 * (when present) against fixture commands, the way the host filters before it
 * spawns anything.
 *
 *   B_pre         PreToolUse hooks that run on a Bash call.
 *   B_post        PostToolUse hooks that run when the call succeeds.
 *   B_post_fail   PostToolUseFailure hooks that run when it fails.
 *   success path  = B_pre + B_post          failure path = B_pre + B_post_fail
 *
 * HOW TO UPDATE (F3 / F5a): a phase that adds or retires a hook on these events
 * changes a number below on purpose. Edit the pinned `EXPECTED` table in the same
 * commit and justify the delta against the spec's D5 table in the PR: F3 (evidence
 * lane in `routing-watch`, `bash-outcome-watch` on `PostToolUseFailure`) and F5a
 * (search guard lane inside `guard-destructive`) are each expected to be net 0 or
 * negative on the success path. A positive delta on either path violates R28.
 *
 * T29 (R28, R70) — blocked-search path. The redirection mechanism is the
 * guard-search-routing lane SOURCED INSIDE `guard-destructive` (tgrep plugin managed
 * block `guard-destructive-search-lane`, spec 0039 D6): it exits 2 at PreToolUse, so no
 * PostToolUse hook runs, and it adds NO hook registration. T28 left `EXPECTED`
 * unchanged for that reason (its only `claude.snap` change is a case arm inside the
 * existing guard script). T38 only adds a lane inside `subagent-stop-handoff`, a
 * SubagentStop hook, not a Bash hook, so it does not move any number either.
 */

/** A Bash command that no `if` should be able to single out. */
const COMMANDS = {
  plain: "ls -la",
  git: "git status",
  search: "grep -rn TODO src/",
  commit: "git commit -m x",
} as const;

type HookEntry = { matcher?: string; hooks: Array<{ command: string; if?: string }> };
type Settings = { hooks?: Record<string, HookEntry[]> };

/**
 * Claude matcher semantics for a tool name, restricted to the shapes the harness
 * registers: empty, `*` or `.*` match every tool, anything else is a `|` list of
 * exact names. No RegExp is built from a config string on purpose (semgrep's
 * detect-non-literal-regexp); a matcher using other regex syntax must extend this.
 */
function matcherAccepts(matcher: string | undefined, tool: string): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*" || matcher === ".*") return true;
  return matcher.split("|").includes(tool);
}

/** `*`-only glob match, iterative (no regex, no backtracking blow-up). */
function globMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/**
 * `if` uses permission-rule syntax. Only `Bash(<glob>)` is evaluated, over each
 * subcommand (the doc: it "runs when any subcommand of the Bash input matches").
 * Any other shape is treated as matching: counting it in is the conservative side
 * for a ceiling.
 */
function ifAccepts(expr: string | undefined, command: string): boolean {
  if (expr === undefined) return true;
  const m = /^Bash\((.*)\)$/.exec(expr);
  if (!m) return true;
  // `Bash(git:*)` is the legacy spelling of `Bash(git *)`.
  const glob = m[1]!.replace(/:\*$/, " *");
  return command
    .split(/&&|\|\||;|\|/)
    .map((sub) => sub.trim())
    .some((sub) => globMatches(glob, sub));
}

function countOn(settings: Settings, event: string, command: string): number {
  const entries = settings.hooks?.[event] ?? [];
  return entries
    .filter((e) => matcherAccepts(e.matcher, "Bash"))
    .flatMap((e) => e.hooks)
    .filter((h) => ifAccepts(h.if, command)).length;
}

function paths(settings: Settings, command: string) {
  const bPre = countOn(settings, "PreToolUse", command);
  const bPost = countOn(settings, "PostToolUse", command);
  const bPostFail = countOn(settings, "PostToolUseFailure", command);
  return { bPre, bPost, bPostFail, success: bPre + bPost, failure: bPre + bPostFail };
}

function fixtureConfig(): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "hooks-per-bash",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "bun lint", full: "bun test" },
    plugins: { tgrep: { enabled: true } },
  });
}

const config = fixtureConfig();
const defaultSettings = buildClaudeSettings(config, [loadPlugin("tgrep")]) as Settings;
// Coexist: navori injects into a hand-written settings.json it does not own.
const coexistSettings = mergeCoexistSettings(
  { permissions: { allow: ["Bash(ls)"] } },
  defaultSettings as Record<string, unknown>,
) as Settings;

/**
 * Pinned after T16 (model-advisor left `PreToolUse(.*)`). Measured on these
 * fixtures, not on this repo's own config, which also enables engram/codegraph/etc.
 * T21 (D5): unchanged on purpose — the success-lane evidence recorder runs INSIDE
 * `routing-watch`, which already ran on every Bash success, so `bPost` stays 2.
 * T23's `bash-outcome-watch` on `PostToolUseFailure` is what will move `bPostFail`.
 */
const EXPECTED = { bPre: 5, bPost: 2, bPostFail: 1 };

/**
 * R43 base for the blocked path, derived explicitly. The `claude-first-base` snapshot (T9,
 * `hooks.perBashCall` p50 4.88) is an observed median on this repo's own config and is not
 * comparable to the fixtures here, so the base is the per-path count BEFORE T16: the
 * current `bPre` plus `model-advisor`, which sat on `PreToolUse(.*)` and so ran on every
 * Bash call. D5 table: a blocked call costs `B_pre − 1` against that base.
 */
const BASE_B_PRE = EXPECTED.bPre + 1;

describe("hooks per Bash call (R28)", () => {
  describe.each([
    ["default with tgrep", defaultSettings],
    ["coexist", coexistSettings],
  ] as const)("%s", (_name, settings) => {
    // Covers: R28
    it("registers hooks on Bash at all (guard against a vacuous count)", () => {
      expect(countOn(settings, "PreToolUse", COMMANDS.plain)).toBeGreaterThan(0);
    });

    // Covers: R28
    it.each(Object.entries(COMMANDS))("pins the per-path totals for `%s`", (_label, command) => {
      const p = paths(settings, command);
      expect({ bPre: p.bPre, bPost: p.bPost, bPostFail: p.bPostFail }).toEqual(EXPECTED);
    });
  });

  // Covers: R28
  it("coexist merging neither drops nor duplicates a Bash hook", () => {
    expect(paths(coexistSettings, COMMANDS.plain)).toEqual(paths(defaultSettings, COMMANDS.plain));
  });

  // Covers: R6, R7, R28
  it("the evidence lane rides routing-watch (no new PostToolUse hook, timeout 30, Claude-only arg)", () => {
    const post = (defaultSettings.hooks?.PostToolUse ?? []).flatMap((e) => e.hooks);
    expect(post.some((h) => h.command.includes("bash-outcome"))).toBe(false);
    const watch = post.filter((h) => h.command.includes("routing-watch.sh"));
    expect(watch).toHaveLength(1);
    expect(watch[0]).toMatchObject({ timeout: 30 });
    expect(watch[0]!.command).toContain('exec bash "$f" claude-post-tool-use;');
  });

  // Covers: R28
  it("model-advisor no longer rides any PreToolUse registration", () => {
    const pre = (defaultSettings.hooks?.PreToolUse ?? []).flatMap((e) => e.hooks);
    expect(pre.some((h) => h.command.includes("model-advisor"))).toBe(false);
  });

  describe("blocked search path (R28, R70)", () => {
    // A blocked call stops at PreToolUse (exit 2): only B_pre hooks ever run.
    const blockedTotal = (settings: Settings, command: string) => paths(settings, command).bPre;

    // Covers: R28, R70
    it.each([
      ["default with tgrep", defaultSettings],
      ["coexist", coexistSettings],
    ] as const)("%s: a blocked search costs at most base - 1 hooks", (_name, settings) => {
      for (const command of ["rg TODO src/", COMMANDS.search]) {
        expect(blockedTotal(settings, command)).toBeLessThanOrEqual(BASE_B_PRE - 1);
        // ...and strictly fewer than the same command succeeding.
        expect(blockedTotal(settings, command)).toBeLessThan(paths(settings, command).success);
      }
    });

    // Covers: R28, R70
    it("the redirection is a lane inside guard-destructive, not a registration", () => {
      const pre = (defaultSettings.hooks?.PreToolUse ?? []).flatMap((e) => e.hooks);
      expect(pre.some((h) => h.command.includes("guard-search-routing"))).toBe(false);
      expect(pre.filter((h) => h.command.includes("guard-destructive.sh"))).toHaveLength(1);
    });
  });
});

/**
 * Codex (spec 0041 T12, R11): the same ceiling, computed from `resolveCodexHooks`.
 * The Bash outcome lane rides the already-registered `routing-watch`, so it adds NO
 * registration: a change to these numbers must be justified like the Claude ones.
 * Codex has no `if` and no `PostToolUseFailure` event, so only the matcher decides.
 */
function codexMatcherAccepts(matcher: string | undefined, tool: string): boolean {
  if (matcher === undefined) return true;
  const start = matcher.startsWith("^");
  const end = matcher.endsWith("$");
  const body = matcher.slice(start ? 1 : 0, end ? -1 : undefined).replace(/^\((.*)\)$/, "$1");
  return body.split("|").some((alt) => {
    if (start && end) return tool === alt;
    if (start) return tool.startsWith(alt);
    if (end) return tool.endsWith(alt);
    return tool.includes(alt);
  });
}

const CODEX_EXPECTED = { pre: 4, post: 2 };

describe("hooks per Bash call, Codex (R11, R28)", () => {
  const codexConfig = NavoriConfigSchema.parse({
    name: "hooks-per-bash-codex",
    engines: ["codex"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "bun lint", full: "bun test" },
    plugins: { tgrep: { enabled: true } },
  });
  const hooks = resolveCodexHooks(codexConfig, [loadPlugin("tgrep")]);
  const onBash = (event: string) =>
    hooks.filter((h) => h.event === event && codexMatcherAccepts(h.matcher, "Bash"));

  // Covers: R11
  it("pins the hooks that run on a Codex Bash call", () => {
    expect({ pre: onBash("PreToolUse").length, post: onBash("PostToolUse").length }).toEqual(
      CODEX_EXPECTED,
    );
  });

  // Covers: R11
  it("the bash-outcome lane adds no registration: it rides routing-watch, with no argument", () => {
    expect(hooks.some((h) => h.script.includes("bash-outcome"))).toBe(false);
    const watch = hooks.filter((h) => h.script === "routing-watch");
    expect(watch).toHaveLength(1);
    expect(watch[0]).toMatchObject({ event: "PostToolUse" });
    expect(watch[0]!.args).toBeUndefined();
    expect(onBash("PostToolUse").map((h) => h.script)).toContain("routing-watch");
  });
});
