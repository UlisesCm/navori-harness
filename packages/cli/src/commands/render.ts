import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig } from "../lib/config.ts";
import { readConfigOrExit } from "../lib/cli-config.ts";
import type { AssetPlanEntry, UpdateAvailable } from "../lib/render-plan.ts";
import {
  renderClaudeEngine,
  type ClaudeEngineResult,
} from "../engines/claude/index.ts";
import { renderAgentsMdEngine } from "../engines/agents-md/index.ts";
import { renderStatusSymbol, renderStatusLabel, dim, color, brand, sym, type RenderStatus } from "../lib/style.ts";
import { effectiveConfigForWorkspace } from "../lib/monorepo.ts";
import { benchStart, benchMark, benchReport } from "../lib/bench.ts";

export interface WorkspaceRenderResult {
  /** Workspace path relative to the repo root (e.g. "apps/backend"). */
  workspacePath: string;
  /** Workspace display name from monorepo.workspaces[].name. */
  workspaceName: string;
  filePath: string;
  entries: AssetPlanEntry[];
  written: boolean;
  languageFallbacks: string[];
  updatesAvailable: UpdateAvailable[];
  backupPath?: string | null;
  engineResult: ClaudeEngineResult;
}

/**
 * Per-engine summary for non-Claude engines declared in `config.engines[]`.
 * The Claude engine keeps its rich reporting (entries, workspaces); the others
 * report a flat file list. Engines with no adapter yet surface a warning so the
 * declaration is never silently ignored.
 */
export interface EngineRenderSummary {
  engine: string;
  written: Array<{ path: string; status: RenderStatus }>;
  skipped: Array<{ path: string; reason: string }>;
  warnings: string[];
  backupPath: string | null;
}

/** Dispatch the non-Claude engines declared in config.engines[]. */
function renderNonClaudeEngines(
  cwd: string,
  config: ReturnType<typeof readConfig>,
  engines: readonly string[],
  dryRun: boolean,
): EngineRenderSummary[] {
  const out: EngineRenderSummary[] = [];
  for (const eng of engines) {
    if (eng === "claude") continue;
    if (eng === "agents-md") {
      const r = renderAgentsMdEngine(cwd, config, { dryRun, repoRoot: cwd });
      out.push({ engine: eng, ...r });
    } else {
      // cursor / copilot: declared but no adapter yet — warn, never ignore.
      out.push({
        engine: eng,
        written: [],
        skipped: [],
        warnings: [`El engine '${eng}' todavía no tiene adapter en navori; se omitió.`],
        backupPath: null,
      });
    }
  }
  return out;
}

export interface RunRenderOptions {
  dryRun?: boolean;
  force?: boolean;
  /**
   * When set, skip the root render and only render the workspace whose name
   * matches. Returns `ok: false` with a clear reason if no monorepo is
   * declared or no workspace by that name exists. Spec 0001 fase 4.
   */
  workspaceFilter?: string | null;
}

/**
 * Run the render flow against `cwd`. Reusable from other commands (e.g. init).
 * The top-level fields always describe the repo root render so existing callers
 * (init.ts) keep working unchanged. When `config.monorepo.workspaces[]` is
 * non-empty, each workspace is also rendered and reported under `workspaces`.
 *
 * With `workspaceFilter`, only that workspace is rendered — root is skipped,
 * `engineResult` is undefined, and the top-level fields are empty stubs. This
 * is the "iterate one app" path for monorepos.
 */
export function runRender(
  cwd: string,
  dryRunOrOptions: boolean | RunRenderOptions = false,
  force = false,
): {
  ok: boolean;
  reason?: string;
  filePath: string;
  entries: AssetPlanEntry[];
  written: boolean;
  languageFallbacks: string[];
  updatesAvailable: UpdateAvailable[];
  backupPath?: string | null;
  engineResult?: ClaudeEngineResult;
  workspaces: WorkspaceRenderResult[];
  /** Declared workspaces whose directory no longer exists on disk (#70). */
  orphanedWorkspaces?: string[];
  /** Non-Claude engines (agents-md, plus warnings for cursor/copilot). */
  extraEngines?: EngineRenderSummary[];
} {
  // Back-compat: callers passing (cwd, dryRun, force) keep working.
  const opts: RunRenderOptions =
    typeof dryRunOrOptions === "boolean"
      ? { dryRun: dryRunOrOptions, force }
      : dryRunOrOptions;
  const dryRun = Boolean(opts.dryRun);
  const forceFlag = Boolean(opts.force);
  const workspaceFilter = opts.workspaceFilter ?? null;

  const configPath = `${cwd}/navori.config.json`;
  const claudeMdPath = `${cwd}/CLAUDE.md`;

  if (!existsSync(configPath)) {
    return {
      ok: false,
      reason: `No navori.config.json at ${configPath}`,
      filePath: claudeMdPath,
      entries: [],
      written: false,
      languageFallbacks: [],
      updatesAvailable: [],
      backupPath: null,
      workspaces: [],
    };
  }

  const config = readConfigOrExit(configPath);
  benchMark("loadConfig");

  // --workspace filter path: skip root, render only the matching workspace.
  if (workspaceFilter) {
    const declared = config.monorepo?.workspaces ?? [];
    if (declared.length === 0) {
      return {
        ok: false,
        reason: `--workspace requires a monorepo with declared workspaces; this config has none. Run 'navori scan' first.`,
        filePath: claudeMdPath,
        entries: [],
        written: false,
        languageFallbacks: [],
        updatesAvailable: [],
        backupPath: null,
        workspaces: [],
      };
    }
    const match = declared.find((w) => w.name === workspaceFilter);
    if (!match) {
      const known = declared.map((w) => w.name).join(", ");
      return {
        ok: false,
        reason: `Workspace '${workspaceFilter}' not found. Known: ${known}`,
        filePath: claudeMdPath,
        entries: [],
        written: false,
        languageFallbacks: [],
        updatesAvailable: [],
        backupPath: null,
        workspaces: [],
      };
    }
    const wsCwd = resolve(cwd, match.path);
    const wsConfig = effectiveConfigForWorkspace(config, match);
    const wsResult = renderClaudeEngine(wsCwd, wsConfig, {
      dryRun,
      force: forceFlag,
      repoRoot: cwd,
    });
    return {
      ok: true,
      filePath: claudeMdPath,
      entries: [],
      written: false,
      languageFallbacks: [],
      updatesAvailable: [],
      backupPath: null,
      engineResult: undefined,
      workspaces: [
        {
          workspacePath: match.path,
          workspaceName: match.name,
          filePath: `${wsCwd}/CLAUDE.md`,
          entries: wsResult.claudeMdEntries,
          written: wsResult.written.length > 0,
          languageFallbacks: wsResult.languageFallbacks,
          updatesAvailable: wsResult.updatesAvailable,
          backupPath: wsResult.backupPath,
          engineResult: wsResult,
        },
      ],
    };
  }

  // Engine dispatch: render Claude only when it's a declared engine (the
  // default). Before this, render hardcoded Claude and silently ignored any
  // other engines[]. Now non-Claude engines are dispatched too.
  const engines: readonly string[] = config.engines ?? ["claude"];
  const renderClaude = engines.includes("claude");

  const engineResult = renderClaude
    ? renderClaudeEngine(cwd, config, { dryRun, force: forceFlag })
    : undefined;

  const workspaces: WorkspaceRenderResult[] = [];
  const orphanedWorkspaces: string[] = [];
  if (renderClaude) {
    for (const ws of config.monorepo?.workspaces ?? []) {
      const wsCwd = resolve(cwd, ws.path);
      // #70: a workspace deleted from disk (or removed from the workspace glob)
      // but still declared in config must NOT be resurrected — renderClaudeEngine
      // would mkdir it and write a full .claude/ tree into a dir that shouldn't
      // exist. Skip + surface it so the user prunes config (mirrors the guard in
      // the cross-repo workspace render).
      if (!existsSync(wsCwd)) {
        orphanedWorkspaces.push(ws.path);
        continue;
      }
      const wsConfig = effectiveConfigForWorkspace(config, ws);
      const wsResult = renderClaudeEngine(wsCwd, wsConfig, {
        dryRun,
        force: forceFlag,
        repoRoot: cwd,
      });
      workspaces.push({
        workspacePath: ws.path,
        workspaceName: ws.name,
        filePath: `${wsCwd}/CLAUDE.md`,
        entries: wsResult.claudeMdEntries,
        written: wsResult.written.length > 0,
        languageFallbacks: wsResult.languageFallbacks,
        updatesAvailable: wsResult.updatesAvailable,
        backupPath: wsResult.backupPath,
        engineResult: wsResult,
      });
    }
  }

  const extraEngines = renderNonClaudeEngines(cwd, config, engines, dryRun);

  return {
    ok: true,
    filePath: claudeMdPath,
    entries: engineResult?.claudeMdEntries ?? [],
    written: (engineResult?.written.length ?? 0) > 0,
    languageFallbacks: engineResult?.languageFallbacks ?? [],
    updatesAvailable: engineResult?.updatesAvailable ?? [],
    backupPath: engineResult?.backupPath ?? null,
    engineResult,
    workspaces,
    orphanedWorkspaces,
    extraEngines,
  };
}

export const renderCommand = defineCommand({
  meta: {
    name: "render",
    description: "Render managed Core blocks into CLAUDE.md + .claude/ from navori.config.json",
  },
  args: {
    cwd: { type: "string", description: "Directory to render into (default: cwd)" },
    apply: {
      type: "boolean",
      description: "Write changes to disk. Without it, render only previews (no files touched).",
    },
    "dry-run": {
      type: "boolean",
      description: "Deprecated: preview is the default now. Kept as an explicit alias for --no-apply.",
    },
    force: {
      type: "boolean",
      description:
        "Regenerate settings.json even if corrupted or missing the $navori marker. The previous file is backed up.",
    },
    workspace: {
      type: "string",
      description:
        "Render only one workspace by name (skips root). Requires a monorepo config with declared workspaces.",
    },
  },
  async run({ args }) {
    benchStart();
    const cwd = resolve(args.cwd ?? process.cwd());

    p.intro(brand("render"));

    if (!existsSync(cwd)) {
      p.cancel(`Directory not found: ${cwd}`);
      process.exit(1);
    }

    // Preview-default (spec 0003 §3.1.3, breaking change v0.1→v0.2): render
    // never touches disk unless --apply is passed. --dry-run is kept as a
    // back-compat alias; when combined with --apply, preview wins (safer).
    const apply = Boolean(args.apply);
    const preview = !apply || Boolean(args["dry-run"]);

    const workspaceFilter = (args.workspace as string | undefined) ?? null;
    const result = runRender(cwd, {
      dryRun: preview,
      force: Boolean(args.force),
      workspaceFilter,
    });
    if (!result.ok) {
      // Workspace errors are user-recoverable (typo in name, no monorepo yet);
      // 'navori init' is not always the right fix, so emit the raw reason.
      p.cancel(result.reason ?? "Render failed");
      process.exit(1);
    }

    const hasWorkspaces = result.workspaces.length > 0;
    if (hasWorkspaces && result.engineResult) {
      p.log.message(`${dim("root")}`);
    }
    if (result.engineResult) {
      reportClaudeMd(result.filePath, result.entries, result.written, preview);
      reportEngineFiles(result.engineResult);
    }
    if (result.languageFallbacks.length > 0) {
      p.log.warn(
        `Language fallback to Spanish for: ${result.languageFallbacks.join(", ")} (English version not available yet)`,
      );
    }
    if (result.backupPath) {
      p.log.message(`${dim("Backup:")} ${result.backupPath}`);
    }

    for (const ws of result.workspaces) {
      p.log.message(`${dim("workspace")} ${color.cyan(ws.workspaceName)} ${dim(`(${ws.workspacePath})`)}`);
      reportClaudeMd(ws.filePath, ws.entries, ws.written, preview);
      reportEngineFiles(ws.engineResult);
      if (ws.languageFallbacks.length > 0) {
        p.log.warn(
          `[${ws.workspaceName}] Language fallback to Spanish for: ${ws.languageFallbacks.join(", ")} (English version not available yet)`,
        );
      }
      if (ws.backupPath) {
        p.log.message(`${dim("Backup:")} ${ws.backupPath}`);
      }
    }

    if (result.orphanedWorkspaces && result.orphanedWorkspaces.length > 0) {
      p.log.warn(
        `Workspaces declarados en config pero ausentes en disco (${result.orphanedWorkspaces.length}) — ` +
          `no se renderizaron (evita resucitar dirs borrados). Corré 'navori scan' o quitá del config:\n` +
          result.orphanedWorkspaces.map((w) => `  ${color.yellow(sym.update)} ${w}`).join("\n"),
      );
    }

    for (const ee of result.extraEngines ?? []) {
      p.log.message(`${dim("engine")} ${color.cyan(ee.engine)}`);
      for (const w of ee.written) {
        p.log.message(`  ${renderStatusSymbol(w.status)} ${w.path}  ${dim("(")}${renderStatusLabel(w.status)}${dim(")")}`);
      }
      for (const s of ee.skipped) p.log.warn(`  ${s.path}: ${s.reason}`);
      for (const warn of ee.warnings) p.log.warn(`  ${warn}`);
      if (ee.backupPath) p.log.message(`  ${dim("Backup:")} ${ee.backupPath}`);
    }

    const allEntries = result.entries.concat(...result.workspaces.map((w) => w.entries));
    // In preview mode `written` means "would write" — the engine populates it
    // with pending changes without touching disk.
    const anyPending =
      result.written ||
      result.workspaces.some((w) => w.written) ||
      (result.extraEngines ?? []).some((e) => e.written.length > 0);
    const summary = summarize(allEntries);
    if (preview) {
      if (anyPending) {
        p.outro(`${color.yellow("Preview")} ${summary} ${dim("· corre 'navori render --apply' para escribir")}`);
      } else {
        p.outro(`${dim("Up to date")} ${summary} ${dim("· nada que aplicar")}`);
      }
    } else if (anyPending) {
      p.outro(`${color.green("Done")} ${summary}`);
    } else {
      p.outro(`${dim("Up to date")} ${summary}`);
    }

    benchReport();
  },
});

function summarize(entries: AssetPlanEntry[]): string {
  const counts = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1;
    return acc;
  }, {});
  const parts: string[] = [];
  if (counts.created) parts.push(color.green(`${counts.created} created`));
  if (counts.updated) parts.push(color.yellow(`${counts.updated} updated`));
  if (counts["user-modified-skipped"]) parts.push(color.red(`${counts["user-modified-skipped"]} conflict`));
  if (counts["removed-condition-false"]) parts.push(color.magenta(`${counts["removed-condition-false"]} removed`));
  if (counts.unchanged) parts.push(dim(`${counts.unchanged} unchanged`));
  return parts.length > 0 ? `${dim("—")} ${parts.join(dim(", "))}` : "";
}

function reportClaudeMd(file: string, entries: AssetPlanEntry[], changed: boolean, preview: boolean): void {
  const lines: string[] = [file];
  for (const e of entries) {
    const sym = renderStatusSymbol(e.status);
    const label = renderStatusLabel(e.status);
    lines.push(`  ${sym} ${e.asset.id}  ${dim("(")}${label}${dim(")")}`);
  }
  if (preview) lines.push(`  ${dim(changed ? "→ preview (se escribiría)" : "→ sin cambios")}`);
  else if (changed) lines.push(`  ${dim("→ written")}`);
  else lines.push(`  ${dim("→ no changes")}`);
  p.log.message(lines.join("\n"));
}

function reportEngineFiles(engine: ClaudeEngineResult): void {
  // CLAUDE.md is reported separately by reportClaudeMd; filter it out here.
  // Header used to say ".claude/" which was misleading — progress/ also lands
  // here. "Engine files" describes the union (settings, agents, skills, hooks,
  // progress).
  const written = engine.written.filter((w) => w.path !== "CLAUDE.md");
  const unchangedCount = Math.max(
    0,
    engine.inspected - engine.written.length - engine.skipped.length,
  );

  if (
    written.length === 0 &&
    engine.skipped.length === 0 &&
    engine.warnings.length === 0 &&
    unchangedCount === 0
  ) {
    return;
  }

  const lines: string[] = ["Engine files:"];
  for (const w of written) {
    const sym = renderStatusSymbol(w.status);
    const label = renderStatusLabel(w.status);
    lines.push(`  ${sym} ${w.path}  ${dim("(")}${label}${dim(")")}`);
  }
  for (const s of engine.skipped) {
    lines.push(`  ${color.yellow("!")} ${s.path}  ${dim("(")}${color.yellow("skipped")}${dim(")")}`);
    lines.push(`      ${dim(s.reason)}`);
  }
  if (unchangedCount > 0 && written.length === 0 && engine.skipped.length === 0) {
    // All inspected files were already up to date — give the user a positive
    // signal so they don't wonder whether the engine even ran.
    lines.push(`  ${dim(`· ${unchangedCount} unchanged`)}`);
  } else if (unchangedCount > 0) {
    lines.push(`  ${dim(`· (+${unchangedCount} unchanged)`)}`);
  }
  for (const w of engine.warnings) {
    lines.push(`  ${color.yellow("·")} ${dim(w)}`);
  }
  p.log.message(lines.join("\n"));
}
