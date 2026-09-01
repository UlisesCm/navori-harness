import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createBackup } from "../../lib/backup.ts";
import { createMigrationSnapshot } from "../../lib/migrate.ts";
import { readCliVersion } from "../../lib/bundled-assets.ts";
import { safeHomedir } from "../../lib/home.ts";
import { CORE_MANAGED_ASSETS, resolveAssetPath } from "../../lib/render-plan.ts";
import { interpolate } from "../../lib/interpolate.ts";
import type { NavoriConfig } from "../../lib/schema.ts";
import { resolveLang, tc } from "../../lib/i18n.ts";
import { deepMerge } from "./deep-merge.ts";
import {
  PERMISSION_KINDS,
  type GlobalConfig,
  type PermissionBag,
} from "../../lib/global-config.ts";

/**
 * Renders the OPTIONAL global harness (Spec 0010 F1) into Claude Code's global
 * config dir. This module is Claude-specific — it targets `~/.claude` and reuses
 * Claude's `deepMerge` — so it lives in `engines/claude/`, not the engine-agnostic
 * `lib/` layer (#227). It stays entirely OUTSIDE the repo render pipeline
 * (render-plan / execute-plan / engine adapters), so it cannot alter repo-scoped
 * behaviour — the zero-footprint invariant (§2.4). It only *reads* from the core
 * (block bodies via `lib/render-plan`) and merges to preserve whatever the user
 * already has in `~/.claude/settings.json`.
 *
 * The baseline is delivered by a SessionStart hook with a gate, NOT a static
 * `~/.claude/CLAUDE.md` block: Claude Code loads that file unconditionally, so
 * a static block could never step aside for a repo's own harness. The hook can
 * (§3.1).
 */

/** Filename of the gate hook, wherever it is installed. */
export const GLOBAL_HOOK_BASENAME = "navori-global-baseline.sh";

/**
 * Where F1 installed the gate hook: loose under the Claude config dir, with its
 * registration merged into the user's `~/.claude/settings.json`. FB moved both
 * into the `@skills-dir` plugin (`engines/claude/global-plugin.ts`), so this
 * path now exists only to MIGRATE an older install off it — nothing renders
 * here anymore.
 */
export const LEGACY_GLOBAL_HOOK_REL = `hooks/${GLOBAL_HOOK_BASENAME}`;

/** Label of the FB migration snapshot under `~/.navori/migrations/<timestamp>/`. */
export const LEGACY_MIGRATION_LABEL = "claude-global";

/** Heredoc delimiter for the embedded baseline. Unique enough to never collide. */
const HEREDOC = "NAVORI_GLOBAL_BASELINE_EOF_9f3a";

/**
 * Claude Code's global config dir: `CLAUDE_CONFIG_DIR` if set (that is how
 * Claude Code itself resolves it), else `~/.claude`. A relative override is
 * resolved against the cwd.
 */
export function globalTargetDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override && override.trim().length > 0) return resolve(override.trim());
  return join(safeHomedir(), ".claude");
}

/** Absolute path of the F1-era gate hook (migration source only — see above). */
export function legacyGlobalHookPath(dir = globalTargetDir()): string {
  return join(dir, LEGACY_GLOBAL_HOOK_REL);
}

/**
 * The config the global render interpolates assets against (Spec 0010 FB).
 *
 * Deliberately NOT a `NavoriConfigSchema.parse(...)`: the schema defaults
 * `branchBase` to `"main"`, which would bake one repo's answer into files that
 * every project on the machine reads. The three repo-truths (`qualityGate.*`,
 * `branchBase`, `prTarget`) are left ABSENT so the interpolator's `global`
 * fallback scope answers them with the instruction to DERIVE them
 * (`lib/placeholders.ts`). Everything else is either harness config the global
 * scope legitimately carries, or a path whose generic fallback is already
 * written for the repo that declares nothing.
 */
export function globalRenderConfig(config: GlobalConfig): NavoriConfig {
  return {
    name: "navori-global",
    language: config.language,
    engines: ["claude"],
    // `{{sdd.specsDir}}` has a sane default in either scope; the SDD managed
    // block itself stays out of the baseline (it is `condition`-gated).
    sdd: { enabled: true, specsDir: "specs", applyWhen: [], doesNotApplyTo: [] },
    // Empty, not absent: `project.criticalAreas` / `project.legacyPaths` then
    // resolve through their generic soft fallbacks — the same text a repo that
    // declares none already gets.
    project: {},
  } as unknown as NavoriConfig;
}

/**
 * Compose the baseline prose from the selected core blocks. Enforces the §4
 * audit at runtime, in two layers.
 *
 * The FIRST is the asset's declared `globalSafe` (#541) — the actual property
 * being asserted. The second is the unresolved-placeholder scan below, kept as
 * a secondary net: it catches an asset marked `globalSafe` whose body later
 * grows a placeholder with no answer in this scope, without waiting for the
 * inventory suite to run.
 *
 * The order matters. Testing for the mere PRESENCE of `{{` is what let the two
 * notions drift before #541: `arranque-sesion` stopped interpolating while
 * still describing `progress/current.md` and `navori doctor`, so the only check
 * in place said yes to a block that would have injected repo-specific prose
 * into every session of every project without navori.
 *
 * FB (#546) narrowed that scan rather than dropping it. Blocks are now
 * interpolated in the `global` fallback scope — `{{qualityGate.full}}` and
 * `{{branchBase}}` render as the instruction to derive them, so `orquestacion`
 * composes the baseline whole instead of needing to be split — and what fails
 * is a placeholder that resolved to NOTHING, which is the real defect.
 */
export function composeBaseline(config: GlobalConfig): string {
  const parts: string[] = [];
  const renderConfig = globalRenderConfig(config);
  for (const id of config.blocks.include) {
    const asset = CORE_MANAGED_ASSETS.find((a) => a.id === id);
    if (!asset) {
      throw new Error(`Global baseline references unknown core block '${id}'.`);
    }
    if (!asset.globalSafe) {
      throw new Error(
        `Block '${id}' is not marked globalSafe, so it can't be part of the global ` +
          `baseline (Spec 0010 §4). Remove it from blocks.include.`,
      );
    }
    const raw = readFileSync(resolveAssetPath(asset, config.language).path, "utf-8").trim();
    const rendered = interpolate(raw, renderConfig, { fallbackScope: "global" });
    const unresolved = rendered.match(/<not configured: [^>]+>/g);
    if (unresolved) {
      throw new Error(
        `Block '${id}' has ${[...new Set(unresolved)].join(", ")} with no answer in the ` +
          `global scope (Spec 0010 §4). Give the path a global fallback in ` +
          `lib/placeholders.ts, or remove the block from blocks.include.`,
      );
    }
    if (rendered.includes(HEREDOC)) {
      throw new Error(`Block '${id}' collides with the hook heredoc delimiter.`);
    }
    parts.push(rendered);
  }
  const intro = tc(resolveLang(config.language)).engine.globalBaselineIntro;
  return `${intro}\n\n${parts.join("\n\n")}\n`;
}

/**
 * Digest placeholder held in the marker while the script is being composed, so
 * the hash can cover the marker line's own bytes without chasing its tail.
 */
const HASH_PLACEHOLDER = "0".repeat(16);

/**
 * The authorship marker navori stamps into the generated hook (#542). Until it
 * existed, the hook was the ONE managed artifact navori wrote with no marker
 * and no hash: `global doctor` could only compare `global.json`'s version
 * against the CLI's, so a hand-edited hook — or an asset that changed inside a
 * single CLI version — was invisible and doctor reported "up to date". This is
 * the same `navori:managed version="X"` notation the rest of the pipeline uses
 * (and that #538 taught the prune to read), plus a digest, because unlike a
 * CLAUDE.md block the hook has no surrounding user zone to diff against.
 */
const HOOK_MARKER_RE = /^# navori:managed version="([^"]*)" hash="([0-9a-f]{16})"$/m;

/** Short digest of a rendered hook script. */
function hookDigest(script: string): string {
  return createHash("sha256").update(script, "utf-8").digest("hex").slice(0, 16);
}

/**
 * Generate the gate hook script. It defers (emits nothing) when the current
 * project has a `navori.config.json` at cwd or any ancestor — repo-local or a
 * workspace member — because that repo already carries the harness. Otherwise
 * it emits the baseline as SessionStart `additionalContext`.
 *
 * Composed twice on purpose: once with a placeholder digest, then again with
 * the digest OF that draft. The hash therefore covers every byte of the script
 * — gate logic included, not just the baseline prose — which is what lets
 * `readHookDrift` tell "someone edited this file" from "this file is stale".
 */
export function generateHookScript(baseline: string, version = readCliVersion()): string {
  const draft = composeHookScript(baseline, version, HASH_PLACEHOLDER);
  return composeHookScript(baseline, version, hookDigest(draft));
}

function composeHookScript(baseline: string, version: string, hash: string): string {
  return `#!/usr/bin/env bash
# navori:managed version="${version}" hash="${hash}"
#
# navori global baseline — Spec 0010. MANAGED BY NAVORI; do not edit by hand.
# Installed by \`navori global init\`, regenerated by \`navori global render\`,
# removed by \`navori global uninstall\`. The marker line above carries the
# digest of this file; \`navori global doctor\` recomputes it, so a hand edit
# here is reported instead of silently surviving the next render.
#
# Delivers a repo-agnostic harness baseline as SessionStart context, but ONLY
# when the current project has NO navori config of its own. A repo with a
# navori.config.json (local or workspace member) already carries the harness,
# so this global layer steps aside (defer) — the zero-double-emission gate of
# Spec 0010 §3.1.
set -euo pipefail
cat >/dev/null 2>&1 || true   # drain the SessionStart JSON on stdin (unused)

# --- Gate: defer if the project has its own navori config -------------------
dir="$PWD"
while :; do
  [ -f "$dir/navori.config.json" ] && exit 0   # repo harness present -> defer
  [ "$dir" = "/" ] && break
  dir="$(dirname "$dir")"
done

# --- No repo navori config -> emit the global baseline ----------------------
# The heredoc lives in a FUNCTION, never directly inside \`$( … )\`: bash 3.2 —
# still /bin/bash on macOS — parses the body of a command substitution before it
# honors the heredoc's quoting, so a lone \`'\` in the prose aborts the whole hook
# with "unexpected EOF while looking for matching \`''". That made the baseline
# depend on the APOSTROPHE PARITY of the assets embedded in it: the day an edit
# left an odd count, every session without a repo harness lost its baseline.
# Wrapped in a function the heredoc is parsed on its own and the substitution
# sees a plain command name.
navori_baseline() {
cat <<'${HEREDOC}'
${baseline}
${HEREDOC}
}
BASELINE=$(navori_baseline)

[ -n "$BASELINE" ] || exit 0
if command -v node >/dev/null 2>&1; then
  BASELINE="$BASELINE" node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:process.env.BASELINE}}))'
elif command -v jq >/dev/null 2>&1; then
  jq -n --arg c "$BASELINE" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}'
fi
exit 0
`;
}

/**
 * What the installed hook is, relative to what the CLI would render now (#542).
 * `hand-edited` and `stale` are DIFFERENT facts and deserve different advice:
 * the first means someone changed a managed file and the next render will
 * discard that change, the second means the file is intact but behind (a bumped
 * CLI, or a baseline asset edited inside one version — the case doctor could
 * never see). `unmarked` is a hook written by a navori older than #542.
 */
export type HookDrift =
  | { kind: "ok" }
  | { kind: "absent" }
  | { kind: "unmarked" }
  | { kind: "hand-edited" }
  | { kind: "stale"; installedVersion: string; expectedVersion: string };

/**
 * Compare the hook on disk against `expected` (normally `plan.hookScript`).
 *
 * Hand-editing is checked FIRST and on the file's own terms — recomputing the
 * digest over its own bytes — so it is reported even when the CLI would have
 * rendered something different anyway. Reporting a hand edit as mere staleness
 * would tell the user to run `render --apply`, which silently destroys the edit
 * without ever naming it.
 */
export function readHookDrift(hookPath: string, expected: string): HookDrift {
  if (!existsSync(hookPath)) return { kind: "absent" };
  const onDisk = readFileSync(hookPath, "utf-8");
  const found = HOOK_MARKER_RE.exec(onDisk);
  if (!found) return { kind: "unmarked" };
  // Defaults only to satisfy `noUncheckedIndexedAccess`: both groups are
  // mandatory in the regex, so a non-null `found` always carries them.
  const [markerLine = "", installedVersion = "", declared = ""] = found;
  const withPlaceholder = onDisk.replace(
    markerLine,
    markerLine.replace(`hash="${declared}"`, `hash="${HASH_PLACEHOLDER}"`),
  );
  if (hookDigest(withPlaceholder) !== declared) return { kind: "hand-edited" };
  if (onDisk === expected) return { kind: "ok" };
  return {
    kind: "stale",
    installedVersion,
    expectedVersion: HOOK_MARKER_RE.exec(expected)?.[1] ?? readCliVersion(),
  };
}

/**
 * What actually happens when the gate runs (#543). Until this existed, doctor
 * checked that the hook FILE was there and that settings.json registered it —
 * never that running it produces anything. Two silent failures lived in that
 * gap, and both end with every session missing its baseline while doctor
 * reports green:
 *
 *   - `no-json-tool`: the hook needs `node` or `jq` to emit its JSON and exits
 *     0 mutely without either. Realistic under nvm, where `node` reaches PATH
 *     from the user's shell rc — a Claude Code launched from the macOS app
 *     bundle can start with a minimal PATH that has neither.
 *   - `no-emit` / `no-defer`: the gate itself is broken (a shell error swallowed
 *     by `set -e`, an unbalanced heredoc), so it emits nothing where it should,
 *     or emits the baseline INSIDE a repo that carries its own harness — the
 *     double-emission Spec 0010 §3.1 exists to prevent.
 */
export type GateProbe =
  | { kind: "ok" }
  | { kind: "no-json-tool" }
  | { kind: "no-emit" }
  | { kind: "no-defer" }
  | { kind: "malformed"; detail: string }
  | { kind: "error"; detail: string };

/** Run the hook with `cwd`, draining stdin the way Claude Code's SessionStart does. */
function runHook(hookPath: string, cwd: string): { stdout: string } | { error: string } {
  try {
    return {
      stdout: execFileSync("bash", [hookPath], {
        cwd,
        input: "{}",
        encoding: "utf-8",
        timeout: 15_000,
        // stderr is captured rather than inherited: a hook that warns should not
        // scribble over doctor's own report.
        stdio: ["pipe", "pipe", "pipe"],
      }),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** True iff the hook would find one of the two tools it can emit JSON with. */
function hasJsonTool(): boolean {
  try {
    execFileSync(
      "bash",
      ["-c", "command -v node >/dev/null 2>&1 || command -v jq >/dev/null 2>&1"],
      {
        stdio: "ignore",
        timeout: 5_000,
      },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute the installed hook in two throwaway directories and report what it
 * did: one with no `navori.config.json` anywhere above it (must emit the
 * baseline) and one carrying a config (must emit nothing). Both live under the
 * OS temp dir, whose ancestors never hold a navori config, so the "clean" case
 * is genuinely clean.
 */
export function probeGate(hookPath: string): GateProbe {
  const clean = mkdtempSync(join(tmpdir(), "navori-gate-clean-"));
  const repo = mkdtempSync(join(tmpdir(), "navori-gate-repo-"));
  try {
    writeFileSync(join(repo, "navori.config.json"), "{}\n");

    const deferred = runHook(hookPath, repo);
    if ("error" in deferred) return { kind: "error", detail: deferred.error };
    if (deferred.stdout.trim() !== "") return { kind: "no-defer" };

    const emitted = runHook(hookPath, clean);
    if ("error" in emitted) return { kind: "error", detail: emitted.error };
    if (emitted.stdout.trim() === "") {
      // An empty emit has two very different causes, and the remediation
      // differs: install a tool, versus the gate is broken.
      return hasJsonTool() ? { kind: "no-emit" } : { kind: "no-json-tool" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(emitted.stdout);
    } catch (err) {
      return { kind: "malformed", detail: err instanceof Error ? err.message : String(err) };
    }
    const context = (parsed as { hookSpecificOutput?: { additionalContext?: unknown } } | null)
      ?.hookSpecificOutput?.additionalContext;
    if (typeof context !== "string" || context.trim() === "") {
      return { kind: "malformed", detail: "hookSpecificOutput.additionalContext" };
    }
    return { kind: "ok" };
  } finally {
    rmSync(clean, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
}

/**
 * The personal permissions navori merges additively into `~/.claude/settings.json`
 * (Spec 0010 — `global.json.permissions`). Only non-empty buckets are emitted so
 * an empty config leaves no `permissions` residue; `deepMerge` then concatenates
 * and dedupes them against whatever the user already has (never clobbers).
 */
export function permissionsFragment(config: GlobalConfig): Record<string, unknown> {
  const perms: Record<string, string[]> = {};
  for (const kind of ["allow", "deny", "ask"] as const) {
    const list = config.permissions[kind];
    if (list.length > 0) perms[kind] = list;
  }
  return Object.keys(perms).length > 0 ? { permissions: perms } : {};
}

/**
 * What `<dir>/settings.json` holds right now. "Absent" and "unreadable" are
 * DIFFERENT facts and this type refuses to conflate them (#497): absent means
 * there is nothing to preserve, unreadable means the user's machine-wide config
 * IS there and we just cannot understand it — merging over it would destroy
 * their model, env, hooks and permissions with no way back (unlike the
 * repo-scoped `.claude/settings.json`, git tracks nothing here).
 */
export type GlobalSettingsRead =
  | { kind: "absent" }
  | { kind: "ok"; settings: Record<string, unknown> }
  | { kind: "parse-error"; detail: string }
  | { kind: "not-object" };

/**
 * Read the existing global settings.json. A file that exists but cannot be
 * parsed (or does not hold a JSON object) comes back as its own kind, so each
 * caller decides what that means for it — never as an empty object.
 */
export function readExistingSettings(dir: string): GlobalSettingsRead {
  const path = join(dir, "settings.json");
  if (!existsSync(path)) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    return { kind: "parse-error", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "not-object" };
  return { kind: "ok", settings: parsed as Record<string, unknown> };
}

/**
 * Localized explanation of why the global settings.json cannot be merged into,
 * naming the file and (for a syntax error) the parser's own message — the same
 * contract `planSettings` honours for the repo-scoped file.
 */
export function unreadableSettingsMessage(
  read: Extract<GlobalSettingsRead, { kind: "parse-error" | "not-object" }>,
  path: string,
  language?: string,
): string {
  const g = tc(resolveLang(language)).global;
  return read.kind === "parse-error"
    ? g.settingsParseFailed(path, read.detail)
    : g.settingsNotObject(path);
}

/**
 * True iff `<dir>/settings.json` still carries the F1-era SessionStart
 * registration. FB stopped writing it — the plugin's `hooks/hooks.json` owns
 * the gate now — so this reports a leftover to migrate, never a healthy state.
 */
export function settingsHasLegacyHook(dir = globalTargetDir()): boolean {
  const read = readExistingSettings(dir);
  // Unreadable counts as "not registered": doctor's job is to report what it can
  // PROVE is in place, and a file it cannot parse proves nothing (#497).
  if (read.kind !== "ok") return false;
  const hooks = read.settings.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  const sessionStart = (hooks as Record<string, unknown>).SessionStart;
  if (!Array.isArray(sessionStart)) return false;
  return sessionStart.some((bucket) => {
    const inner = (bucket as { hooks?: unknown })?.hooks;
    return Array.isArray(inner) && inner.some(isNavoriBaselineHook);
  });
}

/**
 * True iff every permission configured in `global.json` is already present in
 * `<dir>/settings.json`. Vacuously true when nothing is configured — `doctor`
 * only surfaces this check when the user actually declared permissions.
 */
export function settingsHasPermissions(config: GlobalConfig, dir = globalTargetDir()): boolean {
  const read = readExistingSettings(dir);
  if (read.kind !== "ok") return false; // same as settingsHasLegacyHook: can't prove it
  const perms = read.settings.permissions;
  const bag =
    perms && typeof perms === "object" && !Array.isArray(perms)
      ? (perms as Record<string, unknown>)
      : {};
  for (const kind of ["allow", "deny", "ask"] as const) {
    const want = config.permissions[kind];
    if (want.length === 0) continue;
    const have = Array.isArray(bag[kind]) ? (bag[kind] as unknown[]) : [];
    if (!want.every((w) => have.includes(w))) return false;
  }
  return true;
}

/** Total number of permission entries configured across allow/deny/ask. */
export function configuredPermissionsCount(config: GlobalConfig): number {
  return (
    config.permissions.allow.length + config.permissions.deny.length + config.permissions.ask.length
  );
}

export interface GlobalRenderPlan {
  dir: string;
  settingsPath: string;
  settings: Record<string, unknown>;
  /**
   * Whether the merge changes anything. Since FB moved the hook registration
   * into the plugin, a config with no `permissions` produces a settings object
   * identical to what is on disk — and rewriting the user's machine-wide
   * settings.json to change nothing is a backup, a reformat and a mtime bump
   * they did not ask for.
   */
  settingsChanged: boolean;
  /**
   * The permission entries navori will own once this plan is applied (#544).
   * The caller persists it to `global.json` after a successful apply — that
   * record is the ONLY thing that can tell navori's permissions from the user's
   * later on, and it can only be computed here, before the merge erases the
   * difference.
   */
  ownedPermissions: PermissionBag;
}

/**
 * The `permissions` object of a settings.json, normalized to three string lists.
 * Exported for the cross-scope doctor check (#547): it needs the SAME notion of
 * a permission bag on both scopes, and a second normalizer would be a second
 * definition of what counts as a rule.
 */
export function permissionBagOf(settings: Record<string, unknown>): Record<string, string[]> {
  const perms = settings.permissions;
  const raw =
    perms && typeof perms === "object" && !Array.isArray(perms)
      ? (perms as Record<string, unknown>)
      : {};
  const bag: Record<string, string[]> = {};
  for (const kind of PERMISSION_KINDS) {
    const list = raw[kind];
    bag[kind] = Array.isArray(list) ? list.filter((e): e is string => typeof e === "string") : [];
  }
  return bag;
}

/**
 * Which permission entries navori owns after a merge (#544).
 *
 * An entry is navori's when THIS render introduced it — declared in
 * `global.json` and absent from settings.json beforehand — or when a previous
 * render already claimed it. An entry the user already had stays theirs forever,
 * even when `permissions` also declares it: uninstall must never delete a rule
 * that predates navori.
 *
 * The result is intersected with what the merge actually produced, so the record
 * cannot accumulate entries that are no longer on disk. An entry navori added
 * and the user later dropped from `permissions` stays owned as long as it is
 * still in settings.json — the merge never removes it, so uninstall is what
 * eventually has to.
 */
function computeOwnedPermissions(
  config: GlobalConfig,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): PermissionBag {
  const beforeBag = permissionBagOf(before);
  const afterBag = permissionBagOf(after);
  const owned: PermissionBag = { allow: [], deny: [], ask: [] };
  for (const kind of PERMISSION_KINDS) {
    const introduced = config.permissions[kind].filter((e) => !beforeBag[kind]?.includes(e));
    const claimed = new Set([...config.ownedPermissions[kind], ...introduced]);
    owned[kind] = [...claimed].filter((e) => afterBag[kind]?.includes(e));
  }
  return owned;
}

/**
 * Compute (without writing) what the global render leaves in the user's
 * `~/.claude/settings.json`: their personal `permissions`, merged additively,
 * and nothing else. FB moved the SessionStart registration into the plugin's
 * own `hooks/hooks.json`, so this file is no longer where navori installs
 * behaviour — only where it adds permission rules the user asked for.
 *
 * Merging over the existing object means navori never clobbers the other hooks,
 * permissions and settings the user has there.
 *
 * THROWS when settings.json exists but cannot be read (#497). The repo-scoped
 * twin (`planSettings`) offers `--force` as a conscious escape hatch because the
 * pre-render backup plus git can bring that file back; `~/.claude/settings.json`
 * has neither, so there is no version of "overwrite anyway" worth offering —
 * the only way forward is fixing the JSON, which loses nothing.
 */
export function planGlobalRender(config: GlobalConfig, dir = globalTargetDir()): GlobalRenderPlan {
  const settingsPath = join(dir, "settings.json");
  const read = readExistingSettings(dir);
  if (read.kind === "parse-error" || read.kind === "not-object") {
    throw new Error(unreadableSettingsMessage(read, settingsPath, config.language));
  }
  const existing = read.kind === "ok" ? read.settings : {};
  const settings = deepMerge(existing, permissionsFragment(config));
  return {
    dir,
    settingsPath,
    settings,
    settingsChanged: JSON.stringify(settings) !== JSON.stringify(existing),
    ownedPermissions: computeOwnedPermissions(config, existing, settings),
  };
}

/**
 * Snapshot the settings.json we are about to overwrite into `~/.navori/backups`,
 * returning the snapshot dir (null when there is no file yet — a first install
 * destroys nothing). The repo render gets this from `commitWrites`; the global
 * render is outside that pipeline (§2.4), so it takes its own.
 *
 * Backs up EXACTLY the one file it will rewrite, never `dir`: the Claude config
 * dir also holds `projects/` (every session transcript) and agent worktrees, and
 * walking a dir like that into a backup on every render is the #348 mistake that
 * grew to 131 GB until `ENOSPC` broke render itself.
 */
function backupSettings(dir: string, settingsPath: string): string | null {
  if (!existsSync(settingsPath)) return null;
  return createBackup(dir, ["settings.json"]).path;
}

/**
 * Write the merged settings.json. Returns the backup dir holding the previous
 * one, or null when there was nothing to save or nothing to change. Throws
 * before writing anything if the backup fails — losing the user's machine-wide
 * config is worse than not merging a permission.
 */
export function applyGlobalRender(plan: GlobalRenderPlan): string | null {
  if (!plan.settingsChanged) return null;
  const backupPath = backupSettings(plan.dir, plan.settingsPath);
  mkdirSync(dirname(plan.settingsPath), { recursive: true });
  writeFileSync(plan.settingsPath, `${JSON.stringify(plan.settings, null, 2)}\n`);
  return backupPath;
}

/** True iff a SessionStart hook entry points at navori's global baseline. */
function isNavoriBaselineHook(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const cmd = (entry as { command?: unknown }).command;
  return typeof cmd === "string" && cmd.includes("navori-global-baseline.sh");
}

/**
 * Strip navori's global baseline from an existing settings object, leaving every
 * other hook, permission and key untouched. Returns a new object (no mutation).
 * Empty `hooks`/`SessionStart` containers are pruned so uninstall leaves no
 * navori residue.
 */
export function stripBaselineFromSettings(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return settings;
  const sessionStart = (hooks as Record<string, unknown>).SessionStart;
  if (!Array.isArray(sessionStart)) return settings;

  const cleanedBuckets = sessionStart
    .map((bucket) => {
      if (!bucket || typeof bucket !== "object") return bucket;
      const inner = (bucket as { hooks?: unknown }).hooks;
      if (!Array.isArray(inner)) return bucket;
      const kept = inner.filter((h) => !isNavoriBaselineHook(h));
      return { ...(bucket as object), hooks: kept };
    })
    .filter((bucket) => {
      const inner = (bucket as { hooks?: unknown })?.hooks;
      return !Array.isArray(inner) || inner.length > 0;
    });

  const nextHooks: Record<string, unknown> = { ...(hooks as Record<string, unknown>) };
  if (cleanedBuckets.length > 0) nextHooks.SessionStart = cleanedBuckets;
  else delete nextHooks.SessionStart;

  const next: Record<string, unknown> = { ...settings };
  if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks;
  else delete next.hooks;
  return next;
}

/**
 * What an F1-era install still has on disk (Spec 0010 FB migration, #546).
 * Either half can be present on its own: a user who deleted the hook file by
 * hand keeps the dangling registration, and vice versa.
 */
export interface LegacyGlobalHook {
  hookPath: string;
  filePresent: boolean;
  registeredInSettings: boolean;
}

/** Detect the F1 layout. `filePresent || registeredInSettings` ⇒ migrate. */
export function detectLegacyGlobalHook(dir = globalTargetDir()): LegacyGlobalHook {
  const hookPath = legacyGlobalHookPath(dir);
  return {
    hookPath,
    filePresent: existsSync(hookPath),
    registeredInSettings: settingsHasLegacyHook(dir),
  };
}

export interface LegacyMigrationResult {
  /** Where the removed files were copied, browsable with `navori migrations list`. */
  snapshotPath: string | null;
  removedHook: boolean;
  updatedSettings: boolean;
  /** settings.json is there but unparseable, so its registration was left alone. */
  settingsUnreadable: boolean;
}

/**
 * Move an F1 install onto the FB layout: delete the loose gate hook and drop
 * its SessionStart entry from the user's `~/.claude/settings.json`, because the
 * plugin's `hooks/hooks.json` now registers the same gate. Running both would
 * emit the baseline twice in every session without a repo harness.
 *
 * It snapshots what it removes into `~/.navori/migrations/` first. Neither file
 * is under version control — `~/.claude/settings.json` least of all — so this
 * is the only way back, and `navori migrations restore <ts> claude-global --cwd
 * ~/.claude` is the way to take it.
 *
 * A no-op (all-false, null snapshot) when there is no F1 install to migrate,
 * which is every fresh machine.
 */
export function migrateLegacyGlobalHook(dir = globalTargetDir()): LegacyMigrationResult {
  const legacy = detectLegacyGlobalHook(dir);
  if (!legacy.filePresent && !legacy.registeredInSettings) {
    return {
      snapshotPath: null,
      removedHook: false,
      updatedSettings: false,
      settingsUnreadable: false,
    };
  }

  const snapshot = createMigrationSnapshot(dir, LEGACY_MIGRATION_LABEL, [
    LEGACY_GLOBAL_HOOK_REL,
    "settings.json",
  ]);

  let removedHook = false;
  if (legacy.filePresent) {
    rmSync(legacy.hookPath);
    removedHook = true;
  }

  let updatedSettings = false;
  let settingsUnreadable = false;
  const read = readExistingSettings(dir);
  if (read.kind === "parse-error" || read.kind === "not-object") {
    settingsUnreadable = true;
  } else if (read.kind === "ok") {
    const stripped = stripBaselineFromSettings(read.settings);
    if (JSON.stringify(stripped) !== JSON.stringify(read.settings)) {
      writeFileSync(join(dir, "settings.json"), `${JSON.stringify(stripped, null, 2)}\n`);
      updatedSettings = true;
    }
  }

  return { snapshotPath: snapshot.path, removedHook, updatedSettings, settingsUnreadable };
}

export interface GlobalUninstallResult {
  removedHook: boolean;
  updatedSettings: boolean;
  /** settings.json exists but could not be parsed, so it was left untouched. */
  settingsUnreadable: boolean;
  /** Backup dir holding the settings.json as it was before the rewrite. */
  backupPath: string | null;
}

/**
 * Strip the permission entries navori recorded as its own, leaving every other
 * rule untouched (#544). Empty buckets and an emptied `permissions` object are
 * pruned so uninstall leaves no husk behind.
 *
 * Deliberately driven by the RECORD, never by `config.permissions`: the two
 * differ exactly where it matters. A rule the user already had before installing
 * is declared but not owned, and removing it would delete something navori never
 * added — the failure mode that made leaving all of them behind the safer bug.
 */
export function stripOwnedPermissions(
  settings: Record<string, unknown>,
  owned: PermissionBag,
): Record<string, unknown> {
  const perms = settings.permissions;
  if (!perms || typeof perms !== "object" || Array.isArray(perms)) return settings;

  const before = perms as Record<string, unknown>;
  const after: Record<string, unknown> = { ...before };
  let changed = false;
  for (const kind of PERMISSION_KINDS) {
    const mine = owned[kind];
    const have = before[kind];
    if (mine.length === 0 || !Array.isArray(have)) continue;
    const kept = have.filter((e) => !(typeof e === "string" && mine.includes(e)));
    if (kept.length === have.length) continue;
    changed = true;
    if (kept.length > 0) after[kind] = kept;
    else delete after[kind];
  }
  if (!changed) return settings;

  const next: Record<string, unknown> = { ...settings };
  if (Object.keys(after).length > 0) next.permissions = after;
  else delete next.permissions;
  return next;
}

/**
 * Remove navori's footprint from the Claude config dir's own files: any F1-era
 * gate hook still loose there, its SessionStart registration, and the permission
 * entries `config.ownedPermissions` records as navori's (#544). Any other global
 * hook/skill/plugin/permission the user has is left intact (§3.1 requirement 3).
 *
 * The `@skills-dir` plugin is removed by its own module (`removeGlobalPlugin`);
 * the command calls both. Splitting them keeps this file free of an import
 * cycle — `global-plugin.ts` renders the hook script from here.
 *
 * `config` is optional because uninstall must still work when `global.json` is
 * gone or unreadable: without it the hook still goes, and permissions are left
 * alone rather than guessed at.
 */
export function uninstallGlobalRender(
  dir = globalTargetDir(),
  config?: GlobalConfig | null,
): GlobalUninstallResult {
  const hookPath = legacyGlobalHookPath(dir);
  let removedHook = false;
  if (existsSync(hookPath)) {
    rmSync(hookPath);
    removedHook = true;
  }

  const settingsPath = join(dir, "settings.json");
  let updatedSettings = false;
  let settingsUnreadable = false;
  let backupPath: string | null = null;
  const read = readExistingSettings(dir);
  // Uninstall never aborts on an unreadable file the way the render does: the
  // hook removal still succeeds and refusing it would trap the user. It just
  // does not touch what it cannot understand, and says so (#497).
  if (read.kind === "parse-error" || read.kind === "not-object") {
    settingsUnreadable = true;
  } else if (read.kind === "ok") {
    const withoutHook = stripBaselineFromSettings(read.settings);
    const after = config
      ? stripOwnedPermissions(withoutHook, config.ownedPermissions)
      : withoutHook;
    if (JSON.stringify(after) !== JSON.stringify(read.settings)) {
      backupPath = backupSettings(dir, settingsPath);
      writeFileSync(settingsPath, `${JSON.stringify(after, null, 2)}\n`);
      updatedSettings = true;
    }
  }
  return { removedHook, updatedSettings, settingsUnreadable, backupPath };
}
