import { describe, expect, it } from "vitest";
import { buildClaudeSettings } from "../../engines/claude/build-settings.ts";
import { mergeCoexistSettings } from "../../engines/claude/coexist-settings.ts";
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
const EXPECTED = { bPre: 5, bPost: 2, bPostFail: 0 };

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
    expect(watch[0]!.command.endsWith(" claude-post-tool-use")).toBe(true);
  });

  // Covers: R28
  it("model-advisor no longer rides any PreToolUse registration", () => {
    const pre = (defaultSettings.hooks?.PreToolUse ?? []).flatMap((e) => e.hooks);
    expect(pre.some((h) => h.command.includes("model-advisor"))).toBe(false);
  });
});
