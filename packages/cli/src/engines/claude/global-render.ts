import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createBackup } from "../../lib/backup.ts";
import { readCliVersion } from "../../lib/bundled-assets.ts";
import { safeHomedir } from "../../lib/home.ts";
import { CORE_MANAGED_ASSETS, resolveAssetPath } from "../../lib/render-plan.ts";
import { resolveLang, tc } from "../../lib/i18n.ts";
import { deepMerge } from "./deep-merge.ts";
import type { GlobalConfig } from "../../lib/global-config.ts";

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

/** Path of the gate hook relative to the global config dir. */
export const GLOBAL_HOOK_REL = "hooks/navori-global-baseline.sh";

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

/** Absolute path of the installed gate hook under the global config dir. */
export function globalHookPath(dir = globalTargetDir()): string {
  return join(dir, GLOBAL_HOOK_REL);
}

/**
 * Compose the baseline prose from the selected core blocks. Enforces the §4
 * audit at runtime, in two layers.
 *
 * The FIRST is the asset's declared `globalSafe` (#541) — the actual property
 * being asserted. The second is the older `{{...}}` scan, kept as a secondary
 * net: it catches an asset marked `globalSafe` whose body later grows an
 * interpolation, without waiting for the inventory suite to run.
 *
 * The order matters. Testing `{{` alone is what let the two notions drift:
 * `arranque-sesion` stopped interpolating while still describing
 * `progress/current.md` and `navori doctor`, so the only check in place said
 * yes to a block that would have injected repo-specific prose into every
 * session of every project without navori.
 */
export function composeBaseline(config: GlobalConfig): string {
  const parts: string[] = [];
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
    if (/\{\{/.test(raw)) {
      throw new Error(
        `Block '${id}' interpolates repo config ({{...}}), so it can't be part of ` +
          `the global baseline (Spec 0010 §4). Remove it from blocks.include.`,
      );
    }
    if (raw.includes(HEREDOC)) {
      throw new Error(`Block '${id}' collides with the hook heredoc delimiter.`);
    }
    parts.push(raw);
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

/** The SessionStart registration navori merges into `~/.claude/settings.json`. */
export function hookSettingsFragment(hookAbsPath: string): Record<string, unknown> {
  return {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume|compact",
          hooks: [
            {
              type: "command",
              command: `bash "${hookAbsPath}"`,
              timeout: 15,
              statusMessage: "navori: global baseline",
            },
          ],
        },
      ],
    },
  };
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

/** True iff `<dir>/settings.json` already registers navori's baseline hook. */
export function settingsHasBaseline(dir = globalTargetDir()): boolean {
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
  if (read.kind !== "ok") return false; // same as settingsHasBaseline: can't prove it
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
  hookPath: string;
  hookScript: string;
  settingsPath: string;
  settings: Record<string, unknown>;
}

/**
 * Compute (without writing) every file the global render would produce: the
 * gate hook and the merged settings.json. The merged fragment carries BOTH the
 * SessionStart hook registration and the personal `permissions` from
 * `global.json` (Spec 0010). Merging over the user's existing settings means
 * navori never clobbers their other global hooks/permissions.
 *
 * THROWS when settings.json exists but cannot be read (#497). The repo-scoped
 * twin (`planSettings`) offers `--force` as a conscious escape hatch because the
 * pre-render backup plus git can bring that file back; `~/.claude/settings.json`
 * has neither, so there is no version of "overwrite anyway" worth offering —
 * the only way forward is fixing the JSON, which loses nothing.
 */
export function planGlobalRender(config: GlobalConfig, dir = globalTargetDir()): GlobalRenderPlan {
  const baseline = composeBaseline(config);
  const hookPath = globalHookPath(dir);
  const settingsPath = join(dir, "settings.json");
  const read = readExistingSettings(dir);
  if (read.kind === "parse-error" || read.kind === "not-object") {
    throw new Error(unreadableSettingsMessage(read, settingsPath, config.language));
  }
  const existing = read.kind === "ok" ? read.settings : {};
  const fragment = deepMerge(hookSettingsFragment(hookPath), permissionsFragment(config));
  const settings = deepMerge(existing, fragment);
  return {
    dir,
    hookPath,
    hookScript: generateHookScript(baseline),
    settingsPath,
    settings,
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
 * Write the plan to disk: gate hook (executable) + merged settings.json.
 * Returns the backup dir holding the previous settings.json, or null when there
 * was none to save. Throws before writing anything if the backup fails — losing
 * the user's machine-wide config is worse than not installing the baseline.
 */
export function applyGlobalRender(plan: GlobalRenderPlan): string | null {
  const backupPath = backupSettings(plan.dir, plan.settingsPath);
  mkdirSync(dirname(plan.hookPath), { recursive: true });
  writeFileSync(plan.hookPath, plan.hookScript);
  chmodSync(plan.hookPath, 0o755);
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

export interface GlobalUninstallResult {
  removedHook: boolean;
  updatedSettings: boolean;
  /** settings.json exists but could not be parsed, so it was left untouched. */
  settingsUnreadable: boolean;
  /** Backup dir holding the settings.json as it was before the rewrite. */
  backupPath: string | null;
}

/**
 * Remove ONLY navori's global footprint: the gate hook file and its SessionStart
 * registration. Any other global hook/skill/plugin/permission the user has is
 * left intact (§3.1 requirement 3).
 */
export function uninstallGlobalRender(dir = globalTargetDir()): GlobalUninstallResult {
  const hookPath = globalHookPath(dir);
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
    const after = stripBaselineFromSettings(read.settings);
    if (JSON.stringify(after) !== JSON.stringify(read.settings)) {
      backupPath = backupSettings(dir, settingsPath);
      writeFileSync(settingsPath, `${JSON.stringify(after, null, 2)}\n`);
      updatedSettings = true;
    }
  }
  return { removedHook, updatedSettings, settingsUnreadable, backupPath };
}
