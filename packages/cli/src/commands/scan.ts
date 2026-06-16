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

    if (dryRun.kind === "no-config") {
      p.cancel(`No navori.config.json at ${dryRun.configPath}. Run 'navori init' first.`);
      process.exit(1);
    }
    if (dryRun.kind === "not-monorepo") {
      p.cancel(
        `${dryRun.configPath} does not declare 'monorepo'. ` +
          `Edit the config to add { monorepo: { enabled: true, tool: '...' } } and re-run scan.`,
      );
      process.exit(1);
    }
    if (dryRun.kind === "no-patterns") {
      p.log.info(
        `No workspace patterns found in pnpm-workspace.yaml or package.json#workspaces.`,
      );
      p.outro(dim("Nothing to scan"));
      return;
    }

    // dryRun.kind === "ok"
    showSummary(dryRun);

    if (dryRun.added.length === 0) {
      if (dryRun.orphan.length > 0) {
        p.log.warn(
          `${dryRun.orphan.length} workspace(s) in config no longer exist on disk. ` +
            `Edit navori.config.json to remove them.`,
        );
      }
      p.outro(dim("Config is up to date"));
      return;
    }

    let overrides: Record<string, string> = {};
    if (args.yes) {
      // Accept all suggestions as-is.
    } else {
      const ok = await p.confirm({
        message: `Add ${dryRun.added.length} workspace(s) to navori.config.json?`,
        initialValue: true,
      });
      if (p.isCancel(ok) || !ok) {
        p.cancel("Cancelled");
        return;
      }

      overrides = await collectPresetOverrides(dryRun.added);
    }

    const final = runScan({ cwd, yes: true, presetOverrides: overrides });
    if (final.kind !== "ok") {
      p.cancel(`Unexpected outcome: ${final.kind}`);
      process.exit(1);
    }

    p.log.success(
      `Added ${final.added.length} workspace(s) to ${final.configPath}`,
    );
    p.outro(dim("Run 'navori render' to generate per-workspace CLAUDE.md + .claude/"));
  },
});

function showSummary(outcome: Extract<ScanOutcome, { kind: "ok" }>): void {
  const rows: Array<[string, string]> = [];
  rows.push(["detected", String(outcome.added.length + outcome.existing.length)]);
  rows.push([
    "new",
    outcome.added.length > 0
      ? color.green(String(outcome.added.length))
      : dim("0"),
  ]);
  rows.push([
    "existing",
    outcome.existing.length > 0 ? String(outcome.existing.length) : dim("0"),
  ]);
  if (outcome.orphan.length > 0) {
    rows.push(["orphan", color.yellow(String(outcome.orphan.length))]);
  }
  p.note(kv(rows), "summary");

  if (outcome.added.length > 0) {
    const lines = outcome.diff.added
      .map((w) => {
        const fw = w.framework ? dim(` [${w.framework}]`) : "";
        return `  ${color.green("+")} ${w.path}${fw}  ${dim("→")} ${w.suggestedPreset}`;
      })
      .join("\n");
    p.log.message(`${dim("New workspaces:")}\n${lines}`);
  }

  if (outcome.orphan.length > 0) {
    const lines = outcome.orphan.map((w) => `  ${color.yellow("?")} ${w.path}`).join("\n");
    p.log.message(`${dim("Orphan (in config, missing on disk):")}\n${lines}`);
  }
}

async function collectPresetOverrides(
  added: MonorepoWorkspace[],
): Promise<Record<string, string>> {
  // Quick path: if user accepts all suggestions, no per-workspace prompt.
  const acceptAll = await p.confirm({
    message: `Use suggested preset for every new workspace?`,
    initialValue: true,
  });
  if (p.isCancel(acceptAll)) return {};
  if (acceptAll) return {};

  const overrides: Record<string, string> = {};
  for (const ws of added) {
    const value = await p.text({
      message: `Preset for ${ws.path}`,
      placeholder: ws.preset ?? "inherit-from-root",
      defaultValue: ws.preset ?? "",
    });
    if (p.isCancel(value)) return overrides;
    const trimmed = (value as string).trim();
    if (trimmed) overrides[ws.path] = trimmed;
  }
  return overrides;
}
