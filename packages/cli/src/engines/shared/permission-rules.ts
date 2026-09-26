import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NavoriConfig } from "../../lib/config/config.ts";
import type { LoadedPlugin } from "../../lib/config/plugins.ts";
import { getCoreRoot, readCliVersion } from "../../lib/render/bundled-assets.ts";
import { interpolate } from "../../lib/render/interpolate.ts";
import { deepMerge } from "../claude/deep-merge.ts";

const SETTINGS_BASE_REL = "core-assets/settings/settings-base.json";

/** The shell-permission triple every engine adapter translates from: Claude
 *  writes it almost verbatim into `.claude/settings.json`; Codex's
 *  `buildCodexRules` (spec 0035 D5) translates each entry into a
 *  `prefix_rule`. */
export interface ShellPermissionRules {
  readonly allow: readonly string[];
  readonly ask: readonly string[];
  readonly deny: readonly string[];
}

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);

/** The dev-loop scripts worth a standing rule of their own: run constantly, and
 *  `build` in particular is rarely part of the quality gate. */
const DEV_LOOP_SCRIPTS = ["build", "test", "lint", "typecheck", "format"] as const;

/**
 * Which of `DEV_LOOP_SCRIPTS` each package manager resolves to the SCRIPT when
 * typed without `run` (spec 0016, T1.2). Only the explicit `<pm> run <script>`
 * form carried a rule, so the shorter spelling everyone actually types paid a
 * classifier round-trip in auto mode and a human prompt in default/acceptEdits.
 *
 * The spec proposed emitting the bare form for all five on every manager, on the
 * premise that `<pm> <script>` is always sugar for `<pm> run <script>`. Measured
 * against the four managers with a package.json declaring all five scripts, that
 * premise holds only for pnpm and yarn:
 *
 *   | pm   | build          | test           | lint | typecheck | format |
 *   |------|----------------|----------------|------|-----------|--------|
 *   | pnpm | script         | script         | ✓    | ✓         | ✓      |
 *   | npm  | Unknown command| script         | ✗    | ✗         | ✗      |
 *   | yarn | script         | script         | ✓    | ✓         | ✓      |
 *   | bun  | BUNDLER        | TEST RUNNER    | ✓    | ✓         | ✓      |
 *
 * Two distinct reasons to exclude, and only one of them is cosmetic:
 *   - npm resolves only its lifecycle alias `test`; `npm build`/`lint`/… exit
 *     with "Unknown command". A rule for those is dead weight that reads like a
 *     capability the repo does not have.
 *   - `bun build` and `bun test` are bun's OWN bundler and test runner, not the
 *     scripts. Emitting them would pre-approve a different command than the rule
 *     claims — `bun build --outdir <anywhere>` writes files — which is exactly
 *     the surface expansion the spec said this task would not introduce.
 *
 * Verified empirically (pnpm 10 / npm 11 / yarn 1 / bun 1), not from docs.
 */
const BARE_SCRIPT_FORMS: Record<string, ReadonlySet<string>> = {
  pnpm: new Set(DEV_LOOP_SCRIPTS),
  yarn: new Set(DEV_LOOP_SCRIPTS),
  npm: new Set(["test"]),
  bun: new Set(["lint", "typecheck", "format"]),
};
// Sequencers navori's quality gate uses to join steps. Bare pipes are excluded:
// a `| tee`/`| grep` tail is part of one logical step, not a command to allow.
const GATE_SEQUENCERS = /\s*(?:&&|\|\||;)\s*/;
// A gate step is only safe to pre-approve as a permission rule (#197) if it is
// made of "quiet" tokens: word chars plus the punctuation a package-manager
// invocation legitimately uses (space, `@ . / : = -`). Anything else — a bare
// pipe, redirect, `$`, backtick, quote, paren, `&` — means the step could smuggle
// a second command through a rule that Claude Code would then auto-approve, so we
// refuse to derive an allow rule from it (the step still runs; it just prompts).
const SAFE_GATE_STEP = /^[\w @.:/=-]+$/;
// A gate step that only changes directory: `cd` plus exactly ONE operand. Paired
// with SAFE_GATE_STEP (which forbids `$`, backticks, quotes, `~`), so the operand
// is a literal path — `cd $(curl …)` never reaches here.
const CD_STEP = /^cd\s+\S+$/;

/**
 * Resolve the repo's package manager: the persisted `config.packageManager`
 * (written by init/update — the source of truth), falling back to the runner
 * token of a `qualityGate.fast` step for configs written before the field
 * existed. The fallback scans every step, not just the first (#403): a gate that
 * opens with `cd packages/cli && pnpm lint` used to resolve the runner as `cd`
 * and give up, so a monorepo — exactly the shape that needs the dev-loop rules —
 * got none.
 */
function resolvePackageManager(config: NavoriConfig): string | null {
  if (config.packageManager) return config.packageManager;
  for (const step of config.qualityGate?.fast?.split(GATE_SEQUENCERS) ?? []) {
    // `split` always yields at least one element; `?? ""` is unreachable and
    // is never a package manager anyway.
    const runner = step.trim().split(/\s+/)[0] ?? "";
    if (PACKAGE_MANAGERS.has(runner)) return runner;
  }
  return null;
}

/**
 * The allow rule a single gate step earns, or `null` when the step is not safe
 * to pre-approve. Two shapes qualify:
 *
 *   - `<pm> …`   → prefix rule `Bash(<step>:*)`, so flags/paths may follow.
 *   - `cd <dir>` → EXACT rule `Bash(cd <dir>)`, no wildcard: `cd` takes one
 *     operand, so `:*` would only widen the match for nothing.
 */
function gateStepRule(step: string): string | null {
  if (!SAFE_GATE_STEP.test(step)) return null;
  if (PACKAGE_MANAGERS.has(step.split(/\s+/)[0] ?? "")) return `Bash(${step}:*)`;
  return CD_STEP.test(step) ? `Bash(${step})` : null;
}

/**
 * Permission allow-rules derived from the repo's own quality gate + package
 * manager. Three sources:
 *
 *   1. Every step of the gate (split on shell sequencers) — see `gateStepRule`.
 *      Claude Code splits a compound command and checks each sub-command
 *      separately, which is exactly why the gate kept prompting (#403): the rule
 *      for `pnpm test` was there, but `cd packages/cli` matched nothing, so
 *      `cd packages/cli && pnpm test` prompted on every run. The measured cost of
 *      that friction was the agent learning to wrap commands in `bash -c '…'` to
 *      dodge it — opaque to the guard hook, i.e. strictly worse than allowing the
 *      direct form.
 *   2. The gate string itself as an EXACT rule (no `:*`), covering the compound
 *      as typed — but only when EVERY step earned a rule of its own, so a gate
 *      with one hostile step contributes nothing at all.
 *   3. The `<pm> run <script>` dev-loop (build/test/lint/typecheck/format), since
 *      `build` in particular is rarely in the gate yet run constantly.
 *
 * SECURITY (#197, #403): `navori.config.json` is editable via PR, so a gate
 * string is NOT trusted — it is a value to validate, never a template to expand.
 * A step becomes a rule only when it is metacharacter-free (SAFE_GATE_STEP) AND
 * matches a known-inert shape; otherwise a `curl …|bash` gate would survive
 * GATE_SEQUENCERS (which doesn't split a bare pipe) as one step and get
 * auto-approved. Rejected steps still run; they just don't get a standing rule.
 * Note the asymmetry that keeps this closed: the only wildcard rule comes from a
 * package-manager step, and every rule emitted for a shape we did not fully
 * constrain is exact-match.
 */
function deriveQualityGateAllow(config: NavoriConfig): string[] {
  const rules = new Set<string>();
  for (const gate of [config.qualityGate?.fast, config.qualityGate?.full]) {
    if (!gate?.trim()) continue;
    const steps = gate.split(GATE_SEQUENCERS).map((s) => s.trim());
    const stepRules = steps.map((step) => (step ? gateStepRule(step) : null));
    for (const rule of stepRules) {
      if (rule) rules.add(rule);
    }
    // The compound as the user actually types it. Reconstructed from nothing —
    // it is the raw gate, trimmed — so it stays byte-identical to what CLAUDE.md
    // tells the agent to run; safe because every step that composes it passed
    // validation and the rule carries no wildcard.
    if (steps.length > 1 && stepRules.every((rule) => rule !== null)) {
      rules.add(`Bash(${gate.trim()})`);
    }
  }
  const pm = resolvePackageManager(config);
  if (pm) {
    const bare = BARE_SCRIPT_FORMS[pm] ?? new Set<string>();
    for (const script of DEV_LOOP_SCRIPTS) {
      rules.add(`Bash(${pm} run ${script}:*)`);
      if (bare.has(script)) rules.add(`Bash(${pm} ${script}:*)`);
    }
  }
  return [...rules];
}

/**
 * The final `permissions.allow`/`.ask`/`.deny` triple both engines translate
 * from — spec 0035 D5/T6 (R9). Extracted from `buildClaudeSettings` (Claude
 * still writes it into `.claude/settings.json` almost verbatim) so
 * `buildCodexRules` reads the SAME merged list instead of re-deriving it: the
 * invariant the two engines share a single source of terminal-permission
 * truth. Three layers, deep-merged in the same order `buildClaudeSettings`
 * always applied them:
 *
 *   1. `settings-base.json` (interpolated) — the shipped allow/ask/deny.
 *   2. Each enabled plugin's `settingsFragment.permissions`, in plugin order.
 *   3. `deriveQualityGateAllow(config)`, added to `.allow` last.
 *
 * Pure (no file writes); the caller decides what to do with the result.
 */
export function collectShellPermissionRules(
  config: NavoriConfig,
  plugins: readonly LoadedPlugin[],
): ShellPermissionRules {
  const basePath = resolve(getCoreRoot(), SETTINGS_BASE_REL);
  const baseRaw = readFileSync(basePath, "utf-8");
  const baseInterp = interpolate(baseRaw, config, {
    extraVars: { cliVersion: readCliVersion() },
  });
  const base = JSON.parse(baseInterp) as {
    permissions?: { allow?: string[]; ask?: string[]; deny?: string[] };
  };

  let merged: Record<string, unknown> = { permissions: base.permissions ?? {} };
  for (const plugin of plugins) {
    const fragment = plugin.manifest.settingsFragment;
    if (fragment && typeof fragment === "object" && !Array.isArray(fragment)) {
      const permissions = (fragment as Record<string, unknown>).permissions;
      if (permissions) merged = deepMerge(merged, { permissions });
    }
  }

  const derivedAllow = deriveQualityGateAllow(config);
  if (derivedAllow.length > 0) {
    merged = deepMerge(merged, { permissions: { allow: derivedAllow } });
  }

  const perm = (merged.permissions ?? {}) as { allow?: string[]; ask?: string[]; deny?: string[] };
  return { allow: perm.allow ?? [], ask: perm.ask ?? [], deny: perm.deny ?? [] };
}
