import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { readConfig, writeConfig, type NavoriConfig } from "../lib/config.ts";
import {
  scanMonorepoWorkspaces,
  diffWorkspaces,
  type DetectedWorkspace,
  type ScanDiff,
} from "../lib/scan.ts";
import type { MonorepoWorkspace } from "../lib/monorepo.ts";
import { brand, dim, color, kv } from "../lib/style.ts";
import { tc, resolveLang, DEFAULT_LANG } from "../lib/i18n.ts";

export type ScanOutcome =
  | { kind: "no-config"; configPath: string }
  | { kind: "not-monorepo"; configPath: string }
  | { kind: "no-patterns"; configPath: string }
  | {
      kind: "ok";
      configPath: string;
      added: MonorepoWorkspace[];
      existing: MonorepoWorkspace[];
      orphan: MonorepoWorkspace[];
      diff: ScanDiff;
      wrote: boolean;
    };

export interface RunScanOptions {
  cwd: string;
  /** Accept suggested preset for every new workspace and write without prompting. */
  yes: boolean;
  /** Preset override per new workspace path (set by the interactive wrapper). */
  presetOverrides?: Record<string, string>;
}

/**
 * Pure-ish core of `navori scan` — no prompts, no clack output. The interactive
 * wrapper calls it once with `yes: false` to collect the diff (for display),
 * then again with `yes: true` and resolved presets to actually write. Tests
 * exercise this directly with `yes: true`.
 */
export function runScan(opts: RunScanOptions): ScanOutcome {
  const configPath = resolve(opts.cwd, "navori.config.json");
  if (!existsSync(configPath)) {
    return { kind: "no-config", configPath };
  }

  const config = readConfig(configPath);
  if (!config.monorepo) {
    return { kind: "not-monorepo", configPath };
  }

  const detected = scanMonorepoWorkspaces(opts.cwd);
  if (detected.length === 0) {
    return { kind: "no-patterns", configPath };
  }

  const configured = config.monorepo.workspaces ?? [];
  const diff = diffWorkspaces(detected, configured);

  const overrides = opts.presetOverrides ?? {};
  const added: MonorepoWorkspace[] = diff.added.map((d) =>
    buildMonorepoWorkspace(d, overrides[d.path] ?? d.suggestedPreset, config),
  );

  let wrote = false;
  if (opts.yes && added.length > 0) {
    const next: NavoriConfig = {
      ...config,
      monorepo: {
        ...config.monorepo,
        workspaces: [...configured, ...added],
      },
    };
    writeConfig(configPath, next);
    wrote = true;
  }

  return {
    kind: "ok",
    configPath,
    added,
    existing: diff.existing,
    orphan: diff.orphan,
    diff,
    wrote,
  };
}

/**
 * Build a MonorepoWorkspace entry from a detected workspace. Only writes
 * `preset` when it differs from the root preset — that way the workspace
 * inherits the root by default and the config stays minimal.
 */
function buildMonorepoWorkspace(
  detected: DetectedWorkspace,
  preset: string,
  config: NavoriConfig,
): MonorepoWorkspace {
  const entry: MonorepoWorkspace = { name: detected.name, path: detected.path };
  if (preset && preset !== config.preset) {
    entry.preset = preset;
  }
  // Carry the workspace's own library skills + migrations so a workspace added
  // via `scan` is scoped like one added via `init` (otherwise its skills would
  // silently never materialize). Mirrors init.ts buildWorkspaceEntry.
  if (detected.libraries.length > 0) {
    entry.libraries = detected.libraries;
  }
  if (detected.migrations.length > 0) {
    entry.libraryMigrations = detected.migrations;
  }
  return entry;
}

export const scanCommand = defineCommand({
  meta: {
    name: "scan",
    description: "Re-detect workspaces in a monorepo and add new ones to navori.config.json",
  },
  args: {
    cwd: {
      type: "string",
      description: "Directory to scan (default: current working directory)",
    },
    yes: {
      type: "boolean",
      description: "Accept suggested presets for every new workspace without prompting",
    },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    p.intro(brand("scan"));

    const dryRun = runScan({ cwd, yes: false });
    // No config → no language to read; fall back to DEFAULT_LANG. Otherwise the
    // config that runScan just read governs the locale.
    const lang =
      dryRun.kind === "no-config"
        ? DEFAULT_LANG
        : resolveLang(readConfig(dryRun.configPath).language);
    const ts = tc(lang).scan;

    if (dryRun.kind === "no-config") {
      p.cancel(ts.noConfig(dryRun.configPath));
      process.exit(1);
    }
    if (dryRun.kind === "not-monorepo") {
      p.cancel(ts.notMonorepo(dryRun.configPath));
      process.exit(1);
    }
    if (dryRun.kind === "no-patterns") {
      p.log.info(ts.noPatterns);
      p.outro(dim(ts.nothingToScan));
      return;
    }

    // dryRun.kind === "ok"
    showSummary(dryRun, ts);

    if (dryRun.added.length === 0) {
      if (dryRun.orphan.length > 0) {
        p.log.warn(ts.orphaned(dryRun.orphan.length));
      }
      p.outro(dim(ts.configCurrent));
      return;
    }

    let overrides: Record<string, string> = {};
    if (args.yes) {
      // Accept every suggestion.
    } else {
      const ok = await p.confirm({
        message: ts.addWorkspaces(dryRun.added.length),
        initialValue: true,
      });
      if (p.isCancel(ok) || !ok) {
        p.cancel(ts.cancelled);
        return;
      }

      overrides = await collectPresetOverrides(dryRun.added, ts);
    }

    const final = runScan({ cwd, yes: true, presetOverrides: overrides });
    if (final.kind !== "ok") {
      p.cancel(ts.unexpectedResult(final.kind));
      process.exit(1);
    }

    p.log.success(ts.added(final.added.length, final.configPath));
    p.outro(dim(ts.renderHint));
  },
});

function showSummary(
  outcome: Extract<ScanOutcome, { kind: "ok" }>,
  ts: ReturnType<typeof tc>["scan"],
): void {
  const rows: Array<[string, string]> = [];
  rows.push(["detected", String(outcome.added.length + outcome.existing.length)]);
  rows.push([
    "new",
    outcome.added.length > 0 ? color.green(String(outcome.added.length)) : dim("0"),
  ]);
  rows.push(["existing", outcome.existing.length > 0 ? String(outcome.existing.length) : dim("0")]);
  if (outcome.orphan.length > 0) {
    rows.push(["orphan", color.yellow(String(outcome.orphan.length))]);
  }
  p.note(kv(rows), ts.summaryTitle);

  if (outcome.added.length > 0) {
    const lines = outcome.diff.added
      .map((w) => {
        const fw = w.framework ? dim(` [${w.framework}]`) : "";
        return `  ${color.green("+")} ${w.path}${fw}  ${dim("→")} ${w.suggestedPreset}`;
      })
      .join("\n");
    p.log.message(`${dim(ts.newWorkspacesTitle)}\n${lines}`);
  }

  if (outcome.orphan.length > 0) {
    const lines = outcome.orphan.map((w) => `  ${color.yellow("?")} ${w.path}`).join("\n");
    p.log.message(`${dim(ts.orphanedTitle)}\n${lines}`);
  }
}

async function collectPresetOverrides(
  added: MonorepoWorkspace[],
  ts: ReturnType<typeof tc>["scan"],
): Promise<Record<string, string>> {
  const acceptAll = await p.confirm({
    message: ts.useSuggestedPresets,
    initialValue: true,
  });
  if (p.isCancel(acceptAll)) return {};
  if (acceptAll) return {};

  const overrides: Record<string, string> = {};
  for (const ws of added) {
    const value = await p.text({
      message: ts.presetFor(ws.path),
      placeholder: ws.preset ?? ts.inheritRoot,
      defaultValue: ws.preset ?? "",
    });
    if (p.isCancel(value)) return overrides;
    const trimmed = (value as string).trim();
    if (trimmed) overrides[ws.path] = trimmed;
  }
  return overrides;
}
