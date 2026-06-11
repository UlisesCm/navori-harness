import { existsSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { NavoriConfig } from "../../lib/config.ts";
import { writeFileAtomic } from "../../lib/atomic.ts";
import { createBackup, purgeOldBackups } from "../../lib/backup.ts";
import { loadEnabledPlugins } from "../../lib/plugins.ts";
import { computeRenderPlan, type AssetPlanEntry, type UpdateAvailable } from "../../lib/render-plan.ts";
import { getCoreRoot, readBundledCoreVersion } from "../../lib/bundled-assets.ts";
import type { RenderStatus } from "../../lib/style.ts";
import { isNavoriOwnedSettings } from "./settings-detection.ts";
import { buildClaudeSettings } from "./build-settings.ts";
import { renderManagedFile } from "./render-managed-file.ts";
import { interpolate } from "./interpolate.ts";

/**
 * Claude engine adapter — entry point. Orchestrates the full render of a
 * `.claude/` tree against a NavoriConfig:
 *
 *   - CLAUDE.md          (delegated to computeRenderPlan; existing flow)
 *   - .claude/settings.json   (built from settings-base + plugins + qg hook)
 *   - .claude/agents/<role>.md  for each role enabled in config.harness
 *   - .claude/skills/<id>.md    for each core skill (always-on for now)
 *   - .claude/hooks/quality-gate-pre-commit.sh  (only if qualityGate.fast set)
 *
 * Safety:
 *   - settings.json without `$navori.managed === true` is skipped (DT-2);
 *     the user must run `navori init --replace` to adopt.
 *   - Backup of every file that will be overwritten happens BEFORE any write.
 *   - Writes are atomic (temp + fsync + rename).
 *   - Shell hooks get +x.
 */

export interface ClaudeEngineResult {
  /** Files written this render (relative to cwd). */
  written: Array<{ path: string; status: RenderStatus }>;
  /** Files navori refused to touch with a human-readable reason. */
  skipped: Array<{ path: string; reason: string }>;
  /** Informational notes for the CLI to surface. */
  warnings: string[];
  /** Backup dir (or null if nothing changed and no backup was taken). */
  backupPath: string | null;
  /** Managed-block entries inside CLAUDE.md, for the existing reporter. */
  claudeMdEntries: AssetPlanEntry[];
  /** Version drift detected anywhere (used by `update` command). */
  updatesAvailable: UpdateAvailable[];
  /** CLAUDE.md assets that fell back to Spanish because language="en" lacks them. */
  languageFallbacks: string[];
}

const CORE_AGENTS: ReadonlyArray<{ id: string; harnessKey: keyof NonNullable<NavoriConfig["harness"]> }> = [
  { id: "leader", harnessKey: "leader" },
  { id: "implementer", harnessKey: "implementer" },
  { id: "reviewer", harnessKey: "reviewer" },
  { id: "researcher", harnessKey: "researcher" },
  { id: "ticket-audit", harnessKey: "ticketAudit" },
  { id: "commit-pr-pilot", harnessKey: "commitPrPilot" },
  { id: "explorer", harnessKey: "explorer" },
];

const CORE_SKILLS: ReadonlyArray<string> = ["verify-before-done", "loop-back-debug"];

const CORE_META = { source: "@navori/core" as const, version: readBundledCoreVersion() };

export function renderClaudeEngine(
  cwd: string,
  config: NavoriConfig,
  options: { dryRun?: boolean } = {},
): ClaudeEngineResult {
  const dryRun = options.dryRun === true;
  const skipped: Array<{ path: string; reason: string }> = [];
  const warnings: string[] = [];
  const pending: Array<{ path: string; content: string; status: RenderStatus; chmodExec?: boolean }> = [];

  // 1. CLAUDE.md — delegated to existing planner
  const claudeMdPath = join(cwd, "CLAUDE.md");
  const claudeMdExisting = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf-8") : "";
  const claudeMdPlan = computeRenderPlan(claudeMdExisting, config);
  if (claudeMdPlan.changed) {
    pending.push({
      path: claudeMdPath,
      content: claudeMdPlan.next,
      status: claudeMdExisting.length === 0 ? "created" : "updated",
    });
  }

  // 2. .claude/settings.json
  const settingsResult = planSettings(cwd, config);
  if (settingsResult.kind === "skip") {
    skipped.push({ path: relative(cwd, settingsResult.path), reason: settingsResult.reason });
  } else if (settingsResult.kind === "write") {
    pending.push({
      path: settingsResult.path,
      content: settingsResult.content,
      status: settingsResult.status,
    });
  }

  // 3. Agents
  for (const agent of CORE_AGENTS) {
    if (!isAgentEnabled(config, agent.harnessKey)) continue;
    applyManagedFilePlan(
      planManagedFile({
        cwd,
        assetRelPath: `agents/${agent.id}.md`,
        destRelPath: `.claude/agents/${agent.id}.md`,
        managedId: `${agent.id}-base`,
        config,
      }),
      cwd,
      pending,
      skipped,
    );
  }

  // 4. Skills (always on for now)
  for (const skillId of CORE_SKILLS) {
    applyManagedFilePlan(
      planManagedFile({
        cwd,
        assetRelPath: `skills/${skillId}.md`,
        destRelPath: `.claude/skills/${skillId}.md`,
        managedId: `${skillId}-base`,
        config,
      }),
      cwd,
      pending,
      skipped,
    );
  }

  // 5. progress/ bootstrap (one-shot, never overwritten)
  applyBootstrapPlan(
    planBootstrapFile({
      cwd,
      assetRelPath: "progress/current.md",
      destRelPath: `${config.progress?.dir ?? "progress"}/${config.progress?.currentFile ?? "current.md"}`,
      config,
    }),
    cwd,
    pending,
  );
  applyBootstrapPlan(
    planBootstrapFile({
      cwd,
      assetRelPath: "progress/history.md",
      destRelPath: `${config.progress?.dir ?? "progress"}/${config.progress?.historyFile ?? "history.md"}`,
      config,
    }),
    cwd,
    pending,
  );

  // 6. Hook quality-gate (only if config has a fast gate)
  if (config.qualityGate?.fast) {
    applyManagedFilePlan(
      planManagedFile({
        cwd,
        assetRelPath: `hooks/quality-gate-pre-commit.sh`,
        destRelPath: `.claude/hooks/quality-gate-pre-commit.sh`,
        managedId: "qg-pre-commit-base",
        config,
      }),
      cwd,
      pending,
      skipped,
      /* chmodExec */ true,
    );
  } else {
    warnings.push("quality-gate hook skipped: config.qualityGate.fast no está set");
  }

  // 6. Backup + atomic writes
  let backupPath: string | null = null;
  const written: Array<{ path: string; status: RenderStatus }> = [];

  if (pending.length === 0) {
    return {
      written,
      skipped,
      warnings,
      backupPath: null,
      claudeMdEntries: claudeMdPlan.entries,
      updatesAvailable: claudeMdPlan.updatesAvailable,
      languageFallbacks: claudeMdPlan.languageFallbacks,
    };
  }

  if (!dryRun) {
    // Backup the full pre-render state of files navori owns. Recursive over
    // .claude/ but skipping settings.local.json (per-user, gitignored) and
    // progress/ (live state, not the kind of thing a snapshot helps with).
    // The CLAUDE.md file is included explicitly; future engines will add
    // their own roots here.
    const hasExistingTarget = pending.some((p) => existsSync(p.path));
    if (hasExistingTarget) {
      const handle = createBackup(cwd, ["CLAUDE.md", ".claude"], {
        exclude: [".claude/settings.local.json", ".claude/progress"],
      });
      if (handle.files.length > 0) {
        backupPath = handle.path;
        purgeOldBackups();
      }
    }

    for (const p of pending) {
      mkdirSync(dirname(p.path), { recursive: true });
      writeFileAtomic(p.path, p.content);
      if (p.chmodExec) {
        try {
          chmodSync(p.path, 0o755);
        } catch {
          // best-effort; some filesystems (FAT) won't grant +x
        }
      }
      written.push({ path: relative(cwd, p.path), status: p.status });
    }
  } else {
    for (const p of pending) {
      written.push({ path: relative(cwd, p.path), status: p.status });
    }
  }

  return {
    written,
    skipped,
    warnings,
    backupPath,
    claudeMdEntries: claudeMdPlan.entries,
    updatesAvailable: claudeMdPlan.updatesAvailable,
    languageFallbacks: claudeMdPlan.languageFallbacks,
  };
}

// ─────────────────────────── helpers ───────────────────────────

function isAgentEnabled(
  config: NavoriConfig,
  key: keyof NonNullable<NavoriConfig["harness"]>,
): boolean {
  const h = config.harness;
  if (!h) return true; // default: render all agents
  return h[key] !== false;
}

type SettingsPlan =
  | { kind: "noop" }
  | { kind: "skip"; path: string; reason: string }
  | { kind: "write"; path: string; content: string; status: RenderStatus };

function planSettings(cwd: string, config: NavoriConfig): SettingsPlan {
  const path = join(cwd, ".claude/settings.json");
  const plugins = loadEnabledPlugins(config.plugins).loaded;
  const newSettings = buildClaudeSettings(config, plugins);
  const newJson = JSON.stringify(newSettings, null, 2) + "\n";

  if (!existsSync(path)) {
    return { kind: "write", path, content: newJson, status: "created" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    return {
      kind: "skip",
      path,
      reason: `settings.json no se pudo parsear como JSON: ${(err as Error).message}`,
    };
  }

  if (!isNavoriOwnedSettings(parsed)) {
    return {
      kind: "skip",
      path,
      reason: "settings.json existe sin `$navori.managed = true`. Corré 'navori init' en modo replace para adoptar.",
    };
  }

  const current = readFileSync(path, "utf-8");
  if (current === newJson) return { kind: "noop" };
  return { kind: "write", path, content: newJson, status: "updated" };
}

interface ManagedFilePlanInput {
  cwd: string;
  assetRelPath: string;     // relative to core-assets/
  destRelPath: string;      // relative to cwd
  managedId: string;
  config: NavoriConfig;
}

type ManagedFilePlan =
  | { kind: "noop" }
  | { kind: "skip"; path: string; reason: string }
  | { kind: "write"; path: string; content: string; status: RenderStatus };

function planManagedFile(input: ManagedFilePlanInput): ManagedFilePlan {
  const assetPath = resolve(getCoreRoot(), "core-assets", input.assetRelPath);
  const destPath = join(input.cwd, input.destRelPath);
  const existing = existsSync(destPath) ? readFileSync(destPath, "utf-8") : null;
  const result = renderManagedFile({
    assetPath,
    existingContent: existing,
    managedId: input.managedId,
    meta: CORE_META,
    config: input.config,
  });
  if (result.status === "unchanged") return { kind: "noop" };
  if (result.status === "user-modified-skipped") {
    return {
      kind: "skip",
      path: destPath,
      reason: "bloque managed editado por el usuario; resolvé con 'navori sync' o ajustá el destino a mano",
    };
  }
  return { kind: "write", path: destPath, content: result.content, status: result.status };
}

function applyManagedFilePlan(
  plan: ManagedFilePlan,
  cwd: string,
  pending: Array<{ path: string; content: string; status: RenderStatus; chmodExec?: boolean }>,
  skipped: Array<{ path: string; reason: string }>,
  chmodExec = false,
): void {
  if (plan.kind === "noop") return;
  if (plan.kind === "skip") {
    skipped.push({ path: relative(cwd, plan.path), reason: plan.reason });
    return;
  }
  pending.push({ path: plan.path, content: plan.content, status: plan.status, chmodExec });
}

interface BootstrapFilePlanInput {
  cwd: string;
  assetRelPath: string;     // relative to core-assets/
  destRelPath: string;      // relative to cwd
  config: NavoriConfig;
}

type BootstrapPlan =
  | { kind: "noop" }
  | { kind: "write"; path: string; content: string };

/**
 * Bootstrap a one-shot file: copy + interpolate ONCE if the destination
 * doesn't exist; never overwrite after. Used for progress/ files whose
 * content is live state owned by the user.
 */
function planBootstrapFile(input: BootstrapFilePlanInput): BootstrapPlan {
  const destPath = join(input.cwd, input.destRelPath);
  if (existsSync(destPath)) return { kind: "noop" };
  const assetPath = resolve(getCoreRoot(), "core-assets", input.assetRelPath);
  const raw = readFileSync(assetPath, "utf-8");
  return { kind: "write", path: destPath, content: interpolate(raw, input.config) };
}

function applyBootstrapPlan(
  plan: BootstrapPlan,
  _cwd: string,
  pending: Array<{ path: string; content: string; status: RenderStatus; chmodExec?: boolean }>,
): void {
  if (plan.kind === "noop") return;
  pending.push({ path: plan.path, content: plan.content, status: "created" });
}
